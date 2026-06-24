import type { ThreadId, ThreadStatus } from "@t3tools/contracts";
import { areDependenciesSatisfied } from "@t3tools/shared/workstreamDependencies";

import type { SidebarThreadSummary } from "../types";

/** Board column a thread occupies ignoring dependencies (the D1 precedence minus the `blockedBy` step). */
export type WorkstreamColumnId = ThreadStatus;

export type GraphState = "active" | "attention" | "deadlocked" | "idle" | "done" | "empty";
export type AttentionReason = "approval" | "input" | "review" | "blocked" | "plan";

/** Per-state facet counts the tooltip expands the headline number into. */
export interface GraphBreakdown {
  /** Genuinely-executing workers (also the headline `activeWorkerCount`). */
  readonly running: number;
  readonly awaitingApproval: number;
  readonly inReview: number;
  readonly planned: number;
  readonly done: number;
}

export interface GraphRollup {
  readonly graphState: GraphState;
  readonly activeWorkerCount: number;
  /** Nodes parked on a human gate (approval/input/review/blocked/plan) — the `attention` badge number. */
  readonly attentionCount: number;
  readonly highestAttentionReason: AttentionReason | null;
  /** Non-archived descendant count (tooltip footer). */
  readonly total: number;
  readonly breakdown: GraphBreakdown;
}

const ATTENTION_PRIORITY: Record<AttentionReason, number> = {
  approval: 5,
  input: 4,
  review: 3,
  blocked: 2,
  plan: 1,
};

/** A live running session/turn — the single source of truth shared with the board. */
export function hasRunningSignal(thread: SidebarThreadSummary): boolean {
  return thread.session?.status === "running" || thread.latestTurn?.state === "running";
}

/**
 * Dependency-free resolution of a thread's column from its explicit status and
 * live session/turn signals — the D1 precedence with the `blockedBy` step
 * removed. Used both for a thread's own base column and to decide whether a
 * dependency counts as satisfied, keeping the effective-status computation
 * non-recursive and safe against dependency cycles.
 */
export function resolveBaseColumn(thread: SidebarThreadSummary): WorkstreamColumnId {
  if (thread.status === "review" || thread.status === "done") return thread.status;
  if (thread.status === "blocked") return "blocked";
  if (thread.status === "running" || hasRunningSignal(thread)) return "running";
  return "planned";
}

/** A genuinely-executing worker — counted in the headline AND gates the `active` state. */
const isActiveWorker = (t: SidebarThreadSummary): boolean =>
  t.session?.status === "running" || t.latestTurn?.state === "running";

/**
 * Liveness for the STATE gate is slightly broader than the count: a `connecting`
 * session is a worker spinning up. Counting it as live keeps the row from
 * flashing idle/deadlocked/needs-you during a reconnect or restart.
 */
const isLive = (t: SidebarThreadSummary): boolean =>
  isActiveWorker(t) || t.session?.status === "connecting";

/**
 * A node that needs a human before the graph can advance. Order matters only for
 * `highestAttentionReason`; presence (≠ null) is what gates `attention`. Only
 * consulted AFTER the liveness check, so an explicit `blocked` node whose blocker
 * is currently running never reaches here — it is `active`.
 */
const attentionReasonOf = (t: SidebarThreadSummary): AttentionReason | null =>
  t.hasPendingApprovals
    ? "approval"
    : t.hasPendingUserInput
      ? "input"
      : t.status === "review"
        ? "review"
        : t.status === "blocked"
          ? "blocked"
          : t.hasActionableProposedPlan
            ? "plan"
            : null;

/**
 * Collapse an orchestrator's whole descendant DAG into a single graph state plus
 * a live active-worker count. Liveness anywhere dominates local blocked-ness: a
 * node waiting on a *running* blocker keeps the graph `active`, never `blocked`.
 * See docs/design/workstream-graph-state-rollup.md §4 for the precedence ladder.
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
    inReview: nodes.filter((t) => t.status === "review").length,
    planned: nodes.filter((t) => resolveBaseColumn(t) === "planned").length,
    done: nodes.filter((t) => resolveBaseColumn(t) === "done").length,
  };

  const attentionReasons = nodes
    .map(attentionReasonOf)
    .filter((r): r is AttentionReason => r !== null);
  const highestAttentionReason =
    attentionReasons.sort((a, b) => ATTENTION_PRIORITY[b] - ATTENTION_PRIORITY[a])[0] ?? null;

  const base = {
    activeWorkerCount,
    attentionCount: attentionReasons.length,
    total: nodes.length,
    breakdown,
  };

  if (nodes.length === 0) return { graphState: "empty", highestAttentionReason: null, ...base };

  // 1. Liveness dominates — the blocked-on-running rule.
  if (nodes.some(isLive)) return { graphState: "active", highestAttentionReason, ...base };

  // 2. Nothing live → any human gate makes the graph "needs you".
  if (highestAttentionReason !== null)
    return { graphState: "attention", highestAttentionReason, ...base };

  // 3. Settled? (base column — deps are irrelevant once done.)
  const incomplete = nodes.filter((t) => resolveBaseColumn(t) !== "done");
  if (incomplete.length === 0) return { graphState: "done", highestAttentionReason: null, ...base };

  // 4. Deadlock is asserted conservatively: only when EVERY incomplete node is
  //    `planned` and none is runnable (a genuine blockedBy cycle / work that only
  //    waits on a cycle). If any incomplete node is non-planned without a live
  //    signal — a stale/errored `status==="running"` node left after the subtree
  //    quiesced (e.g. a mass disconnect) — the graph is merely idle, not a wired
  //    deadlock. This keeps the rose "no path forward" alarm trustworthy rather
  //    than firing on transient quiescence (§8). Surfacing such errored nodes as
  //    their own signal is the deferred error-handling decision, out of scope here.
  const allPlanned = incomplete.every((t) => resolveBaseColumn(t) === "planned");
  const hasRunnableSource = incomplete.some(
    (t) => resolveBaseColumn(t) === "planned" && areDependenciesSatisfied(t, byId),
  );
  return {
    graphState: allPlanned && !hasRunnableSource ? "deadlocked" : "idle",
    highestAttentionReason: null,
    ...base,
  };
}
