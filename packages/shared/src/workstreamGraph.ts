import type { ThreadId, ThreadStatus } from "@t3tools/contracts";

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
export interface GraphThread {
  readonly id: ThreadId;
  readonly parentThreadId: ThreadId | null;
  readonly spawnGeneration: string | null;
  readonly status: ThreadStatus;
  readonly role: string | null;
  readonly title: string | null;
}

interface GraphIndex<T extends GraphThread> {
  readonly byId: ReadonlyMap<ThreadId, T>;
  readonly childrenByParent: ReadonlyMap<ThreadId, ReadonlyArray<T>>;
}

/** Build the adjacency index once (id lookup + parent→children) from a node set. */
const buildIndex = <T extends GraphThread>(threads: ReadonlyArray<T>): GraphIndex<T> => {
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
const rootOf = <T extends GraphThread>(id: ThreadId, index: GraphIndex<T>): ThreadId => {
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
export const childrenOf = <T extends GraphThread>(
  id: ThreadId,
  threads: ReadonlyArray<T>,
): ReadonlyArray<T> => buildIndex(threads).childrenByParent.get(id) ?? [];

const collectDescendants = <T extends GraphThread>(
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
export const descendantsOf = <T extends GraphThread>(
  id: ThreadId,
  threads: ReadonlyArray<T>,
): ReadonlyArray<T> => {
  const out: T[] = [];
  collectDescendants(id, buildIndex(threads), out, new Set([id]));
  return out;
};

/** The node plus all its transitive descendants (the whole subtree rooted at it). */
export const subtreeOf = <T extends GraphThread>(
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
 * Membership predicate that powers same-tree authorization: two threads are in
 * the same workstream iff they share the same root orchestrator. This is the
 * single boundary used by both discovery (`graphViewFor`) and the read/ask tools
 * — least-privilege (one tree, never global) while still including siblings,
 * cousins, ancestors, and descendants within that one orchestration tree.
 *
 * A target absent from the snapshot is never "in tree" (callers distinguish a
 * missing target → 404 from an out-of-tree one → 403 by an existence check).
 */
export const isInSameTree = <T extends GraphThread>(
  callerId: ThreadId,
  targetId: ThreadId,
  threads: ReadonlyArray<T>,
): boolean => {
  if (callerId === targetId) return true;
  const index = buildIndex(threads);
  if (!index.byId.has(targetId)) return false;
  return rootOf(callerId, index) === rootOf(targetId, index);
};

/**
 * A child is "terminal" for the join barrier when it has reached `done`,
 * `blocked`, `review`, or `error`. `planned`/`running` are not.
 *
 * `error` is included for ONE reason only (D-liveness decision 5): barrier
 * unblock — a generation containing an errored child can still *join* once the
 * rest are terminal, so an errored child no longer strands its siblings'
 * results forever. It is NOT the wake mechanism: an errored child among
 * still-running siblings won't fire this barrier, so the parent is woken
 * promptly through the per-child rail in `WorkstreamDispatcher` instead.
 * `error` also does NOT release dependents (that stays done-only in
 * `workstreamDependencies`).
 */
const TERMINAL_STATUSES: ReadonlySet<ThreadStatus> = new Set([
  "done",
  "blocked",
  "review",
  "error",
]);
export const isTerminalStatus = (status: ThreadStatus): boolean => TERMINAL_STATUSES.has(status);

/** The fields the generation join reads — a subset of `GraphThread`. */
type JoinGroupThread = Pick<GraphThread, "parentThreadId" | "spawnGeneration" | "status">;

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
    group.children.every((child) => isTerminalStatus(child.status)),
  );
};

/** The richer node shape the discovery view needs (lineage + report + waits-on). */
export interface GraphViewThread extends GraphThread {
  readonly reportPath: string | null;
  readonly blockedBy: ReadonlyArray<ThreadId>;
}

export interface GraphViewNode {
  readonly id: ThreadId;
  readonly parentThreadId: ThreadId | null;
  readonly role: string | null;
  readonly title: string | null;
  readonly status: ThreadStatus;
  readonly spawnGeneration: string | null;
  readonly hasReport: boolean;
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
    status: thread.status,
    spawnGeneration: thread.spawnGeneration,
    hasReport: thread.reportPath !== null,
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
