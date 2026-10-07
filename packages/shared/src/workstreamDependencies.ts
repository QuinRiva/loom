import type { LoomOutcome, ThreadId } from "@t3tools/contracts";
import { isTerminal } from "./workstreamGraph.ts";

/**
 * Minimal node shape the dependency gate needs; the sidecar record
 * (`LoomThreadWorkstream`, keyed `threadId`) maps onto it with `id`. The same
 * predicate drives the arm's first-turn gate, the dispatcher's promotion and
 * the graph, so they never disagree.
 */
export interface DependencyGateThread {
  readonly id: ThreadId;
  readonly parentThreadId: ThreadId | null;
  readonly blockedBy: ReadonlyArray<ThreadId>;
  readonly outcome: LoomOutcome | null;
}

/**
 * The single "deps satisfied" predicate. A `blockedBy` entry gates execution
 * only when it names a **known sibling** (a thread with the same
 * `parentThreadId`) whose outcome is not yet `done`. `cancelled` does **not**
 * release (an abandoned dependency keeps its dependents blocked).
 * Self-references, dangling/unknown ids, and non-siblings never gate.
 */
export const areDependenciesSatisfied = <T extends DependencyGateThread>(
  thread: T,
  threadsById: ReadonlyMap<ThreadId, T>,
): boolean => describeUnsatisfiedDependency(thread, threadsById) === null;

/**
 * The reason the first blocking dependency is unsatisfied, or `null` when all
 * are satisfied — so `areDependenciesSatisfied` is exactly
 * `describeUnsatisfiedDependency(...) === null`. Used by the first-turn
 * dependency gate's rejection message.
 */
export const describeUnsatisfiedDependency = <T extends DependencyGateThread>(
  thread: T,
  threadsById: ReadonlyMap<ThreadId, T>,
): string | null => {
  for (const depId of thread.blockedBy) {
    if (depId === thread.id) continue;
    const dep = threadsById.get(depId);
    if (dep === undefined || dep.parentThreadId !== thread.parentThreadId) continue;
    if (dep.outcome !== "done")
      return `dependency '${depId}' is ${dep.outcome === "cancelled" ? "cancelled" : "not done yet"}`;
  }
  return null;
};

/** A dependency-gate node that also carries the start-state the deadlock check reads. */
export interface StartStateDependencyThread extends DependencyGateThread {
  readonly held: boolean;
  readonly kickoffAt: string | null;
}

/**
 * The deadlocked members of a node set (a subtree's descendants, or one
 * parent's children), or `null`. Asserted conservatively: every incomplete node
 * is released (not held), not yet started, and has unsatisfied dependencies. A
 * held node or a started one means "idle", not deadlocked. The single source
 * for the web rollup's "Deadlocked" badge and the dispatcher's deadlock notice.
 */
export const deadlockedNodes = <T extends StartStateDependencyThread>(
  nodes: ReadonlyArray<T>,
  threadsById: ReadonlyMap<ThreadId, T>,
): ReadonlyArray<T> | null => {
  const incomplete = nodes.filter((node) => !isTerminal(node.outcome));
  return incomplete.length > 0 &&
    incomplete.every(
      (node) =>
        !node.held && node.kickoffAt === null && !areDependenciesSatisfied(node, threadsById),
    )
    ? incomplete
    : null;
};

/**
 * The first same-parent `cancelled` dependency in `thread.blockedBy`, or null.
 * A cancelled dependency never releases, so an un-started thread gated on one is
 * wedged: the control plane raises `needs_guidance` on it (cancel cascade and
 * `dependencies.set`), and clears that flag once a re-point removes the cause.
 */
export const cancelledDependencyOf = <T extends DependencyGateThread>(
  thread: Pick<T, "id" | "parentThreadId" | "blockedBy">,
  threadsById: ReadonlyMap<ThreadId, T>,
): ThreadId | null =>
  thread.blockedBy.find((depId) => {
    const dep = threadsById.get(depId);
    return (
      depId !== thread.id &&
      dep?.parentThreadId === thread.parentThreadId &&
      dep.outcome === "cancelled"
    );
  }) ?? null;

/**
 * Detects a dependency cycle across the same sibling-scoped edges that can
 * actually gate execution. Unknown ids, self-references, and cross-parent ids
 * are ignored to match `areDependenciesSatisfied` exactly.
 */
export const findDependencyCycle = (
  threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly parentThreadId: ThreadId | null;
    readonly blockedBy: ReadonlyArray<ThreadId>;
  }>,
): ReadonlyArray<ThreadId> | null => {
  const byId = new Map(threads.map((thread) => [thread.id, thread] as const));
  const visiting = new Map<ThreadId, number>();
  const visited = new Set<ThreadId>();
  const stack: Array<ThreadId> = [];

  const visit = (thread: (typeof threads)[number]): ReadonlyArray<ThreadId> | null => {
    if (visited.has(thread.id)) return null;
    const index = visiting.get(thread.id);
    if (index !== undefined) return [...stack.slice(index), thread.id];

    visiting.set(thread.id, stack.length);
    stack.push(thread.id);
    for (const depId of thread.blockedBy) {
      const dep = byId.get(depId);
      if (
        depId !== thread.id &&
        dep !== undefined &&
        dep.parentThreadId === thread.parentThreadId
      ) {
        const cycle = visit(dep);
        if (cycle !== null) return cycle;
      }
    }
    stack.pop();
    visiting.delete(thread.id);
    visited.add(thread.id);
    return null;
  };

  for (const thread of threads) {
    const cycle = visit(thread);
    if (cycle !== null) return cycle;
  }
  return null;
};
