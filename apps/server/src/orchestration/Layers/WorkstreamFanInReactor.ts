// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  type ThreadFanInState,
  type ThreadId,
} from "@t3tools/contracts";
import { isMemberOfUnresolvedGate } from "@t3tools/shared/workstreamGraph";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { WorktreeMutationLock } from "../../git/WorktreeMutationLock.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { WORKSTREAM_CONTROL_PLANE_MARKER } from "./WorkstreamDispatcher.ts";
import { makeReceiptDedupedDelivery } from "../receiptDedup.ts";
import {
  WorkstreamFanInReactor,
  type WorkstreamFanInReactorShape,
} from "../Services/WorkstreamFanInReactor.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const isTerminal = (planLane: string): boolean => planLane === "done" || planLane === "cancelled";

/**
 * Periodic reconciliation tick (W2 fix): re-run the sweep over threads with
 * `planLane=done` + unsettled fan-in state. This bulletproofs against the
 * sample-vs-apply race where the final event's pass samples stale state. The
 * tick fires at startup and periodically thereafter, guaranteeing that no
 * done+none child can persist beyond one tick interval. Matches the dispatcher's
 * idle-wake-repass cadence for consistency (decision: coordinator model).
 */
export const FAN_IN_RECONCILIATION_INTERVAL_MS = 60_000;

type ProjectRef = {
  readonly id: OrchestrationThreadShell["projectId"];
  readonly workspaceRoot: string;
};

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const gitWorkflow = yield* GitWorkflowService;
  const worktreeMutationLock = yield* WorktreeMutationLock;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => CommandId.make(`server:workstream-fanin:${tag}:${uuid}`)),
    );

  // Item 3 (phase 3): resolved-conflict wake. A fan-in that first CONFLICTED and
  // later merged cleanly (child reopened → conflicts resolved → resubmitted)
  // otherwise fires no wake — the generation wake already fired once carrying the
  // conflict notice, and the clean resubmit does not re-notify (observed in e2e:
  // the orchestrator had to poll). Track the children whose fan-in conflicted so
  // the conflicted→completed transition can dispatch ONE lightweight parent
  // notice. Process-scoped: a resolution spanning a restart simply forgoes the
  // extra notice (the conflict itself is re-surfaced by generation reconciliation).
  const conflictedChildren = new Set<ThreadId>();

  // Receipt-deduped delivery for the two parent notices. Both carry deterministic
  // ids and lean on the engine's receipt store for cross-restart at-most-once, so
  // this instance needs no durable receipt lookup of its own
  // (`hasAcceptedReceipt` is always-false): `deliverOnce` adds a process-local
  // skip the site previously lacked — every conflicted pass used to re-dispatch
  // and let the engine receipt no-op it. Behaviour is identical, one engine
  // round-trip cheaper per retried pass; a fresh process re-dispatches once and
  // the engine receipt no-ops it, exactly as before.
  const dedup = yield* makeReceiptDedupedDelivery({
    hasAcceptedReceipt: () => Effect.succeed(false),
  });

  const resolvedCommandId = (child: OrchestrationThreadShell) =>
    `server:workstream-fanin:resolved:${child.id}`;

  const deliverResolutionWake = (
    child: OrchestrationThreadShell,
    parent: OrchestrationThreadShell,
  ) =>
    // `deliverOnce` adds the process-local skip; the deterministic id +
    // engine receipt remain the cross-restart at-most-once truth. `"delivered"`
    // maps to the true the caller branches on (stop tracking); a deferral maps
    // to false so the tracked child is retried on the next re-arm.
    dedup
      .deliverOnce(
        resolvedCommandId(child),
        Effect.gen(function* () {
          yield* orchestrationEngine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(resolvedCommandId(child)),
            threadId: parent.id,
            message: {
              messageId: MessageId.make(yield* crypto.randomUUIDv4),
              role: "user",
              origin: "control_notice",
              text: `${WORKSTREAM_CONTROL_PLANE_MARKER}\n\nYour Workstream sub-thread ${child.role ?? "sub-thread"} \`${child.id}\` resolved its fan-in merge conflict: its branch has now been merged cleanly into your branch, and its dependents are released. Fold its result into your orchestration and continue.`,
              attachments: [],
            },
            titleSeed: parent.title,
            runtimeMode: parent.runtimeMode,
            interactionMode: parent.interactionMode,
            // Busy parent → defer atomically at the command boundary; a later
            // session-set / fanin-set re-arm retries while the child is still tracked.
            requireIdle: true,
            createdAt: yield* nowIso,
          } satisfies OrchestrationCommand);
        }),
      )
      .pipe(
        Effect.map((outcome) => outcome === "delivered"),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("resolved-conflict wake failed", {
                child: child.id,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as(false)),
        ),
      );

  // Item 1 (loud on conflict): a fan-in that conflicts fires AFTER the gate has
  // resolved — coder + reviewer are both `done`, so the thread-local error
  // activity has no actor to act on it. Engage the one live actor that can
  // resolve it: dispatch a control-plane turn to the parent orchestrator (the
  // same primitive `deliverResolutionWake` uses) carrying everything needed to
  // hand-merge. Deterministic id → receipt-deduped, so re-running the pass (or
  // the 60s tick) never double-notifies; a deferred delivery (busy parent) is
  // retried by the next session-set/fanin re-arm.
  const conflictCommandId = (child: OrchestrationThreadShell) =>
    `server:workstream-fanin:conflict:${child.id}`;

  const deliverConflictNotice = (
    child: OrchestrationThreadShell,
    parent: OrchestrationThreadShell,
    childBranch: string,
    conflictPaths: ReadonlyArray<string>,
  ) =>
    dedup
      .deliverOnce(
        conflictCommandId(child),
        Effect.gen(function* () {
          yield* orchestrationEngine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(conflictCommandId(child)),
            threadId: parent.id,
            message: {
              messageId: MessageId.make(yield* crypto.randomUUIDv4),
              role: "user",
              origin: "control_notice",
              text: `${WORKSTREAM_CONTROL_PLANE_MARKER}\n\nYour Workstream sub-thread ${child.role ?? "sub-thread"} \`${child.id}\` finished, but its fan-in could NOT merge: merging its branch \`${childBranch}\` into your branch \`${parent.branch ?? "(unknown)"}\` hit a conflict on ${conflictPaths.length} path(s): ${conflictPaths.join(", ")}. Its review gate has already resolved, so no sub-thread can act — and its dependents stay blocked until the merge lands. Resolve it by merging \`${childBranch}\` into \`${parent.branch ?? "your branch"}\` yourself (or reopen the coder to resolve the conflict in its worktree and resubmit). Once \`${childBranch}\` is contained in your branch, the control plane completes the fan-in and releases its dependents automatically — no need to clear \`blockedBy\`.`,
              attachments: [],
            },
            titleSeed: parent.title,
            runtimeMode: parent.runtimeMode,
            interactionMode: parent.interactionMode,
            requireIdle: true,
            createdAt: yield* nowIso,
          } satisfies OrchestrationCommand);
        }),
      )
      .pipe(
        Effect.map((outcome) => outcome === "delivered"),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("fan-in conflict notice failed", {
                child: child.id,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as(false)),
        ),
      );

  const setFanInState = (threadId: ThreadId, fanInState: ThreadFanInState) =>
    Effect.gen(function* () {
      yield* orchestrationEngine.dispatch({
        type: "thread.fanin.set",
        commandId: yield* serverCommandId("set"),
        threadId,
        fanInState,
        createdAt: yield* nowIso,
      } satisfies OrchestrationCommand);
    });

  const repointMeta = (threadId: ThreadId, branch: string | null, worktreePath: string | null) =>
    Effect.gen(function* () {
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("repoint"),
        threadId,
        branch,
        worktreePath,
      } satisfies OrchestrationCommand);
    });

  const appendActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind: string;
    readonly summary: string;
    readonly payload: Record<string, unknown>;
    readonly tone: "info" | "error";
  }) =>
    Effect.gen(function* () {
      const createdAt = yield* nowIso;
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: yield* serverCommandId("activity"),
        threadId: input.threadId,
        activity: {
          id: EventId.make(yield* crypto.randomUUIDv4),
          tone: input.tone,
          kind: input.kind,
          summary: input.summary,
          payload: input.payload,
          turnId: null,
          createdAt,
        },
        createdAt,
      } satisfies OrchestrationCommand);
    }).pipe(Effect.ignoreCause({ log: true }));

  const raiseGuidance = (threadId: ThreadId) =>
    Effect.gen(function* () {
      yield* orchestrationEngine.dispatch({
        type: "thread.attention.raise",
        commandId: yield* serverCommandId("guidance"),
        threadId,
        reason: "needs_guidance",
        createdAt: yield* nowIso,
      } satisfies OrchestrationCommand);
    }).pipe(Effect.ignoreCause({ log: true }));

  const resolveCwd = (
    thread: {
      readonly projectId: OrchestrationThreadShell["projectId"];
      readonly worktreePath: string | null;
    },
    projects: ReadonlyArray<ProjectRef>,
  ): string | undefined => resolveThreadWorkspaceCwd({ thread, projects });

  // Occupancy (plan §3 step 4 / §7): worktree removal + branch deletion defer
  // while another NON-TERMINAL thread still resides in the child's worktree (a
  // shared/attached descendant mid-work) or targets its branch for fan-in (an
  // isolated descendant). Terminal residents do not defer — they are repointed.
  const isOccupied = (
    childId: ThreadId,
    childCwd: string,
    threads: ReadonlyArray<OrchestrationThreadShell>,
    projects: ReadonlyArray<ProjectRef>,
  ): boolean => {
    const resolvedChildCwd = NodePath.resolve(childCwd);
    return threads.some((t) => {
      if (t.id === childId || isTerminal(t.planLane)) return false;
      if (t.parentThreadId === childId && t.isolation === "isolated") return true;
      const cwd = resolveCwd(t, projects);
      return cwd !== undefined && NodePath.resolve(cwd) === resolvedChildCwd;
    });
  };

  // Repoint any thread whose meta still points at a now-removed worktree back to
  // the parent's values, so it does not dangle at a deleted path (review finding
  // 1c) — e.g. a done/cancelled `attached` reviewer that lived in the coder's
  // worktree (an attached thread is never otherwise processed by this reactor).
  const repointResidents = Effect.fn("repointResidents")(function* (input: {
    readonly childId: ThreadId;
    readonly childCwd: string;
    readonly parentBranch: string | null;
    readonly parentWorktreePath: string | null;
    readonly threads: ReadonlyArray<OrchestrationThreadShell>;
  }) {
    const resolvedChildCwd = NodePath.resolve(input.childCwd);
    for (const resident of input.threads) {
      if (resident.id === input.childId || resident.worktreePath === null) continue;
      if (NodePath.resolve(resident.worktreePath) === resolvedChildCwd) {
        yield* repointMeta(resident.id, input.parentBranch, input.parentWorktreePath);
      }
    }
  });

  // Remove a fanned-in child's worktree + branch and repoint its meta back to
  // the parent's values. Also repoints any resident (e.g. a done or
  // cancelled `attached` reviewer that lived in this worktree) so its meta does
  // not dangle at the deleted path (review finding 1c). Branch delete uses
  // `-d` (force: false) so an unmerged branch — e.g. one still carrying a
  // grandchild's un-propagated commits — is refused rather than destroyed
  // (review finding 5).
  const finaliseRemoval = Effect.fn("finaliseRemoval")(function* (input: {
    readonly childId: ThreadId;
    readonly childCwd: string;
    readonly childBranch: string;
    readonly parentCwd: string;
    readonly parentBranch: string | null;
    readonly parentWorktreePath: string | null;
    readonly threads: ReadonlyArray<OrchestrationThreadShell>;
    readonly projects: ReadonlyArray<ProjectRef>;
  }) {
    yield* gitWorkflow
      .removeWorktree({ cwd: input.parentCwd, path: input.childCwd, force: true })
      .pipe(Effect.ignoreCause({ log: true }));
    yield* gitWorkflow
      .deleteBranch({ cwd: input.parentCwd, branch: input.childBranch, force: false })
      .pipe(Effect.ignoreCause({ log: true }));
    yield* repointMeta(input.childId, input.parentBranch, input.parentWorktreePath);
    yield* repointResidents({
      childId: input.childId,
      childCwd: input.childCwd,
      parentBranch: input.parentBranch,
      parentWorktreePath: input.parentWorktreePath,
      threads: input.threads,
    });
  });

  // Defer the merge only while the child's runtime turn is genuinely in flight
  // (state "running") — then the worktree is mid-write and the pass is re-armed
  // by the turn-diff-completed event. Every *settled* turn is mergeable: not
  // just "completed", but also the terminal `interrupted`/`error` states and a
  // null `latestTurn`. A gated coder's lane is set to `done` by the reviewer's
  // resolve, decoupled from the coder's own turn state, so its final turn can
  // legitimately be interrupted/errored/absent (e.g. a 429 storm dropped the
  // checkpoint). Gating on `=== "completed"` wedged those coders forever
  // (permanent non-completion masquerading as a transient wait); `doFanIn`
  // commits whatever is in the child worktree, so a missing checkpoint is fine.
  const isChildTurnInFlight = (child: OrchestrationThreadShell): boolean =>
    child.latestTurn !== null && child.latestTurn.state === "running";

  // Check if a parent thread has an active/running turn, which would mean the
  // parent is mid-turn and uncommitted (plan §11 / B2: require parent quiescence
  // before merging). Parent status "running" with an activeTurnId means a turn
  // is in flight.
  const hasParentActiveTurn = (parent: OrchestrationThreadShell): boolean =>
    parent.session !== null &&
    parent.session.status === "running" &&
    parent.session.activeTurnId !== null;

  // Cancel-race hardening (phase 3, task A): the cancel cascade emits
  // `thread.turn-interrupt-requested`, but the provider process winds down
  // asynchronously and can still be writing files after `plan-lane-set
  // cancelled` lands. Committing `wip: cancelled` + removing the worktree at
  // that instant races those writes. Same wait-for-quiescence principle as the
  // done path above: defer the cancel disposition until the child's session has
  // left "running"/"starting" (leaving "running" is the authoritative turn-end
  // signal — see the projector's session-set handling) and its latest turn is
  // no longer running. Re-armed by session-set / turn-diff-completed events and
  // the periodic reconciliation tick, so a missed wake-up still converges.
  const isCancelledChildQuiescent = (child: OrchestrationThreadShell): boolean =>
    !(
      child.session !== null &&
      (child.session.status === "running" || child.session.status === "starting")
    ) && !(child.latestTurn !== null && child.latestTurn.state === "running");

  // Merge an isolated child's branch back into the parent branch and settle its
  // fan-in state. Gate-guarded by the caller. Parent-worktree mutations run
  // under the per-worktree lock so a concurrent sibling provisioning cannot race
  // the merge (review finding 3). Caller ensures child's turn is completed and
  // parent has no active turn before calling (plan §11 / B2).
  const doFanIn = Effect.fn("doFanIn")(function* (
    child: OrchestrationThreadShell,
    parent: OrchestrationThreadShell,
    parentCwd: string,
    threads: ReadonlyArray<OrchestrationThreadShell>,
    projects: ReadonlyArray<ProjectRef>,
  ) {
    const childCwd = child.worktreePath!;
    const childBranch = child.branch!;
    // Commit the child's own worktree first (its own single-writer tree).
    yield* gitWorkflow.commitAll(childCwd, `wip(${child.role ?? "child"}): ${child.title}`, "");

    yield* worktreeMutationLock.withLock(
      parentCwd,
      Effect.gen(function* () {
        yield* gitWorkflow.commitAll(parentCwd, "wip: workstream snapshot", "");
        const merge = yield* gitWorkflow.mergeWorktreeBranch({
          cwd: parentCwd,
          branch: childBranch,
          subject: `merge ${childBranch}`,
        });
        if (merge.status === "conflict") {
          // Write ONLY on a genuine transition. Re-emitting `fanin.set` for an
          // already-`conflicted` child is a self-feeding edge: the decider emits
          // a `thread.fanin-set` event for every set command (no unchanged-value
          // guard), the reactor re-arms its worker on that event, and the
          // non-coalescing DrainableWorker runs another pass — which re-conflicts
          // and re-writes, spinning git merge/abort under the worktree lock for
          // as long as the conflict stays unresolved. Skipping the no-op write
          // means re-attempts fire only via genuine external re-arms
          // (session-set / turn-diff-completed / the 60s tick), which is the
          // intended cadence; the self-heal path still converges (a later
          // up-to-date re-attempt sets `completed`).
          if (child.fanInState !== "conflicted") yield* setFanInState(child.id, "conflicted");
          // First observation of THIS conflict (process-scoped) fires the loud,
          // one-shot signals; a retry that still conflicts (60s tick) must not
          // re-spam the activity feed or re-raise attention. After a restart the
          // set is empty, so a persisted conflict is re-surfaced exactly once.
          const firstObservation = !conflictedChildren.has(child.id);
          conflictedChildren.add(child.id);
          if (firstObservation) {
            yield* appendActivity({
              threadId: child.id,
              kind: "workstream.fanin.conflicted",
              summary: `Fan-in merge of ${childBranch} into ${parent.branch ?? "parent"} conflicted (${merge.conflictPaths.length} path(s)); the gate has resolved, so the parent orchestrator must resolve it.`,
              payload: {
                branch: childBranch,
                conflictPaths: merge.conflictPaths,
                parentBranch: parent.branch,
              },
              tone: "error",
            });
            yield* raiseGuidance(parent.id);
          }
          // Notice is receipt-deduped by its deterministic id, so calling it on
          // every conflicted pass is at-most-once yet retries a deferred delivery.
          yield* deliverConflictNotice(child, parent, childBranch, merge.conflictPaths);
          return;
        }
        yield* setFanInState(child.id, "completed");
        if (!isOccupied(child.id, childCwd, threads, projects)) {
          yield* finaliseRemoval({
            childId: child.id,
            childCwd,
            childBranch,
            parentCwd,
            parentBranch: parent.branch,
            parentWorktreePath: parent.worktreePath,
            threads,
            projects,
          });
        }
      }),
    );
  });

  const doCancelled = Effect.fn("doCancelled")(function* (
    child: OrchestrationThreadShell,
    parent: OrchestrationThreadShell,
    parentCwd: string,
    threads: ReadonlyArray<OrchestrationThreadShell>,
  ) {
    const childCwd = child.worktreePath!;
    // Snapshot whatever is in the worktree onto the (kept) branch, then remove
    // the worktree — abandoned work stays recoverable via plain git (plan §3).
    yield* worktreeMutationLock.withLock(
      parentCwd,
      Effect.gen(function* () {
        yield* gitWorkflow.commitAll(childCwd, "wip: cancelled", "");
        yield* gitWorkflow
          .removeWorktree({ cwd: parentCwd, path: childCwd, force: true })
          .pipe(Effect.ignoreCause({ log: true }));
        // Land the dead thread's meta in the parent tree so a later reopen is
        // safe; keep its branch name for discovery/recovery. Also repoint any
        // resident (e.g. a cascade-cancelled attached reviewer) off the removed
        // worktree so its meta does not dangle (review finding 1c).
        yield* repointMeta(child.id, child.branch, parent.worktreePath ?? null);
        yield* repointResidents({
          childId: child.id,
          childCwd,
          parentBranch: child.branch,
          parentWorktreePath: parent.worktreePath ?? null,
          threads,
        });
      }),
    );
  });

  // Is this isolated child provisioned into its own worktree/branch (distinct
  // from the parent's)? Guards the defensive "never provisioned" case.
  const isProvisioned = (
    child: OrchestrationThreadShell,
    parent: OrchestrationThreadShell | undefined,
    childCwd: string,
    parentCwd: string,
  ): boolean =>
    parent !== undefined &&
    child.branch !== null &&
    child.worktreePath !== null &&
    child.branch !== parent.branch &&
    NodePath.resolve(childCwd) !== NodePath.resolve(parentCwd);

  // One idempotent sweep over the read model (review findings 1/2 re-arm): every
  // isolated thread is driven to its correct disposition regardless of which
  // terminal event triggered the pass.
  const runPass = Effect.fn("runPass")(function* () {
    const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
    const threads = snapshot.threads;
    const projects = snapshot.projects;
    for (const child of threads) {
      if (child.isolation !== "isolated") continue;
      const parent =
        child.parentThreadId === null
          ? undefined
          : threads.find((t) => t.id === child.parentThreadId);
      const parentCwd = parent ? resolveCwd(parent, projects) : undefined;

      const handle = Effect.gen(function* () {
        // Resolved-conflict wake (item 3): a tracked child whose fan-in has now
        // settled `completed` merged cleanly after an earlier conflict — notify
        // the parent once, then stop tracking. A tracked child that was instead
        // cancelled will never merge; drop it so the set does not leak.
        if (conflictedChildren.has(child.id)) {
          if (child.fanInState === "completed" && parent !== undefined) {
            if (yield* deliverResolutionWake(child, parent)) conflictedChildren.delete(child.id);
          } else if (child.planLane === "cancelled") {
            conflictedChildren.delete(child.id);
          }
        }
        if (
          child.planLane === "done" &&
          (child.fanInState === "none" || child.fanInState === "conflicted")
        ) {
          // `conflicted` is included so the reactor SELF-HEALS after the conflict
          // is resolved externally (item 2): the orchestrator hand-merges the
          // child branch into the parent, then a re-attempt here sees the branch
          // already contained (`mergeWorktreeBranch` → `up-to-date`) and settles
          // `completed`, releasing dependents — no `workstream_set_dependencies []`
          // escape hatch needed. While genuinely unresolved the re-attempt just
          // re-conflicts and stays blocked (a dependent's premise is the merged
          // tree, so releasing on `conflicted` would be wrong).
          //
          // Gate members fan in exactly once, at resolution: skip while the gate
          // is unresolved (plan §3/§4, review finding 1). The both-parties `done`
          // at resolution — or a parent-override dissolve — re-arms this pass.
          if (isMemberOfUnresolvedGate(child, threads)) return;
          if (
            parent === undefined ||
            parentCwd === undefined ||
            child.worktreePath === null ||
            !isProvisioned(child, parent, child.worktreePath, parentCwd)
          ) {
            // Not actually provisioned into its own worktree/branch: nothing to
            // merge. Settle so dependents/wake are not wedged forever.
            yield* setFanInState(child.id, "completed");
            return;
          }
          // Defer only while the child's turn is genuinely in flight; every
          // settled turn (completed / interrupted / error / null) is mergeable
          // — `doFanIn` commits whatever is in the worktree. Also defer while the
          // parent is mid-turn (uncommitted). Both are re-armed by the
          // turn-diff-completed / session-set events and the 60s tick.
          if (isChildTurnInFlight(child)) return;
          if (hasParentActiveTurn(parent)) return;
          yield* doFanIn(child, parent, parentCwd, threads, projects);
        } else if (child.planLane === "cancelled") {
          if (
            parent === undefined ||
            parentCwd === undefined ||
            child.worktreePath === null ||
            !isProvisioned(child, parent, child.worktreePath, parentCwd)
          ) {
            return;
          }
          if (!isCancelledChildQuiescent(child)) return;
          yield* doCancelled(child, parent, parentCwd, threads);
        } else if (child.fanInState === "completed" && child.worktreePath !== null) {
          // Deferred-removal sweep (plan §3 step 4): a fanned-in child whose
          // removal was held by an occupant is cleaned up once the occupant goes
          // terminal (its terminal transition re-triggers this pass).
          if (
            parent === undefined ||
            parentCwd === undefined ||
            child.branch === null ||
            NodePath.resolve(child.worktreePath) === NodePath.resolve(parentCwd) ||
            isOccupied(child.id, child.worktreePath, threads, projects)
          ) {
            return;
          }
          yield* worktreeMutationLock.withLock(
            parentCwd,
            finaliseRemoval({
              childId: child.id,
              childCwd: child.worktreePath,
              childBranch: child.branch,
              parentCwd,
              parentBranch: parent.branch,
              parentWorktreePath: parent.worktreePath,
              threads,
              projects,
            }),
          );
        }
      });

      // Per-child failure surfacing (review finding 4): an unexpected git/dispatch
      // error must not leave the child wedged (fanInState `none`, dependents
      // blocked, parent wake held) with no signal. Raise it as an error activity
      // + `needs_guidance` so the orchestrator/human hears, and continue the sweep.
      yield* handle.pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
          return appendActivity({
            threadId: child.id,
            kind: "workstream.fanin.failed",
            summary: "Fan-in failed unexpectedly; the branch was not merged.",
            payload: { detail: Cause.pretty(cause) },
            tone: "error",
          }).pipe(Effect.andThen(raiseGuidance(child.id)));
        }),
      );
    }
  });

  const runPassSafely = runPass().pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
      return Effect.logWarning("workstream fan-in reactor pass failed", {
        cause: Cause.pretty(cause),
      });
    }),
  );

  const worker = yield* makeDrainableWorker((_trigger: void) => runPassSafely);

  const start: WorkstreamFanInReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event: OrchestrationEvent) => {
        // Plan-lane transitions (a child reaching done/cancelled, or a gate
        // counterpart resolving/dissolving) can arm a fan-in, but we defer the
        // merge until the child's runtime turn has completed. Turn completions
        // (thread.turn-diff-completed events) also re-arm, so a child that went
        // done before its turn finished will be picked up when the turn finishes.
        if (event.type === "thread.plan-lane-set") {
          const planLane = event.payload.planLane;
          return planLane === "done" || planLane === "cancelled" ? worker.enqueue() : Effect.void;
        }
        if (event.type === "thread.turn-diff-completed") {
          // Re-arm the fan-in worker when a child's turn completes, in case
          // the child's plan-lane-set (done) event arrived before the turn finished.
          return worker.enqueue();
        }
        // W2 fix: re-arm on session-set for promptness when the parent's idle
        // transition is the final trigger event that was sampled before the
        // projection write landed (one of the observed live race modes).
        if (event.type === "thread.session-set") {
          return worker.enqueue();
        }
        // Item 3: a fan-in settling to `completed` is the conflicted→completed
        // transition the resolved-conflict wake keys on — re-arm so the notice
        // fires promptly rather than waiting for the periodic tick.
        if (event.type === "thread.fanin-set") {
          return worker.enqueue();
        }
        return Effect.void;
      }),
    );
    // Startup reconciliation: recover fan-ins stranded by a crash (no event
    // replay on the domain stream) and deferred removals whose occupant went
    // terminal during downtime.
    yield* worker.enqueue();
    // Periodic reconciliation tick (W2 fix): bulletproofs against the
    // sample-vs-apply race by re-evaluating every unsettled done child on an
    // interval. The pass is idempotent (reads state from scratch each time), so
    // periodic re-runs are harmless. Guarantees that no done+none state can
    // persist beyond one tick interval, which covers crash recovery too
    // (a restarted server with parked children will reconcile on first tick or
    // startup pass). Matches the dispatcher's idle-wake-repass cadence.
    yield* Effect.forkScoped(
      worker
        .enqueue()
        .pipe(Effect.repeat(Schedule.spaced(Duration.millis(FAN_IN_RECONCILIATION_INTERVAL_MS)))),
    );
  });

  return { start, drain: worker.drain } satisfies WorkstreamFanInReactorShape;
});

export const WorkstreamFanInReactorLive = Layer.effect(WorkstreamFanInReactor, make);
