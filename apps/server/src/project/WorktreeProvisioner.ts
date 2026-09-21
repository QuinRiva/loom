import {
  CommandId,
  EventId,
  type GitCommandError,
  type OrchestrationCommand,
  type ProjectId,
  type ThreadId,
  type WorktreeSetupSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as PlatformError from "effect/PlatformError";

import type { OrchestrationDispatchError } from "../orchestration/Errors.ts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import { GIT_LOCK_RETRY } from "../git/gitLockRetry.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { WorktreeMutationLock } from "../git/WorktreeMutationLock.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";
import { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";
import { WorkspaceLease, type WorkspaceHold } from "../workspace/WorkspaceOccupancyLease.ts";
import { WorktreeSetupTracker } from "./WorktreeSetupTracker.ts";
import { worktreeSetupActivityCommand } from "./worktreeSetupRecord.loom.ts";

/**
 * WorktreeProvisioner — the workstream dispatcher's provisioning path
 * (worktree-isolation plan §2). It owns: create the child's worktree, repoint
 * the thread's `branch`/`worktreePath`, refresh git status, and fire the setup
 * script (non-blocking, behind the `t3code-setup-state.json` breadcrumb).
 *
 * The whole sequence runs as an interruptible fibre registered with
 * {@link WorktreeSetupTracker} under the CHILD's thread id, and its running /
 * terminal state is persisted as the `worktree-setup` activity on the child —
 * the same contract the root bootstrap in `ws.ts` writes. That is what gives a
 * dispatcher-spawned child the setup card (live, and after a reload) and a
 * Cancel button that actually stops the provisioning.
 */

export interface ProvisionWorktreeResult {
  readonly worktreePath: string;
  readonly branch: string;
}

/** A human cancelled the provisioning through `worktreeSetup.cancel`. */
export class WorktreeProvisionCancelled extends Data.TaggedError("WorktreeProvisionCancelled")<{
  readonly threadId: ThreadId;
}> {}

export interface ProvisionIsolatedChildInput {
  readonly threadId: ThreadId;
  readonly role: string;
  readonly projectId?: ProjectId;
  /** The parent worktree cwd (where the goal's current, possibly dirty state lives). */
  readonly parentCwd: string;
  /** The parent branch the child branches from and later fans back into. */
  readonly parentBranch: string;
}

// Provisioning surfaces git + command-dispatch failures to the caller (both
// callers wrap the call in a catch); setup + activity + status side effects are
// swallowed internally.
type ProvisionError =
  | GitCommandError
  | OrchestrationDispatchError
  | PlatformError.PlatformError
  | WorktreeProvisionCancelled;

export class WorktreeProvisioner extends Context.Service<
  WorktreeProvisioner,
  {
    readonly provisionIsolatedChild: (
      input: ProvisionIsolatedChildInput,
    ) => Effect.Effect<ProvisionWorktreeResult, ProvisionError>;
    // Turn-start invariant (item 4): (re)provision an isolated child's worktree
    // before any turn starts against it, parking it (needs_guidance) on failure.
    // Idempotent — an already-provisioned (`ws/…`) or worktree-less child is a
    // no-op success. Never fails: a provisioning error is absorbed into the park
    // and reported as `false` so the caller skips the turn.
    readonly ensureIsolatedChildProvisioned: (input: {
      readonly threadId: ThreadId;
      readonly role: string;
      readonly projectId?: ProjectId;
      readonly branch: string | null;
      readonly worktreePath: string | null;
    }) => Effect.Effect<boolean>;
    // Was this child parked by a provisioning failure in THIS process? The
    // restart-safe signal is the thread's own branch (see the reactor guard);
    // this in-memory marker only drives the promote-loop skip and the
    // provisioning-specific wake copy, and is lost (harmlessly) on restart.
    readonly hasPendingProvisionFailure: (threadId: ThreadId) => boolean;
  }
>()("t3/project/WorktreeProvisioner") {}

// `ws/<parentBranch>/<sanitisedRole>-<first8(threadId)>` (plan §2). The `ws/`
// prefix namespaces workstream-managed branches; the thread-id suffix makes a
// same-branch-in-two-worktrees collision unreachable. Nested `ws/ws/…` for a
// grandchild is harmless and still matches the `ws/` prefix test.
export const workstreamChildBranchName = (
  parentBranch: string,
  role: string,
  threadId: string,
): string => {
  const sanitisedRole = role
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `ws/${parentBranch}/${sanitisedRole || "child"}-${threadId.slice(0, 8)}`;
};

// Idempotence guard (review nice-to-have): a `ws/…-<first8(threadId)>` branch
// already carried by the thread means it was provisioned on a prior pass (a
// crash between the provisioner's meta.update and the kickoff turn.start).
// Re-provisioning would branch `ws/ws/…` off the child's own branch and orphan
// a worktree, so the dispatcher skips provisioning when this holds.
export const isProvisionedChildBranch = (branch: string | null, threadId: string): boolean =>
  branch !== null && branch.startsWith("ws/") && branch.endsWith(`-${threadId.slice(0, 8)}`);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * How long a freshly provisioned worktree is held before the provider launch is
 * expected to have taken its own hold. Generous relative to provision → setup →
 * launch (seconds), and bounded so the hold can never leak.
 */
export const FRESH_WORKTREE_HOLD = Duration.minutes(5);

// Normalise a setup-runner failure to a human detail, preserving the pre-refactor
// behaviour: an operation error unwraps its `cause.message` (Error or plain
// object) and falls back to a stringified cause; a project-not-found error gets
// a fixed message.
const describeSetupFailure = (
  error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError,
): string => {
  if (error._tag === "ProjectSetupScriptProjectNotFoundError") {
    return "Project was not found for setup script execution.";
  }
  const cause: unknown = error.cause;
  return typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof (cause as { message: unknown }).message === "string"
    ? (cause as { message: string }).message
    : String(cause);
};

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const gitWorkflow = yield* GitWorkflowService;
  const worktreeMutationLock = yield* WorktreeMutationLock;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const setupRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const workspaceLease = yield* WorkspaceLease;
  const setupTracker = yield* WorktreeSetupTracker;

  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => CommandId.make(`server:worktree-provisioner:${tag}:${uuid}`)),
    );

  // Provisioning failures — and cancellations — are surfaced once per process
  // (activity + needs_guidance flag, or the cancelled setup card) then
  // remembered so the dispatcher's promote loop does not re-spin straight back
  // into the same git error or into the provisioning a human just stopped. The
  // reactor's turn-start guard retries regardless (a prompt means "retry
  // provisioning"); on success the marker is cleared. A restart drops the set
  // and retries once.
  const failedProvisions = new Set<ThreadId>();

  const appendActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind: string;
    readonly summary: string;
    readonly createdAt: string;
    readonly payload: Record<string, unknown>;
    readonly tone: "info" | "error";
  }) =>
    Effect.gen(function* () {
      const commandId = yield* serverCommandId("setup-activity");
      const activityId = EventId.make(yield* crypto.randomUUIDv4);
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId,
        threadId: input.threadId,
        activity: {
          id: activityId,
          tone: input.tone,
          kind: input.kind,
          summary: input.summary,
          payload: input.payload,
          turnId: null,
          createdAt: input.createdAt,
        },
        createdAt: input.createdAt,
      } satisfies OrchestrationCommand);
    }).pipe(Effect.ignoreCause({ log: true }));

  const refreshGitStatus = (cwd: string) =>
    vcsStatusBroadcaster
      .refreshStatus(cwd)
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

  // Hold the tree we just cut (plan §7.1). The hold is taken the moment git
  // registers the directory — before the (possibly long) submodule checkout —
  // so no fan-in/reaper pass can decide a half-built tree is removable, and it
  // is released immediately when provisioning is cancelled or fails (nothing
  // is using the tree then). On success it is released on a timer rather than
  // by a handover, because a hold whose release depends on a launch that may
  // never come is a permanently immortal worktree. After the window the
  // ordinary predicates apply again (a just-provisioned child is non-terminal
  // with an unsettled fan-in, so no remover targets it anyway); this is belt,
  // not the structural guarantee.
  const releaseHoldAfterWindow = (hold: WorkspaceHold) =>
    Effect.forkDetach(Effect.andThen(Effect.sleep(FRESH_WORKTREE_HOLD), hold.release)).pipe(
      Effect.asVoid,
    );

  // The durable record of the child's setup, upserted under a fixed id so a
  // reload, a second client or a restarted server renders the card from the
  // projection rather than the memory-only tracker. Best effort: a child
  // deleted mid-provision has no thread left to append to.
  const recordSetup = (snapshot: WorktreeSetupSnapshot) =>
    serverCommandId("worktree-setup-activity").pipe(
      Effect.flatMap((commandId) =>
        orchestrationEngine.dispatch(worktreeSetupActivityCommand(commandId, snapshot)),
      ),
      Effect.ignoreCause({ log: true }),
    );

  const settleSetup = (
    threadId: ThreadId,
    phase: "done" | "failed" | "cancelled",
    error?: string,
  ) =>
    setupTracker
      .finish(threadId, phase, error ?? null)
      .pipe(Effect.flatMap((snapshot) => (snapshot ? recordSetup(snapshot) : Effect.void)));

  // Fire-and-forget setup (plan §2): the provider turn starts without waiting
  // for the script, and the card's `setup-script` stage (plus the
  // `t3code-setup-state.json` breadcrumb) carries its status. Setup failure
  // follows the existing policy — the child sees `failed` and reports; no new
  // escalation machinery. Returns the started script so the caller can settle
  // the card when it exits, or null when nothing is running.
  const startSetupScript = Effect.fn("WorktreeProvisioner.startSetupScript")(function* (input: {
    readonly threadId: ThreadId;
    readonly projectId?: ProjectId;
    readonly projectCwd: string;
    readonly worktreePath: string;
  }) {
    const threadId = input.threadId;
    const requestedAt = yield* nowIso;
    yield* setupTracker.stageStatus(threadId, "setup-script", "running");
    return yield* setupRunner
      .runForThread({
        threadId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        projectCwd: input.projectCwd,
        worktreePath: input.worktreePath,
        observeCompletion: {
          onOutputLine: (line) => setupTracker.appendTail(threadId, "setup-script", line),
        },
      })
      .pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            appendActivity({
              threadId,
              kind: "setup-script.failed",
              summary: "Setup script failed",
              createdAt: requestedAt,
              payload: { detail: describeSetupFailure(error), worktreePath: input.worktreePath },
              tone: "error",
            }).pipe(
              Effect.andThen(
                setupTracker.stageStatus(threadId, "setup-script", "failed", "failed to start"),
              ),
              Effect.as(null),
            ),
          onSuccess: (result) => {
            if (result.status !== "started") {
              return setupTracker
                .stageStatus(threadId, "setup-script", "skipped", "no setup script")
                .pipe(Effect.as(null));
            }
            const payload = {
              worktreePath: input.worktreePath,
              scriptId: result.scriptId,
              scriptName: result.scriptName,
              terminalId: result.terminalId,
            };
            return Effect.gen(function* () {
              yield* appendActivity({
                threadId,
                kind: "setup-script.requested",
                summary: "Starting setup script",
                createdAt: requestedAt,
                payload,
                tone: "info",
              });
              yield* appendActivity({
                threadId,
                kind: "setup-script.started",
                summary: "Setup script started",
                createdAt: yield* nowIso,
                payload,
                tone: "info",
              });
              yield* setupTracker.update(threadId, (snapshot) => ({
                ...snapshot,
                setupScript: {
                  name: result.scriptName,
                  command: result.scriptCommand,
                  terminalId: result.terminalId,
                },
              }));
              return result;
            });
          },
        }),
      );
  });

  const provisionIsolatedChild = Effect.fn("WorktreeProvisioner.provisionIsolatedChild")(function* (
    input: ProvisionIsolatedChildInput,
  ) {
    const threadId = input.threadId;
    const branch = workstreamChildBranchName(input.parentBranch, input.role, input.threadId);
    // Rollback state a cancel needs: the tree git registered and our hold on it.
    let claimedPath: string | null = null;
    let hold: WorkspaceHold | null = null;
    let checkoutFiles: number | null = null;
    // The fibre must not outrun its registration: `begin` is what cancel and
    // every stage update key on, so the program holds here until the tracker
    // entry and its durable running record exist. Waiting inside the program
    // (rather than around it) keeps a cancel in that window recordable.
    const registered = yield* Deferred.make<void>();

    const program = Effect.gen(function* () {
      yield* Deferred.await(registered);
      // Serialise the parent-worktree snapshot commit + worktree creation
      // against a concurrent fan-in merge on the same worktree (review finding
      // 3). The snapshot commit is NOT swallowed: a failed base commit means
      // the child would branch mis-based, so it propagates to the caller (→
      // needs_guidance).
      const worktree = yield* worktreeMutationLock.withLock(
        input.parentCwd,
        Effect.gen(function* () {
          // Base commit (plan §2): the child must see the goal's *current*
          // state, which may be uncommitted in the parent worktree. Snapshot it
          // onto the parent branch so the child branches from an exact,
          // committed HEAD and the fan-in merge-base is clean. The shipper
          // squashes wip at PR time. Retried: this races the parent agent's own
          // git subprocess, which the in-process lock above cannot serialise
          // against.
          yield* gitWorkflow
            .commitAll(input.parentCwd, "wip: workstream snapshot", "")
            .pipe(Effect.retry(GIT_LOCK_RETRY));
          yield* setupTracker.stageStatus(threadId, "checkout", "running");
          return yield* gitWorkflow.createWorktree(
            {
              cwd: input.parentCwd,
              refName: input.parentBranch,
              newRefName: branch,
              baseRefName: input.parentBranch,
              path: null,
            },
            {
              progress: {
                onWorktreeClaimed: (path) =>
                  workspaceLease.hold(path, `worktree-provision:${threadId}`).pipe(
                    Effect.map((held) => {
                      claimedPath = path;
                      hold = held;
                    }),
                  ),
                onCheckoutProgress: ({ percent, completed, total }) => {
                  checkoutFiles = total;
                  return setupTracker.stage(threadId, "checkout", {
                    percent,
                    detail: `${completed.toLocaleString("en-US")} / ${total.toLocaleString("en-US")} files`,
                  });
                },
                onSubmodulesStarted: () =>
                  setupTracker
                    .stageStatus(
                      threadId,
                      "checkout",
                      "done",
                      checkoutFiles === null
                        ? null
                        : `${checkoutFiles.toLocaleString("en-US")} files`,
                    )
                    .pipe(
                      Effect.andThen(setupTracker.stageStatus(threadId, "submodules", "running")),
                    ),
                onSubmoduleLine: (line) => {
                  const submodulePath = /Submodule path '([^']+)'/.exec(line)?.[1];
                  return submodulePath === undefined
                    ? Effect.void
                    : setupTracker.stage(threadId, "submodules", { detail: submodulePath });
                },
                onSubmodulesFinished: ({ ok, detail }) =>
                  setupTracker.stageStatus(
                    threadId,
                    "submodules",
                    ok ? "done" : "warning",
                    ok ? undefined : (detail ?? "submodule checkout failed"),
                  ),
              },
            },
          );
        }),
      );
      const worktreePath = worktree.worktree.path;
      const checkoutEndedAt = yield* nowIso;
      yield* setupTracker.update(threadId, (snapshot) => ({
        ...snapshot,
        worktreePath,
        stages: snapshot.stages.map((stage) =>
          stage.id === "checkout" && stage.status === "running"
            ? {
                ...stage,
                status: "done",
                percent: 100,
                endedAt: checkoutEndedAt,
                detail:
                  checkoutFiles === null
                    ? stage.detail
                    : `${checkoutFiles.toLocaleString("en-US")} files`,
              }
            : stage.id === "submodules" && stage.status === "pending"
              ? { ...stage, status: "skipped", detail: "none" }
              : stage,
        ),
      }));
      // Past this point the child owns the tree: the meta repoint below is what
      // its kickoff turn resolves its cwd from, and the caller starts that turn
      // the moment this returns. Drop the cancel handle so a late cancel cannot
      // pull the tree out from under a started agent.
      yield* setupTracker.markUncancellable(threadId);
      if (hold) yield* releaseHoldAfterWindow(hold);
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("meta-update"),
        threadId,
        branch: worktree.worktree.refName,
        worktreePath,
      } satisfies OrchestrationCommand);
      yield* refreshGitStatus(worktreePath);

      const setupScript = yield* startSetupScript({
        threadId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        projectCwd: input.parentCwd,
        worktreePath,
      });
      // The card outlives the handoff: the kickoff turn starts now and the
      // snapshot settles when the script exits, so the setup row sits next to
      // the child's first work instead of vanishing.
      if (setupScript) {
        yield* setupScript.completion.pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              setupTracker.stageStatus(
                threadId,
                "setup-script",
                "failed",
                describeSetupFailure(error),
              ),
            onSuccess: (completion) =>
              setupTracker.stageStatus(
                threadId,
                "setup-script",
                completion.exitCode === 0 ? "done" : "failed",
                completion.exitCode === 0
                  ? undefined
                  : completion.exitCode === null
                    ? "terminal closed before the script finished"
                    : `exit ${completion.exitCode}`,
              ),
          }),
          Effect.andThen(settleSetup(threadId, "done")),
          Effect.forkDetach,
        );
      } else {
        yield* settleSetup(threadId, "done");
      }
      return { worktreePath, branch: worktree.worktree.refName } satisfies ProvisionWorktreeResult;
    });

    // Cancel unwinds git back to the pre-provision state so a retry can cut the
    // branch again: `git worktree add -b` refuses an existing branch, so
    // leaving either behind would poison every later attempt.
    const unwindCancelled = Effect.gen(function* () {
      if (hold) yield* hold.release;
      if (claimedPath !== null) {
        yield* gitWorkflow
          .removeWorktree({ cwd: input.parentCwd, path: claimedPath, force: true })
          .pipe(
            Effect.retry({ times: 4, schedule: Schedule.spaced("500 millis") }),
            Effect.ignoreCause({ log: true }),
          );
      }
      // Unconditional, because an interrupt lands mid-`git worktree add` more
      // often than after it, and the directory is only reported once that
      // command returns — so the registration and the ref can outlive a cancel
      // with nothing naming them. Both are best effort.
      yield* gitWorkflow
        .pruneWorktrees({ cwd: input.parentCwd })
        .pipe(Effect.ignoreCause({ log: true }));
      yield* gitWorkflow
        .deleteBranch({ cwd: input.parentCwd, branch, force: true })
        .pipe(Effect.ignoreCause({ log: true }));
    });

    const settled = program.pipe(
      Effect.interruptible,
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          if (Cause.hasInterruptsOnly(cause)) {
            // A human cancelled through `worktreeSetup.cancel`, which
            // interrupts this fibre. Unwind, record the terminal card state,
            // and report the cancellation so the caller skips the kickoff turn.
            yield* unwindCancelled;
            yield* settleSetup(threadId, "cancelled");
            return yield* Effect.fail(new WorktreeProvisionCancelled({ threadId }));
          }
          // Nothing will use the abandoned tree, so the hold must not outlive
          // the failure; the worktree itself is left for the operator to
          // inspect, as before.
          const takenHold: WorkspaceHold | null = hold;
          if (takenHold) yield* takenHold.release;
          yield* settleSetup(threadId, "failed", Cause.pretty(cause));
          return yield* Effect.failCause(cause);
        }),
      ),
      // Recording and unwinding must complete after the interrupt lands.
      Effect.uninterruptible,
    );

    // Fork and register as one step: a detached fibre keeps running if the
    // caller is interrupted, so it must never exist without the tracker entry
    // that cancel and the stage updates key on. The running activity follows
    // immediately, because that is what tells a reloading client to attach the
    // live stream.
    const fiber = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkDetach(settled);
        yield* setupTracker.begin({
          threadId,
          branch,
          baseRef: input.parentBranch,
          stages: ["checkout", "submodules", "setup-script"],
          fiber,
        });
        const running = yield* setupTracker.get(threadId);
        if (running) yield* recordSetup(running);
        yield* Deferred.succeed(registered, undefined);
        return fiber;
      }),
    );
    return yield* Fiber.join(fiber);
  });

  // Park a child whose worktree provisioning failed: remember it (loop-spin
  // guard + wake copy), append the self-describing activity, and raise the
  // needs_guidance flag. Both dispatches are best-effort (a failed park must not
  // crash the caller). Kept here — next to provisioning — so the promote path and
  // the reactor's turn-start guard share ONE failure path.
  const raiseProvisionFailure = Effect.fn("WorktreeProvisioner.raiseProvisionFailure")(function* (
    threadId: ThreadId,
    detail: string,
  ) {
    failedProvisions.add(threadId);
    const now = yield* nowIso;
    yield* orchestrationEngine
      .dispatch({
        type: "thread.activity.append",
        commandId: yield* serverCommandId("provision-failed"),
        threadId,
        activity: {
          id: EventId.make(yield* crypto.randomUUIDv4),
          tone: "error",
          kind: "workstream.provision.failed",
          summary:
            "Worktree provisioning failed before the child started (environment/git error, not the agent) — prompt the child to retry provisioning",
          payload: { detail },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      } satisfies OrchestrationCommand)
      .pipe(Effect.ignoreCause({ log: true }));
    yield* orchestrationEngine
      .dispatch({
        type: "thread.attention.raise",
        commandId: yield* serverCommandId("provision-failed-flag"),
        threadId,
        reason: "needs_guidance",
        createdAt: now,
      } satisfies OrchestrationCommand)
      .pipe(Effect.ignoreCause({ log: true }));
  });

  const ensureIsolatedChildProvisioned = Effect.fn(
    "WorktreeProvisioner.ensureIsolatedChildProvisioned",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly role: string;
    readonly projectId?: ProjectId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
  }) {
    // No worktree meta yet (shared-provisional) — nothing to provision.
    if (input.branch === null || input.worktreePath === null) return true;
    // Already on its own `ws/…` branch — idempotent no-op; clear any stale marker.
    if (isProvisionedChildBranch(input.branch, input.threadId)) {
      failedProvisions.delete(input.threadId);
      return true;
    }
    return yield* provisionIsolatedChild({
      threadId: input.threadId,
      role: input.role,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      parentCwd: input.worktreePath,
      parentBranch: input.branch,
    }).pipe(
      Effect.matchCauseEffect({
        onFailure: (cause) =>
          // A human cancelled through `worktreeSetup.cancel`: the cancelled
          // setup card IS the record, so no needs_guidance flag is raised —
          // but the child must not be auto-promoted straight back into a fresh
          // provision, so it is remembered like a failure.
          Cause.squash(cause) instanceof WorktreeProvisionCancelled
            ? Effect.sync(() => {
                failedProvisions.add(input.threadId);
                return false;
              })
            : raiseProvisionFailure(input.threadId, Cause.pretty(cause)).pipe(Effect.as(false)),
        onSuccess: () =>
          Effect.sync(() => {
            failedProvisions.delete(input.threadId);
            return true;
          }),
      }),
      // The park's own command-id minting can (in theory only) fail with a
      // platform crypto error; if even parking is impossible, report
      // not-provisioned so the caller skips the turn. This is what makes the
      // "never fails, parks internally" contract hold.
      Effect.catchCause(() => Effect.succeed(false)),
    );
  });

  return WorktreeProvisioner.of({
    provisionIsolatedChild,
    ensureIsolatedChildProvisioned,
    hasPendingProvisionFailure: (threadId) => failedProvisions.has(threadId),
  });
});

export const layer = Layer.effect(WorktreeProvisioner, make);
