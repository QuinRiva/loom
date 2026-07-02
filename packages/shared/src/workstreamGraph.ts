import type { AttentionReason, ThreadId, ThreadPlanLane } from "@t3tools/contracts";

/**
 * workstreamGraph - the single pure source of truth for the workstream graph:
 * structure (lineage), membership (which threads share one orchestration tree),
 * and the generation join the dispatcher uses to wake a parent.
 *
 * Mirrors the `workstreamDependencies` precedent: a minimal structural node
 * shape both the read-model thread (`OrchestrationThread`) and the shell summary
 * (`OrchestrationThreadShell`) satisfy, plus pure predicates consumed by every
 * graph walker (dispatcher join, same-tree auth, discovery view) so they can
 * never disagree. No I/O.
 *
 * @module workstreamGraph
 */

/**
 * Minimal structural node shape. Both `OrchestrationThread` and
 * `OrchestrationThreadShell` satisfy it. Lineage (`parentThreadId`) is the only
 * edge needed for structure + membership; generation grouping reads
 * `spawnGeneration`/`status`.
 */
export interface GraphThread extends GraphLineageNode {
  readonly spawnGeneration: string | null;
  readonly planLane: ThreadPlanLane;
  readonly attention: ReadonlyArray<AttentionReason>;
  readonly role: string | null;
  readonly title: string | null;
}

/**
 * The minimal lineage shape the structural walkers (root/descendants/subtree)
 * actually read: an id and its parent edge. Both the full `GraphThread` and the
 * leaner cost-rollup node satisfy it, so the same index/walk serves both.
 */
export interface GraphLineageNode {
  readonly id: ThreadId;
  readonly parentThreadId: ThreadId | null;
}

interface GraphIndex<T extends GraphLineageNode> {
  readonly byId: ReadonlyMap<ThreadId, T>;
  readonly childrenByParent: ReadonlyMap<ThreadId, ReadonlyArray<T>>;
}

/** Build the adjacency index once (id lookup + parent→children) from a node set. */
const buildIndex = <T extends GraphLineageNode>(threads: ReadonlyArray<T>): GraphIndex<T> => {
  const byId = new Map<ThreadId, T>();
  const childrenByParent = new Map<ThreadId, T[]>();
  for (const thread of threads) {
    byId.set(thread.id, thread);
    if (thread.parentThreadId !== null) {
      const siblings = childrenByParent.get(thread.parentThreadId);
      if (siblings) siblings.push(thread);
      else childrenByParent.set(thread.parentThreadId, [thread]);
    }
  }
  return { byId, childrenByParent };
};

/**
 * Walk ancestors to the root orchestrator. The root is the first node reached
 * with `parentThreadId === null` (a top-level thread). A node whose parent is
 * unknown (dangling/out-of-snapshot) is its own subtree root; a cycle is broken
 * by a visited guard, returning the id where the walk re-enters itself.
 */
const rootOf = <T extends GraphLineageNode>(id: ThreadId, index: GraphIndex<T>): ThreadId => {
  const seen = new Set<ThreadId>();
  let current = id;
  for (;;) {
    if (seen.has(current)) return current;
    seen.add(current);
    const node = index.byId.get(current);
    if (node === undefined || node.parentThreadId === null) return current;
    current = node.parentThreadId;
  }
};

/** Direct children of a node (empty when it has none / is unknown). */
export const childrenOf = <T extends GraphLineageNode>(
  id: ThreadId,
  threads: ReadonlyArray<T>,
): ReadonlyArray<T> => buildIndex(threads).childrenByParent.get(id) ?? [];

const collectDescendants = <T extends GraphLineageNode>(
  id: ThreadId,
  index: GraphIndex<T>,
  out: T[],
  seen: Set<ThreadId>,
): void => {
  for (const child of index.childrenByParent.get(id) ?? []) {
    if (seen.has(child.id)) continue;
    seen.add(child.id);
    out.push(child);
    collectDescendants(child.id, index, out, seen);
  }
};

/** All transitive descendants of a node (excludes the node itself). */
export const descendantsOf = <T extends GraphLineageNode>(
  id: ThreadId,
  threads: ReadonlyArray<T>,
): ReadonlyArray<T> => {
  const out: T[] = [];
  collectDescendants(id, buildIndex(threads), out, new Set([id]));
  return out;
};

/** The node plus all its transitive descendants (the whole subtree rooted at it). */
export const subtreeOf = <T extends GraphLineageNode>(
  id: ThreadId,
  threads: ReadonlyArray<T>,
): ReadonlyArray<T> => {
  const index = buildIndex(threads);
  const node = index.byId.get(id);
  const out: T[] = node ? [node] : [];
  collectDescendants(id, index, out, new Set([id]));
  return out;
};

/**
 * A lineage node that also carries its own cumulative dollar cost — the input to
 * the context cost meter's subtree rollup. `cumulativeCostUsd` is each thread's
 * OWN spend; null/absent counts as 0 (e.g. providers that report no cost).
 */
export interface CostGraphNode extends GraphLineageNode {
  readonly cumulativeCostUsd?: number | null | undefined;
}

/**
 * Total cost of the whole subtree rooted at `id` (the node plus all transitive
 * descendants), summing each node's own `cumulativeCostUsd`. Pure; reuses the
 * same lineage walk as `subtreeOf`, so a thread sitting at the orchestrator root
 * sees its entire workstream's spend.
 */
export const subtreeCostOf = <T extends CostGraphNode>(
  id: ThreadId,
  threads: ReadonlyArray<T>,
): number => subtreeOf(id, threads).reduce((sum, node) => sum + (node.cumulativeCostUsd ?? 0), 0);

/**
 * A child is "terminal" for the join barrier (design §6) ONLY when its plan
 * lane is `done`/`cancelled`. Attention flags and runtime state never count:
 * a flagged, non-executing child (a human stop, `awaiting_acceptance`, a stall
 * escalation) means the generation is PAUSED, not finished — the parent hears
 * about the pause promptly through the per-child notice rail in
 * `WorkstreamDispatcher`, never by firing this barrier. Joining only on genuine
 * plan terminality also keeps the one-shot generation wake from being consumed
 * by a momentary pause, so a resumed child's real completion always wakes the
 * parent. Only `done` releases dependents (that stays done-only in
 * `workstreamDependencies`).
 */
export interface TerminalForJoinNode {
  readonly planLane: ThreadPlanLane;
}

export const isTerminalForJoin = (node: TerminalForJoinNode): boolean =>
  node.planLane === "done" || node.planLane === "cancelled";

/** The fields the generation join reads. */
type JoinGroupThread = {
  readonly parentThreadId: ThreadId | null;
  readonly spawnGeneration: string | null;
} & TerminalForJoinNode;

export interface JoinedGeneration<T> {
  readonly parentId: ThreadId;
  readonly generation: string;
  readonly children: ReadonlyArray<T>;
}

/**
 * Pure generation-join selection: group every sub-thread by
 * (parentThreadId, spawnGeneration) and return the groups in which **every**
 * member is terminal. Generic over the concrete node type so the dispatcher gets
 * back full shells. Generation grouping stays internal — no consumer needs a
 * standalone `groupByGeneration`.
 *
 * Eligibility is a pure function of durable thread state, so it is fully
 * recomputable from the read model after a restart.
 */
export const selectJoinedGenerations = <T extends JoinGroupThread>(
  threads: ReadonlyArray<T>,
): ReadonlyArray<JoinedGeneration<T>> => {
  const groups = new Map<string, { parentId: ThreadId; generation: string; children: T[] }>();
  for (const thread of threads) {
    if (thread.parentThreadId === null || thread.spawnGeneration === null) continue;
    const key = `${thread.parentThreadId}::${thread.spawnGeneration}`;
    const group = groups.get(key);
    if (group) group.children.push(thread);
    else
      groups.set(key, {
        parentId: thread.parentThreadId,
        generation: thread.spawnGeneration,
        children: [thread],
      });
  }
  return [...groups.values()].filter((group) =>
    group.children.every((child) => isTerminalForJoin(child)),
  );
};

/** The richer node shape the discovery view needs (lineage + report + waits-on). */
export interface GraphViewThread extends GraphThread {
  readonly reportPath: string | null;
  readonly blockedBy: ReadonlyArray<ThreadId>;
  /** Projection freshness timestamp — a lightweight liveness signal. */
  readonly lastActivityAt: string | null;
  /** One-line preview of the most recent activity (full detail lives in the jsonl). */
  readonly lastActivitySummary: string | null;
}

export interface GraphViewNode {
  readonly id: ThreadId;
  readonly parentThreadId: ThreadId | null;
  readonly role: string | null;
  readonly title: string | null;
  readonly planLane: ThreadPlanLane;
  readonly attention: ReadonlyArray<AttentionReason>;
  readonly spawnGeneration: string | null;
  readonly hasReport: boolean;
  /** Absolute path to the thread's curated report, or null if none filed. */
  readonly reportPath: string | null;
  /** Absolute path to the thread's pi session jsonl (full history), or null if not yet on disk. */
  readonly sessionPath: string | null;
  /** Projection freshness timestamp — a lightweight liveness signal. */
  readonly lastActivityAt: string | null;
  /** One-line preview of the most recent activity. */
  readonly lastActivitySummary: string | null;
}

export interface GraphEdge {
  readonly from: ThreadId;
  readonly to: ThreadId;
}

export interface GraphView {
  readonly rootId: ThreadId;
  readonly callerId: ThreadId;
  readonly nodes: ReadonlyArray<GraphViewNode>;
  /** Lineage edges, parent → child. */
  readonly lineageEdges: ReadonlyArray<GraphEdge>;
  /** Waits-on edges, blocked thread → dependency (within the tree). */
  readonly waitsOnEdges: ReadonlyArray<GraphEdge>;
}

/**
 * The discovery payload: the caller's whole workstream tree (rooted at the
 * caller's root orchestrator) as nodes + lineage edges + waits-on edges. This is
 * exactly the scope the same-tree auth predicate covers — you can only read/ask
 * what `list` shows you. Lean by construction (no message/activity bodies).
 */
export const graphViewFor = <T extends GraphViewThread>(
  callerId: ThreadId,
  threads: ReadonlyArray<T>,
  sessionPathFor?: (id: ThreadId) => string | null,
): GraphView => {
  const index = buildIndex(threads);
  const rootId = rootOf(callerId, index);
  const members = subtreeOf(rootId, threads);
  const memberIds = new Set(members.map((thread) => thread.id));
  const nodes: GraphViewNode[] = members.map((thread) => ({
    id: thread.id,
    parentThreadId: thread.parentThreadId,
    role: thread.role,
    title: thread.title,
    planLane: thread.planLane,
    attention: thread.attention,
    spawnGeneration: thread.spawnGeneration,
    hasReport: thread.reportPath !== null,
    reportPath: thread.reportPath,
    sessionPath: sessionPathFor ? sessionPathFor(thread.id) : null,
    lastActivityAt: thread.lastActivityAt,
    lastActivitySummary: thread.lastActivitySummary,
  }));
  const lineageEdges = members.flatMap((thread) =>
    thread.parentThreadId !== null && memberIds.has(thread.parentThreadId)
      ? [{ from: thread.parentThreadId, to: thread.id }]
      : [],
  );
  const waitsOnEdges = members.flatMap((thread) =>
    thread.blockedBy.flatMap((depId) =>
      memberIds.has(depId) ? [{ from: thread.id, to: depId }] : [],
    ),
  );
  return { rootId, callerId, nodes, lineageEdges, waitsOnEdges };
};
