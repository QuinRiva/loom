import type { ThreadId } from "@t3tools/contracts";
import {
  childrenOf,
  descendantsOf,
  subtreeCostOf,
  type CostGraphNode,
} from "@t3tools/shared/workstreamGraph";

/** One branch's contribution to the subtree cost (its own subtree total). */
export interface ContextCostChild {
  readonly id: ThreadId;
  readonly title: string;
  readonly costUsd: number;
}

/** The cost figures the context meter shows: this thread's own spend, its whole subtree, and the branch breakdown. */
export interface ContextCostSummary {
  readonly ownCostUsd: number;
  readonly subtreeCostUsd: number;
  readonly hasDescendants: boolean;
  readonly descendantCount: number;
  /** Per-direct-child subtree totals (>0 only), most expensive first. */
  readonly children: ReadonlyArray<ContextCostChild>;
}

/**
 * Roll up the active thread's cost from the workstream graph the client already
 * holds: own spend plus the subtree total (so a root orchestrator shows the
 * whole workstream's spend), with a per-branch breakdown for the meter's
 * popover. Pure; delegates the lineage walk + summation to the shared
 * `subtreeCostOf`, the same one the workstream panel and quick facts use.
 *
 * Walking the graph is not free, so callers memoise this on the threads slice
 * rather than deriving it inside a hot render path.
 */
export function deriveContextCostSummary<T extends CostGraphNode & { readonly title: string }>(
  activeThreadId: ThreadId | null,
  threads: ReadonlyArray<T>,
): ContextCostSummary | null {
  if (activeThreadId === null) {
    return null;
  }
  const descendants = descendantsOf(activeThreadId, threads);
  return {
    ownCostUsd: threads.find((thread) => thread.id === activeThreadId)?.cumulativeCostUsd ?? 0,
    subtreeCostUsd: subtreeCostOf(activeThreadId, threads),
    hasDescendants: descendants.length > 0,
    descendantCount: descendants.length,
    children: childrenOf(activeThreadId, threads)
      .map((child) => ({
        id: child.id,
        title: child.title,
        costUsd: subtreeCostOf(child.id, threads),
      }))
      .filter((child) => child.costUsd > 0)
      .sort((left, right) => right.costUsd - left.costUsd),
  };
}
