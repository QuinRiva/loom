/**
 * Workstream rollups over a root's descendants (Phase 3 plan, track 3d; the V1
 * `workstreamRollup.ts` retyped onto V2 shells). Three independent projections,
 * never fused into one state: the plan (derived board columns), the activity
 * (`activityRunStatus`) and the attention (stored reasons ∪ derived ones). A
 * surface that wants one glyph composes them itself, as `workstreamBadgeTone`
 * does for the sidebar badge.
 *
 * @module state/loom/rollup
 */
import type {
  LoomAttentionReason,
  LoomThreadShellFields,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import { deadlockedNodes } from "@t3tools/shared/workstreamDependencies";
import * as DateTime from "effect/DateTime";
import { descendantsOf } from "@t3tools/shared/workstreamGraph";
import { isBriefNeeded } from "@t3tools/shared/workstreamStart.loom";

import {
  deriveBoardColumn,
  startNodeOf,
  type WorkstreamBoardColumn,
  type WorkstreamIndex,
} from "./workstream.ts";

/** The fields the rollups read from a thread shell. */
export type WorkstreamRollupThread = Pick<
  OrchestrationV2ThreadShell,
  | "id"
  | "title"
  | "lineage"
  | "workstream"
  | "activityRunStatus"
  | "status"
  | "lastErrorClass"
  | "latestRunCompletedAt"
  | "pendingRuntimeRequest"
  | "archivedAt"
>;

/** Stored reasons plus the three the client derives. */
export type WorkstreamAttentionReason =
  | LoomAttentionReason
  | "awaiting_input"
  | "awaiting_approval"
  | "brief-needed";

const ATTENTION_PRIORITY: Record<WorkstreamAttentionReason, number> = {
  error: 7,
  awaiting_approval: 6,
  awaiting_input: 5,
  awaiting_acceptance: 4,
  needs_guidance: 3,
  awaiting_orchestrator: 2,
  "brief-needed": 1,
};

const byPriority = (left: WorkstreamAttentionReason, right: WorkstreamAttentionReason) =>
  ATTENTION_PRIORITY[right] - ATTENTION_PRIORITY[left];

/**
 * A thread's own attention reasons, highest priority first: the sidecar's
 * stored reasons, plus `awaiting_input` / `awaiting_approval` from the pending
 * runtime request (every request kind but `user_input` is an approval). Enough
 * for a root, which is never brief-needed; a graph surface reads
 * `attentionReasonsOf`.
 */
export function ownAttentionOf(
  thread: Pick<WorkstreamRollupThread, "workstream" | "pendingRuntimeRequest">,
): ReadonlyArray<WorkstreamAttentionReason> {
  const request = thread.pendingRuntimeRequest?.kind;
  const reasons: WorkstreamAttentionReason[] = [...(thread.workstream?.attention ?? [])];
  if (request !== undefined)
    reasons.push(request === "user_input" ? "awaiting_input" : "awaiting_approval");
  return reasons.sort(byPriority);
}

/**
 * `ownAttentionOf` plus `brief-needed`, derived exactly when the server's
 * dispatcher would nag the parent (`isBriefNeeded`): a held child, or one
 * still queued behind an unfinished sibling, is not owed a brief yet.
 */
export function attentionReasonsOf(
  thread: Pick<WorkstreamRollupThread, "workstream" | "pendingRuntimeRequest">,
  byId: WorkstreamIndex,
): ReadonlyArray<WorkstreamAttentionReason> {
  const own = ownAttentionOf(thread);
  return thread.workstream !== undefined && isBriefNeeded(startNodeOf(thread.workstream), byId)
    ? [...own, "brief-needed"]
    : own;
}

/**
 * The question a thread waits on (S4): its first header, when the request
 * carries one, and when it was asked. Null unless the pending request is a
 * `user_input` one. The sidebar row, the input alert and the mobile card read it.
 */
export function pendingQuestionOf(
  thread: Pick<OrchestrationV2ThreadShell, "pendingRuntimeRequest">,
): { readonly header: string | null; readonly since: string } | null {
  const request = thread.pendingRuntimeRequest;
  return request?.kind === "user_input"
    ? { header: request.header ?? null, since: DateTime.formatIso(request.createdAt) }
    : null;
}

export interface PlanRollup {
  /** Live (non-archived) sidecar-bearing descendants. */
  readonly total: number;
  readonly columns: Readonly<Record<WorkstreamBoardColumn, number>>;
  /** Every descendant has an outcome (and there is at least one). */
  readonly settled: boolean;
  /** The shared deadlock predicate's members, or null. */
  readonly deadlocked: ReadonlyArray<ThreadId> | null;
}

export interface ActivityRollup {
  /** Descendants whose activity-owning run is `running`. */
  readonly running: number;
  /** Descendants with any activity (`preparing | starting | running | waiting`). */
  readonly active: number;
}

export interface AttentionActionNode {
  readonly id: ThreadId;
  readonly title: string;
  readonly reason: WorkstreamAttentionReason;
  /**
   * The reason is owed to the parent agent (a yield, a missing brief) and is
   * still in agent hands: the parent has a run in flight, or none has finished
   * since the reason arose (the server's wake follows the yield by a dispatcher
   * pass), or the parent has already resumed the child. The human's only once
   * the parent's turn ends without resolving it.
   */
  readonly withAgents: boolean;
}

export interface AttentionRollup {
  /** Descendants carrying any reason. */
  readonly count: number;
  readonly highest: WorkstreamAttentionReason | null;
  /** The flagged descendants, highest priority first. */
  readonly nodes: ReadonlyArray<AttentionActionNode>;
}

export interface WorkstreamRollup {
  readonly plan: PlanRollup;
  readonly activity: ActivityRollup;
  readonly attention: AttentionRollup;
}

const liveOf = <T extends WorkstreamRollupThread>(threads: ReadonlyArray<T>) =>
  threads.filter((thread) => thread.archivedAt === null && thread.workstream !== undefined);

export function planRollup(
  descendants: ReadonlyArray<WorkstreamRollupThread>,
  byId: WorkstreamIndex,
): PlanRollup {
  const nodes = liveOf(descendants);
  const columns = { held: 0, blocked: 0, ready: 0, in_progress: 0, done: 0, cancelled: 0 };
  for (const thread of nodes) columns[deriveBoardColumn(thread.workstream!, byId)] += 1;
  const deadlocked = deadlockedNodes(
    nodes.flatMap((thread) => byId.get(thread.id) ?? []),
    byId,
  );
  return {
    total: nodes.length,
    columns,
    settled: nodes.length > 0 && nodes.every((thread) => thread.workstream!.outcome !== null),
    deadlocked: deadlocked?.map((node) => node.id) ?? null,
  };
}

export function activityRollup(descendants: ReadonlyArray<WorkstreamRollupThread>): ActivityRollup {
  const nodes = liveOf(descendants);
  return {
    running: nodes.filter((thread) => thread.activityRunStatus === "running").length,
    active: nodes.filter((thread) => (thread.activityRunStatus ?? null) !== null).length,
  };
}

/** Reasons addressed to the parent agent, which the server wakes to answer them. */
const PARENT_OWED: ReadonlySet<WorkstreamAttentionReason> = new Set([
  "awaiting_orchestrator",
  "brief-needed",
]);

const IN_FLIGHT: ReadonlySet<OrchestrationV2ThreadShell["status"]> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

/** A run requested, queued, starting, running or waiting on a tool. */
const runInFlight = (thread: Pick<WorkstreamRollupThread, "activityRunStatus" | "status">) =>
  (thread.activityRunStatus ?? null) !== null || IN_FLIGHT.has(thread.status);

/**
 * When a parent-owed reason arose (ms), or null when no wake will come: the
 * yield's submit (an imported yield has no event, so the server never wakes
 * for it), or the brief-needed episode — creation, the dependency set, or the
 * last dependency finishing.
 */
function parentOwedSince(
  workstream: LoomThreadShellFields,
  reason: WorkstreamAttentionReason,
  byId: WorkstreamIndex,
): number | null {
  if (reason === "awaiting_orchestrator")
    return workstream.lastOutcome?.eventId == null ? null : Date.parse(workstream.lastOutcome.at);
  return Math.max(
    ...[
      workstream.createdAt,
      workstream.dependenciesSince,
      ...workstream.blockedBy.map((id) => byId.get(id)?.outcomeAt ?? null),
    ].flatMap((iso) => (iso === null ? [] : [Date.parse(iso)])),
  );
}

function withAgents(
  thread: WorkstreamRollupThread,
  reason: WorkstreamAttentionReason,
  byId: WorkstreamIndex,
  threadsById: ReadonlyMap<ThreadId, WorkstreamRollupThread>,
): boolean {
  const parent = threadsById.get(thread.lineage.parentThreadId!);
  if (!PARENT_OWED.has(reason) || parent === undefined) return false;
  if (runInFlight(parent) || runInFlight(thread)) return true;
  const since = parentOwedSince(thread.workstream!, reason, byId);
  const answeredAt = parent.latestRunCompletedAt ?? null;
  return since !== null && (answeredAt === null || DateTime.toEpochMillis(answeredAt) < since);
}

/** An unsettled thread whose latest run failed for a reason other than a usage limit (auto-resumed). */
const runFailed = (thread: WorkstreamRollupThread) =>
  thread.workstream?.outcome === null &&
  thread.status === "failed" &&
  thread.lastErrorClass !== "usage_limit";

export function attentionRollup(
  descendants: ReadonlyArray<WorkstreamRollupThread>,
  byId: WorkstreamIndex,
  threadsById: ReadonlyMap<ThreadId, WorkstreamRollupThread>,
): AttentionRollup {
  const nodes = liveOf(descendants)
    .flatMap((thread) => {
      // A failed run reads as an error at once, before the liveness sweep stores one.
      const reason = runFailed(thread) ? "error" : attentionReasonsOf(thread, byId)[0];
      return reason === undefined
        ? []
        : [
            {
              id: thread.id,
              title: thread.title,
              reason,
              withAgents: withAgents(thread, reason, byId, threadsById),
            },
          ];
    })
    .sort((left, right) => byPriority(left.reason, right.reason));
  return { count: nodes.length, highest: nodes[0]?.reason ?? null, nodes };
}

/**
 * The root row badge's one summary tone, composed from the three rollups,
 * first match wins: `failed` (an error, or a deadlock with nothing running);
 * `needs_you` (a reason the human must act on); `working` (a sub-thread runs,
 * or a parent is answering what it owes — a child queued behind a running
 * sibling lands here); `done` (every sub-thread settled); else `waiting`.
 */
export type WorkstreamBadgeTone = "failed" | "needs_you" | "working" | "done" | "waiting";

export function workstreamBadgeTone({
  plan,
  activity,
  attention,
}: WorkstreamRollup): WorkstreamBadgeTone {
  if (attention.highest === "error" || (plan.deadlocked !== null && activity.active === 0))
    return "failed";
  if (attention.nodes.some((node) => !node.withAgents)) return "needs_you";
  if (activity.active > 0 || attention.nodes.length > 0) return "working";
  return plan.settled ? "done" : "waiting";
}

/** The three rollups for `rootThreadId`'s descendants (lineage), from every shell held. */
export function workstreamRollupOf(
  rootThreadId: ThreadId,
  threads: ReadonlyArray<WorkstreamRollupThread>,
  byId: WorkstreamIndex,
): WorkstreamRollup {
  const byThreadId = new Map(threads.map((thread) => [thread.id, thread]));
  const descendants = descendantsOf(
    rootThreadId,
    threads.map((thread) => ({ id: thread.id, parentThreadId: thread.lineage.parentThreadId })),
  ).map((node) => byThreadId.get(node.id)!);
  return {
    plan: planRollup(descendants, byId),
    activity: activityRollup(descendants),
    attention: attentionRollup(descendants, byId, byThreadId),
  };
}
