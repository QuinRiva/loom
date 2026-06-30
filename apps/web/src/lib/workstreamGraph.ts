import type { EnvironmentId, ThreadId, ThreadPlanLane } from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { areDependenciesSatisfied } from "@t3tools/shared/workstreamDependencies";
import { descendantsOf } from "@t3tools/shared/workstreamGraph";

import type { SidebarThreadSummary } from "../types";

/**
 * Three-axis Workstream presentation (see
 * `.plans/workstream-state-model-design.md`):
 *
 *  - **Plan lane** (intent; the kanban column): `planned | ready | in_progress |
 *    done | cancelled`, plus the *derived* `blocked` (a released `ready` thread
 *    whose dependencies are unmet). This is the only axis a thread is grouped
 *    into a column by.
 *  - **Activity** (the truth; derived): is a turn literally executing right now
 *    (`hasRunningSignal`). Rendered as an overlay (live dots), never a column —
 *    a re-engaged `done` thread is plan-`done` AND activity-active at once.
 *  - **Attention** (needs-a-human; derived + agent-raised): a set of reasons,
 *    rendered as overlay badges, never a column.
 */

/**
 * Board column a thread occupies: its plan lane, or the derived `blocked` (ready
 * but waiting on upstream). Attention and activity are overlays, not columns.
 */
export type WorkstreamColumnId = ThreadPlanLane | "blocked";

export type GraphState = "active" | "attention" | "deadlocked" | "idle" | "done" | "empty";

/**
 * Attention reasons (the single notification surface). The first five mirror the
 * wire `AttentionReason`; `proposed_plan` is a derived, presentation-only gate
 * (an actionable proposed plan awaiting a decision) with no stored counterpart.
 */
export type AttentionReason =
  | "error"
  | "awaiting_approval"
  | "awaiting_input"
  | "awaiting_acceptance"
  | "needs_guidance"
  | "proposed_plan";

/** Per-state facet counts the tooltip expands the headline number into. */
export interface GraphBreakdown {
  /** Genuinely-executing workers (also the headline `activeWorkerCount`). */
  readonly running: number;
  readonly awaitingApproval: number;
  readonly inReview: number;
  readonly planned: number;
  readonly done: number;
}

/**
 * A descendant the user can act on directly from the badge popover. Carries
 * enough to navigate straight to the sub-thread. `reason` is the human gate for
 * `attention` nodes and `null` for `deadlocked` cycle members (which are stuck,
 * not gated). Populated only for the act-states (`attention`, `deadlocked`).
 */
export interface GraphActionNode {
  readonly id: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly reason: AttentionReason | null;
}

export interface GraphRollup {
  readonly graphState: GraphState;
  readonly activeWorkerCount: number;
  /** Nodes carrying any attention reason — the `attention` badge number. */
  readonly attentionCount: number;
  readonly highestAttentionReason: AttentionReason | null;
  /** Non-archived descendant count (tooltip footer). */
  readonly total: number;
  readonly breakdown: GraphBreakdown;
  /**
   * The specific sub-threads the popover lists for click-through navigation,
   * highest-priority first. Non-empty only for `attention` (gated nodes) and
   * `deadlocked` (stuck cycle members); empty in watching/settled states where
   * the popover shows the aggregate breakdown instead.
   */
  readonly actionNodes: ReadonlyArray<GraphActionNode>;
}

const ATTENTION_PRIORITY: Record<AttentionReason, number> = {
  error: 6,
  awaiting_approval: 5,
  awaiting_input: 4,
  awaiting_acceptance: 3,
  needs_guidance: 2,
  proposed_plan: 1,
};

/** A live running session/turn — the activity axis, shared with the board. */
export function hasRunningSignal(thread: SidebarThreadSummary): boolean {
  return thread.session?.status === "running" || thread.latestTurn?.state === "running";
}

/**
 * A thread's plan-lane column, ignoring dependencies. The activity axis is NOT
 * folded in here (the design's "describe the plan, not the runtime" rule):
 * `in_progress` is the plan phase, never relabelled "running". The live signal
 * is surfaced separately as the activity overlay.
 */
export function resolveBaseColumn(thread: SidebarThreadSummary): WorkstreamColumnId {
  return thread.planLane;
}

/**
 * The attention reasons a thread carries: the stored set (`error`,
 * `awaiting_acceptance`, `needs_guidance`) unioned with the derived gates
 * (open approval/input requests, an actionable proposed plan). Highest-priority
 * first.
 */
export function attentionReasonsOf(thread: SidebarThreadSummary): ReadonlyArray<AttentionReason> {
  const reasons: AttentionReason[] = [...thread.attention];
  if (thread.hasPendingApprovals && !reasons.includes("awaiting_approval"))
    reasons.push("awaiting_approval");
  if (thread.hasPendingUserInput && !reasons.includes("awaiting_input"))
    reasons.push("awaiting_input");
  if (thread.hasActionableProposedPlan && !reasons.includes("proposed_plan"))
    reasons.push("proposed_plan");
  return reasons.sort((a, b) => ATTENTION_PRIORITY[b] - ATTENTION_PRIORITY[a]);
}

/** The single highest-priority attention reason on a thread, or `null`. */
export function highestAttentionReasonOf(thread: SidebarThreadSummary): AttentionReason | null {
  return attentionReasonsOf(thread)[0] ?? null;
}

/** A genuinely-executing worker — counted in the headline AND gates the `active` state. */
const isActiveWorker = (t: SidebarThreadSummary): boolean => hasRunningSignal(t);

/**
 * Liveness for the STATE gate is slightly broader than the count: a `starting`
 * session is a worker spinning up. Counting it as live keeps the row from
 * flashing idle/deadlocked/needs-you during a reconnect or restart.
 */
const isLive = (t: SidebarThreadSummary): boolean =>
  isActiveWorker(t) || t.session?.status === "starting";

const isPlanTerminal = (t: SidebarThreadSummary): boolean =>
  t.planLane === "done" || t.planLane === "cancelled";

/**
 * Collapse an orchestrator's whole descendant DAG into THREE independent
 * projections (design §5): plan (done vs incomplete), activity (any executing),
 * and attention (any needs-a-human). `graphState` is a representative summary
 * for the single sidebar badge glyph; the board renders the three axes
 * separately so e.g. a re-engaged `done` subtree reads done+active at once.
 * Liveness anywhere dominates the badge glyph: a node waiting on a *running*
 * blocker keeps the graph `active`, never `blocked`.
 */
export function rollupGraphState(
  descendants: ReadonlyArray<SidebarThreadSummary>,
  byId: ReadonlyMap<ThreadId, SidebarThreadSummary>,
): GraphRollup {
  const nodes = descendants.filter((t) => t.archivedAt == null);

  const activeWorkerCount = nodes.filter(isActiveWorker).length;
  const breakdown: GraphBreakdown = {
    running: activeWorkerCount,
    awaitingApproval: nodes.filter((t) => t.hasPendingApprovals).length,
    inReview: nodes.filter((t) => t.attention.includes("awaiting_acceptance")).length,
    planned: nodes.filter((t) => t.planLane === "planned" || t.planLane === "ready").length,
    done: nodes.filter(isPlanTerminal).length,
  };

  const gatedNodes = nodes
    .map((t) => ({ thread: t, reason: highestAttentionReasonOf(t) }))
    .filter(
      (x): x is { thread: SidebarThreadSummary; reason: AttentionReason } => x.reason !== null,
    )
    .sort((a, b) => ATTENTION_PRIORITY[b.reason] - ATTENTION_PRIORITY[a.reason]);
  const highestAttentionReason = gatedNodes[0]?.reason ?? null;
  const attentionActionNodes: ReadonlyArray<GraphActionNode> = gatedNodes.map(
    ({ thread, reason }) => ({
      id: thread.id,
      environmentId: thread.environmentId,
      title: thread.title,
      reason,
    }),
  );

  const base = {
    activeWorkerCount,
    attentionCount: gatedNodes.length,
    total: nodes.length,
    breakdown,
    actionNodes: [] as ReadonlyArray<GraphActionNode>,
  };

  if (nodes.length === 0) return { graphState: "empty", highestAttentionReason: null, ...base };

  // 1. Liveness dominates the badge glyph — the blocked-on-running rule.
  if (nodes.some(isLive)) return { graphState: "active", highestAttentionReason, ...base };

  // 2. Nothing live → any human gate makes the graph "needs you". Surface the
  //    gated sub-threads so the popover can navigate straight to each.
  if (highestAttentionReason !== null)
    return {
      graphState: "attention",
      highestAttentionReason,
      ...base,
      actionNodes: attentionActionNodes,
    };

  // 3. Settled? All intended work is plan-terminal (done/cancelled).
  const incomplete = nodes.filter((t) => !isPlanTerminal(t));
  if (incomplete.length === 0) return { graphState: "done", highestAttentionReason: null, ...base };

  // 4. Deadlock is asserted conservatively: only when EVERY incomplete node is a
  //    *released* `ready` source with no runnable path — a genuine blockedBy
  //    cycle / work that only waits on a cycle. A held `planned` subtree awaiting
  //    release, or a stale `in_progress` node with no live signal, reads as idle,
  //    not a wired deadlock.
  const allReleased = incomplete.every((t) => t.planLane === "ready");
  const hasRunnableSource = incomplete.some(
    (t) => t.planLane === "ready" && areDependenciesSatisfied(t, byId),
  );
  const graphState = allReleased && !hasRunnableSource ? "deadlocked" : "idle";
  return {
    graphState,
    highestAttentionReason: null,
    ...base,
    // Deadlock → the stuck cycle members are the act-targets (re-plan them).
    actionNodes:
      graphState === "deadlocked"
        ? incomplete.map((t) => ({
            id: t.id,
            environmentId: t.environmentId,
            title: t.title,
            reason: null,
          }))
        : [],
  };
}

/**
 * Precompute the workstream rollup for every root thread that actually has
 * descendants, keyed by scoped thread key. Built once per project from the
 * UNFILTERED shell list (which still includes the hidden child threads) so
 * individual rows do not each subscribe to the global shell atom. Roots with no
 * descendants are omitted — their badge would render nothing anyway. Reuses the
 * shared `descendantsOf` lineage walk (cycles broken by its own seen-set); the
 * `createdAt` sort is a presentation concern applied here at the call site.
 */
export function buildGraphRollupByThreadKey(
  threads: readonly SidebarThreadSummary[],
): Map<string, GraphRollup> {
  const byEnvironment = new Map<string, SidebarThreadSummary[]>();
  for (const thread of threads) {
    const existing = byEnvironment.get(thread.environmentId);
    if (existing) existing.push(thread);
    else byEnvironment.set(thread.environmentId, [thread]);
  }
  const rollups = new Map<string, GraphRollup>();
  for (const environmentThreads of byEnvironment.values()) {
    for (const root of environmentThreads) {
      if (root.parentThreadId !== null) continue;
      const descendants = [...descendantsOf(root.id, environmentThreads)].sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      );
      if (descendants.length === 0) continue;
      rollups.set(
        scopedThreadKey(scopeThreadRef(root.environmentId, root.id)),
        rollupGraphState(descendants, new Map(descendants.map((t) => [t.id, t]))),
      );
    }
  }
  return rollups;
}
