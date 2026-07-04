import {
  CommandId,
  EventId,
  type GitCommandError,
  type OrchestrationCommand,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as PlatformError from "effect/PlatformError";

import type { OrchestrationDispatchError } from "../orchestration/Errors.ts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { WorktreeMutationLock } from "../git/WorktreeMutationLock.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";
import { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";

/**
 * WorktreeProvisioner — the single provisioning tail shared by the root
 * bootstrap (`ws.ts`) and the workstream dispatcher's promotion path
 * (worktree-isolation plan §2). It owns: create the worktree, repoint the
 * thread's `branch`/`worktreePath`, refresh git status, and fire the setup
 * script (non-blocking, behind the `t3code-setup-state.json` breadcrumb) with
 * its activity trail. Extracting it keeps the two callers from duplicating the
 * createWorktree → meta.update → setup → activities sequence.
 */

export interface ProvisionWorktreeInput {
  readonly threadId: ThreadId;
  readonly projectId?: ProjectId;
  /** Repo cwd the git operations run against (parent worktree / project root). */
  readonly projectCwd: string;
  /** The ref the new worktree branches from. */
  readonly baseBranch: string;
  /** The new branch to create for the worktree (omit to attach on `baseBranch`). */
  readonly branch?: string;
  /** Resolve the base ref against origin first (root bootstrap fresh-clone). */
  readonly startFromOrigin?: boolean;
}

export interface ProvisionWorktreeResult {
  readonly worktreePath: string;
  readonly branch: string;
}

export interface RunSetupInput {
  readonly threadId: ThreadId;
  readonly projectId?: ProjectId;
  readonly projectCwd?: string;
  readonly worktreePath: string;
}

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
type ProvisionError = GitCommandError | OrchestrationDispatchError | PlatformError.PlatformError;

export class WorktreeProvisioner extends Context.Service<
  WorktreeProvisioner,
  {
    readonly provisionWorktree: (
      input: ProvisionWorktreeInput,
    ) => Effect.Effect<ProvisionWorktreeResult, ProvisionError>;
    readonly provisionIsolatedChild: (
      input: ProvisionIsolatedChildInput,
    ) => Effect.Effect<ProvisionWorktreeResult, ProvisionError>;
    // Fire-and-forget setup for a pre-existing worktree (the bootstrap
    // setup-only case). Non-blocking; status flows via the breadcrumb + trail.
    readonly runSetup: (input: RunSetupInput) => Effect.Effect<void, ProvisionError>;
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

  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => CommandId.make(`server:worktree-provisioner:${tag}:${uuid}`)),
    );

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

  // Fire-and-forget setup (plan §2): observe completion in a detached fibre so
  // the provider turn starts without waiting; the breadcrumb + activities carry
  // status. Setup failure follows the existing policy — the child sees `failed`
  // and reports; no new escalation machinery.
  const runSetup = Effect.fn("WorktreeProvisioner.runSetup")(function* (input: RunSetupInput) {
    const requestedAt = yield* nowIso;
    const recordFailure = (detail: string, createdAt: string) =>
      appendActivity({
        threadId: input.threadId,
        kind: "setup-script.failed",
        summary: "Setup script failed",
        createdAt,
        payload: { detail, worktreePath: input.worktreePath },
        tone: "error",
      });
    yield* setupRunner
      .runForThread({
        threadId: input.threadId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.projectCwd ? { projectCwd: input.projectCwd } : {}),
        worktreePath: input.worktreePath,
      })
      .pipe(
        Effect.matchEffect({
          onFailure: (error) => recordFailure(describeSetupFailure(error), requestedAt),
          onSuccess: (result) => {
            if (result.status !== "started") return Effect.void;
            const base = {
              worktreePath: input.worktreePath,
              scriptId: result.scriptId,
              scriptName: result.scriptName,
              terminalId: result.terminalId,
            };
            return Effect.gen(function* () {
              yield* appendActivity({
                threadId: input.threadId,
                kind: "setup-script.requested",
                summary: "Starting setup script",
                createdAt: requestedAt,
                payload: base,
                tone: "info",
              });
              yield* appendActivity({
                threadId: input.threadId,
                kind: "setup-script.started",
                summary: "Setup script started",
                createdAt: yield* nowIso,
                payload: base,
                tone: "info",
              });
              yield* result.completion.pipe(
                Effect.matchEffect({
                  onFailure: (error) =>
                    nowIso.pipe(
                      Effect.flatMap((createdAt) =>
                        recordFailure(describeSetupFailure(error), createdAt),
                      ),
                    ),
                  onSuccess: () =>
                    nowIso.pipe(
                      Effect.flatMap((createdAt) =>
                        appendActivity({
                          threadId: input.threadId,
                          kind: "setup-script.completed",
                          summary: "Setup script completed",
                          createdAt,
                          payload: base,
                          tone: "info",
                        }),
                      ),
                    ),
                }),
                Effect.forkDetach,
              );
            });
          },
        }),
      );
  });

  const provisionWorktree = Effect.fn("WorktreeProvisioner.provisionWorktree")(function* (
    input: ProvisionWorktreeInput,
  ) {
    let worktreeBaseRef = input.baseBranch;
    if (input.startFromOrigin) {
      yield* gitWorkflow.fetchRemote({ cwd: input.projectCwd, remoteName: "origin" });
      const resolved = yield* gitWorkflow.resolveRemoteTrackingCommit({
        cwd: input.projectCwd,
        refName: input.baseBranch,
        fallbackRemoteName: "origin",
      });
      worktreeBaseRef = resolved.commitSha;
    }
    const worktree = yield* gitWorkflow.createWorktree({
      cwd: input.projectCwd,
      refName: worktreeBaseRef,
      ...(input.branch ? { newRefName: input.branch } : {}),
      baseRefName: input.baseBranch,
      path: null,
    });
    const worktreePath = worktree.worktree.path;
    yield* orchestrationEngine.dispatch({
      type: "thread.meta.update",
      commandId: yield* serverCommandId("meta-update"),
      threadId: input.threadId,
      branch: worktree.worktree.refName,
      worktreePath,
    } satisfies OrchestrationCommand);
    yield* refreshGitStatus(worktreePath);
    return { worktreePath, branch: worktree.worktree.refName };
  });

  const provisionIsolatedChild = Effect.fn("WorktreeProvisioner.provisionIsolatedChild")(function* (
    input: ProvisionIsolatedChildInput,
  ) {
    const branch = workstreamChildBranchName(input.parentBranch, input.role, input.threadId);
    // Serialise the parent-worktree snapshot commit + worktree creation against
    // a concurrent fan-in merge on the same worktree (review finding 3). The
    // snapshot commit is NOT swallowed: a failed base commit means the child
    // would branch mis-based, so it propagates to the caller (→ needs_guidance).
    const result = yield* worktreeMutationLock.withLock(
      input.parentCwd,
      Effect.gen(function* () {
        // Base commit (plan §2): the child must see the goal's *current* state,
        // which may be uncommitted in the parent worktree. Snapshot it onto the
        // parent branch so the child branches from an exact, committed HEAD and
        // the fan-in merge-base is clean. The shipper squashes wip at PR time.
        yield* gitWorkflow.commitAll(input.parentCwd, "wip: workstream snapshot", "");
        return yield* provisionWorktree({
          threadId: input.threadId,
          ...(input.projectId ? { projectId: input.projectId } : {}),
          projectCwd: input.parentCwd,
          baseBranch: input.parentBranch,
          branch,
        });
      }),
    );
    yield* runSetup({
      threadId: input.threadId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      projectCwd: input.parentCwd,
      worktreePath: result.worktreePath,
    });
    return result;
  });

  return WorktreeProvisioner.of({ provisionWorktree, provisionIsolatedChild, runSetup });
});

export const layer = Layer.effect(WorktreeProvisioner, make);
