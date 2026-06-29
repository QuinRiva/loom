import type { ThreadId, ThreadPlanLane } from "@t3tools/contracts";

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
 */
export const areDependenciesSatisfied = <T extends DependencyGateThread>(
  thread: T,
  threadsById: ReadonlyMap<ThreadId, T>,
): boolean =>
  thread.blockedBy.every((depId) => {
    if (depId === thread.id) return true;
    const dep = threadsById.get(depId);
    if (dep === undefined || dep.parentThreadId !== thread.parentThreadId) return true;
    return dep.planLane === "done";
  });
