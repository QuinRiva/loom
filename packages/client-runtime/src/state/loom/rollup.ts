/**
 * Workstream rollups over a root's descendants (Phase 3 plan, track 3d; the V1
 * `workstreamRollup.ts` retyped onto V2 shells). Three independent projections,
 * never fused into one state: the plan (derived board columns), the activity
 * (`activityRunStatus`) and the attention (stored reasons ∪ derived ones). A
 * surface that wants one glyph composes them itself.
 *
 * @module state/loom/rollup
 */
import type { LoomAttentionReason, OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import { deadlockedNodes } from "@t3tools/shared/workstreamDependencies";
import { descendantsOf } from "@t3tools/shared/workstreamGraph";

import {
  deriveBoardColumn,
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

/**
 * A thread's attention reasons, highest priority first: the sidecar's stored
 * reasons, `awaiting_input` / `awaiting_approval` from the pending runtime
 * request (every request kind but `user_input` is an approval), and
 * `brief-needed` for a live child with neither a kickoff brief nor a start.
 */
export function attentionReasonsOf(
  thread: Pick<WorkstreamRollupThread, "workstream" | "pendingRuntimeRequest">,
): ReadonlyArray<WorkstreamAttentionReason> {
  const workstream = thread.workstream;
  const request = thread.pendingRuntimeRequest?.kind;
  const reasons: WorkstreamAttentionReason[] = [...(workstream?.attention ?? [])];
  if (request !== undefined)
    reasons.push(request === "user_input" ? "awaiting_input" : "awaiting_approval");
  if (
    workstream !== undefined &&
    workstream.parentThreadId !== null &&
    workstream.outcome === null &&
    workstream.kickoffBriefPath === null &&
    workstream.kickoffAt === null
  ) {
    reasons.push("brief-needed");
  }
  return reasons.sort((left, right) => ATTENTION_PRIORITY[right] - ATTENTION_PRIORITY[left]);
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

export function attentionRollup(
  descendants: ReadonlyArray<WorkstreamRollupThread>,
): AttentionRollup {
  const nodes = liveOf(descendants)
    .flatMap((thread) => {
      const reason = attentionReasonsOf(thread)[0];
      return reason === undefined ? [] : [{ id: thread.id, title: thread.title, reason }];
    })
    .sort((left, right) => ATTENTION_PRIORITY[right.reason] - ATTENTION_PRIORITY[left.reason]);
  return { count: nodes.length, highest: nodes[0]?.reason ?? null, nodes };
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
    attention: attentionRollup(descendants),
  };
}
