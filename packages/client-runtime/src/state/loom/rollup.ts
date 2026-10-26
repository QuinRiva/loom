/**
 * Workstream rollups over a root's descendants, as three projections never fused into one state:
 * the plan (derived board columns), the activity (`activityRunStatus`) and the attention (stored
 * reasons ∪ derived ones). A surface that wants one glyph composes them itself, as
 * `workstreamBadgeTone` does for the sidebar badge.
 */
import type {
  LoomAttentionReason,
  LoomThreadShellFields,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import { deadlockedNodes } from "@t3tools/shared/workstreamDependencies";
import * as DateTime from "effect/DateTime";
import { isBriefNeeded } from "@t3tools/shared/workstreamStart.loom";

import type { EnvironmentThreadShell } from "../models.ts";

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
  | "archivedAt"
>;

/**
 * Stored reasons plus `brief-needed`. A pending question or approval is not a
 * reason here: upstream's `pendingSubagentRequest` already carries it to every
 * ancestor (pull 12, §7.1 row 1), so the rollup would show it twice.
 */
export type WorkstreamAttentionReason = LoomAttentionReason | "brief-needed";

const ATTENTION_PRIORITY: Record<WorkstreamAttentionReason, number> = {
  error: 7,
  awaiting_acceptance: 4,
  needs_guidance: 3,
  awaiting_orchestrator: 2,
  "brief-needed": 1,
};

const byPriority = (left: WorkstreamAttentionReason, right: WorkstreamAttentionReason) =>
  ATTENTION_PRIORITY[right] - ATTENTION_PRIORITY[left];

const ATTENTION_LABELS: Record<WorkstreamAttentionReason, string> = {
  error: "Error",
  awaiting_acceptance: "Accept?",
  needs_guidance: "Needs you",
  awaiting_orchestrator: "Yielded",
  "brief-needed": "Brief needed",
};

/** The human label every client shows for an attention reason. */
export const attentionLabel = (reason: WorkstreamAttentionReason): string =>
  ATTENTION_LABELS[reason];

/**
 * A thread's own stored attention reasons, highest priority first. Enough for a
 * root, which is never brief-needed; a graph surface reads `attentionReasonsOf`.
 */
const ownAttentionOf = (
  thread: Pick<WorkstreamRollupThread, "workstream">,
): ReadonlyArray<LoomAttentionReason> => [...(thread.workstream?.attention ?? [])].sort(byPriority);

/**
 * The Loom attention a thread-list row shows instead of its upstream status, or null. A pending
 * approval or question (the row's or a subagent's; pull 12 §7.1 row 1) outranks every Loom reason
 * but `error`. A row is never a workstream child, so never brief-needed.
 */
export function rowAttentionOf(
  thread: Pick<
    EnvironmentThreadShell,
    "source" | "hasPendingApprovals" | "hasPendingUserInput" | "pendingSubagentRequest"
  >,
): LoomAttentionReason | null {
  const top = ownAttentionOf(thread.source)[0];
  const upstreamShows =
    thread.hasPendingApprovals || thread.hasPendingUserInput || thread.pendingSubagentRequest;
  return top === undefined || (upstreamShows && top !== "error") ? null : top;
}

/**
 * An unsettled thread whose latest run failed with a known class other than a
 * usage limit (auto-resumed) — the liveness sweep's `isFailedSession`, read at
 * once instead of after its three sweeps.
 */
const runFailed = (
  thread: Pick<WorkstreamRollupThread, "workstream" | "status" | "lastErrorClass">,
) =>
  thread.workstream?.outcome === null &&
  thread.status === "failed" &&
  thread.lastErrorClass != null &&
  thread.lastErrorClass !== "usage_limit";

/**
 * `ownAttentionOf` plus the two a workstream surface derives: `error` for a
 * failed latest run (before the sweep stores one), and `brief-needed` exactly
 * when the server's dispatcher would nag the parent (`isBriefNeeded`) — a held
 * child, or one still queued behind an unfinished sibling, is not owed a brief yet.
 */
export function attentionReasonsOf(
  thread: Pick<WorkstreamRollupThread, "workstream" | "status" | "lastErrorClass">,
  byId: WorkstreamIndex,
): ReadonlyArray<WorkstreamAttentionReason> {
  const own = ownAttentionOf(thread);
  const failed = runFailed(thread) && !own.includes("error");
  const briefNeeded =
    thread.workstream !== undefined && isBriefNeeded(startNodeOf(thread.workstream), byId);
  return [
    ...(failed ? (["error"] as const) : []),
    ...own,
    ...(briefNeeded ? (["brief-needed"] as const) : []),
  ];
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
   * The reason is owed to the parent agent (a yield, a missing brief) and still in agent hands: the
   * parent or any of its children has a run in flight, or the parent has completed no run since the
   * reason arose (the server's wake follows the yield by a dispatcher pass). It becomes the human's
   * once the parent's turn ends without resolving it and nothing under it is running.
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

function planRollup(
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

function activityRollup(descendants: ReadonlyArray<WorkstreamRollupThread>): ActivityRollup {
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
  { threadsById, childrenByParent }: RollupIndex,
): boolean {
  const parent = threadsById.get(thread.lineage.parentThreadId!);
  if (!PARENT_OWED.has(reason) || parent === undefined) return false;
  if (runInFlight(parent) || (childrenByParent.get(parent.id) ?? []).some(runInFlight)) return true;
  const since = parentOwedSince(thread.workstream!, reason, byId);
  const answeredAt = parent.latestRunCompletedAt ?? null;
  return since !== null && (answeredAt === null || DateTime.toEpochMillis(answeredAt) < since);
}

function attentionRollup(
  descendants: ReadonlyArray<WorkstreamRollupThread>,
  byId: WorkstreamIndex,
  index: RollupIndex,
): AttentionRollup {
  const nodes = liveOf(descendants)
    .flatMap((thread) => {
      const reason = attentionReasonsOf(thread, byId)[0];
      return reason === undefined
        ? []
        : [
            {
              id: thread.id,
              title: thread.title,
              reason,
              withAgents: withAgents(thread, reason, byId, index),
            },
          ];
    })
    .sort((left, right) => byPriority(left.reason, right.reason));
  return { count: nodes.length, highest: nodes[0]?.reason ?? null, nodes };
}

/**
 * The root row badge's one tone from the three rollups, first match wins: `failed` (an error, or a
 * deadlock with nothing running); `needs_you` (a reason the human must act on); `working` (a
 * sub-thread runs, or a parent answers what it owes, so a child queued behind a running sibling
 * lands here); `done` (every sub-thread settled); else `waiting`.
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

/** A root row's rollup badge: settled over total sub-threads, and how many wait on a human. */
export interface WorkstreamBadge {
  readonly tone: WorkstreamBadgeTone;
  readonly settled: number;
  readonly total: number;
  /** Sub-threads whose reason a human must act on (the `N!`). */
  readonly flagged: number;
}

export const workstreamBadgeOf = (rollup: WorkstreamRollup): WorkstreamBadge => ({
  tone: workstreamBadgeTone(rollup),
  settled: rollup.plan.columns.done + rollup.plan.columns.cancelled,
  total: rollup.plan.total,
  flagged: rollup.attention.nodes.filter((node) => !node.withAgents).length,
});

/** Every held shell by id and by lineage parent: build once per snapshot when rolling up many roots. */
export interface RollupIndex {
  readonly threadsById: ReadonlyMap<ThreadId, WorkstreamRollupThread>;
  readonly childrenByParent: ReadonlyMap<ThreadId, ReadonlyArray<WorkstreamRollupThread>>;
}

export function rollupIndexOf(threads: ReadonlyArray<WorkstreamRollupThread>): RollupIndex {
  const childrenByParent = new Map<ThreadId, WorkstreamRollupThread[]>();
  for (const thread of threads) {
    const parentId = thread.lineage.parentThreadId;
    if (parentId === null) continue;
    const siblings = childrenByParent.get(parentId);
    if (siblings) siblings.push(thread);
    else childrenByParent.set(parentId, [thread]);
  }
  return { threadsById: new Map(threads.map((thread) => [thread.id, thread])), childrenByParent };
}

/** Transitive lineage descendants in depth-first pre-order, as `descendantsOf` walks them. */
function descendantsIn(rootThreadId: ThreadId, { childrenByParent }: RollupIndex) {
  const out: WorkstreamRollupThread[] = [];
  const seen = new Set([rootThreadId]);
  const visit = (id: ThreadId) => {
    for (const child of childrenByParent.get(id) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push(child);
      visit(child.id);
    }
  };
  visit(rootThreadId);
  return out;
}

/** The three rollups for `rootThreadId`'s descendants (lineage), from every shell held. */
export function workstreamRollupOf(
  rootThreadId: ThreadId,
  threads: ReadonlyArray<WorkstreamRollupThread>,
  byId: WorkstreamIndex,
  index = rollupIndexOf(threads),
): WorkstreamRollup {
  const descendants = descendantsIn(rootThreadId, index);
  return {
    plan: planRollup(descendants, byId),
    activity: activityRollup(descendants),
    attention: attentionRollup(descendants, byId, index),
  };
}
