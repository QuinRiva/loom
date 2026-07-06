import type {
  ThreadFanInState,
  ThreadId,
  ThreadIsolation,
  ThreadPlanLane,
} from "@t3tools/contracts";

/**
 * Minimal thread shape the dependency gate needs. Both the read-model thread
 * (`OrchestrationThread`) and the shell summary (`OrchestrationThreadShell`)
 * satisfy it, so the same predicate drives the decider's first-turn gate and
 * the dispatcher's promote-ready pass.
 */
export interface DependencyGateThread {
  readonly id: ThreadId;
  readonly parentThreadId: ThreadId | null;
  readonly blockedBy: ReadonlyArray<ThreadId>;
  readonly planLane: ThreadPlanLane;
  // Worktree isolation (design §3): an isolated dependency releases dependents
  // only once its branch has fanned in cleanly — `done` alone is not enough.
  readonly isolation: ThreadIsolation;
  readonly fanInState: ThreadFanInState;
}

/**
 * The single "deps satisfied" predicate — the one source of truth for whether a
 * sub-thread may run, consumed by both the command-boundary invariant
 * (`decider.ts`) and the dispatcher's promote-ready pass. Sharing it guarantees
 * board display and execution gating never disagree.
 *
 * A `blockedBy` entry gates execution only when it names a **known sibling** (a
 * thread with the same `parentThreadId`) whose plan lane is not yet `done`.
 * `cancelled` does **not** release (an abandoned dependency keeps its dependents
 * blocked). Self-references, dangling/unknown ids, and non-siblings never gate.
 *
 * An **isolated** dependency additionally requires a settled clean fan-in
 * (`fanInState === "completed"`): `done` marks the child's work finished, but a
 * dependent must branch from a parent tree that already contains the merged
 * output, so it waits until fan-in lands. A `conflicted` fan-in keeps dependents
 * blocked (the merge did not land). Shared/attached deps release on `done` as
 * before.
 *
 * Exception: an **attached** dependent (a gated reviewer) releases on the
 * dependency's `done` alone — it must join the coder's *pre-merge* worktree, and
 * that coder's fan-in is deliberately deferred until gate resolution (which the
 * reviewer itself drives). Requiring fan-in here would deadlock the gate.
 */
export const areDependenciesSatisfied = <T extends DependencyGateThread>(
  thread: T,
  threadsById: ReadonlyMap<ThreadId, T>,
): boolean =>
  thread.blockedBy.every((depId) => {
    if (depId === thread.id) return true;
    const dep = threadsById.get(depId);
    if (dep === undefined || dep.parentThreadId !== thread.parentThreadId) return true;
    if (dep.planLane !== "done") return false;
    if (thread.isolation === "attached") return true;
    return dep.isolation !== "isolated" || dep.fanInState === "completed";
  });

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
