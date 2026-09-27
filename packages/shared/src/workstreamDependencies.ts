import type {
  ThreadFanInState,
  ThreadId,
  ThreadIsolation,
  ThreadPlanLane,
  WorkstreamRoute,
} from "@t3tools/contracts";
import {
  isMemberOfUnresolvedGate,
  isTerminalLane,
  unresolvedGateSourcesOf,
} from "./workstreamGraph.ts";

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
 *
 * An **attached** *dependency* (the mirror case: a downstream thread gated on a
 * gated reviewer — the wiring the review-gate guidance recommends) never fans in
 * itself; the merged output the dependent must branch from belongs to the
 * coder(s) that reviewer gates, whose fan-in fires only at gate resolution —
 * asynchronously *after* the reviewer's `done`. So the dependent waits for those
 * coders' fan-in, not the reviewer's `done` alone. Without this, the dispatcher
 * provisions the dependent's worktree off the pre-merge parent branch before the
 * coder's merge lands — the fan-in propagation gap.
 */
export const areDependenciesSatisfied = <T extends DependencyGateThread>(
  thread: T,
  threadsById: ReadonlyMap<ThreadId, T>,
): boolean => describeUnsatisfiedDependency(thread, threadsById) === null;

/**
 * Single source of truth for the dependency gate, returning the *reason* the
 * first blocking dependency is unsatisfied (or `null` when all are satisfied —
 * so `areDependenciesSatisfied` is exactly `describeUnsatisfiedDependency(...)
 * === null`). The reason names the real blocker, including the two-hops-away
 * case a dependent never sees directly: an attached reviewer that is itself
 * `done` but still gates an isolated coder whose fan-in has not landed. Used by
 * the `thread.turn.start` invariant so a fan-in-blocked dependent's rejection
 * says *which* coder's fan-in (and its state) is holding it, instead of the
 * misleading "until every dependency is done" when the deps genuinely are done.
 */
export const describeUnsatisfiedDependency = <T extends DependencyGateThread>(
  thread: T,
  threadsById: ReadonlyMap<ThreadId, T>,
): string | null => {
  for (const depId of thread.blockedBy) {
    if (depId === thread.id) continue;
    const dep = threadsById.get(depId);
    if (dep === undefined || dep.parentThreadId !== thread.parentThreadId) continue;
    if (dep.planLane !== "done")
      return `dependency '${depId}' is not done yet (lane: ${dep.planLane})`;
    if (thread.isolation === "attached") continue;
    if (dep.isolation === "attached") {
      for (const gatedId of dep.blockedBy) {
        const gated = threadsById.get(gatedId);
        if (
          gated !== undefined &&
          gated.parentThreadId === dep.parentThreadId &&
          gated.isolation === "isolated" &&
          gated.fanInState !== "completed"
        )
          return `reviewer '${depId}' is done, but the coder '${gatedId}' it gates has not completed fan-in (fanInState: ${gated.fanInState})`;
      }
      continue;
    }
    if (waitsForFanIn(thread, dep))
      return `dependency '${depId}' is done, but its fan-in has not completed (fanInState: ${dep.fanInState})`;
  }
  return null;
};

/**
 * Does `thread` wait on `dep`'s fan-in, not just its `done`? The fan-in clause
 * of `describeUnsatisfiedDependency`: every dependent except an attached one
 * (a gated reviewer) waits for an isolated dependency's clean fan-in.
 */
export const waitsForFanIn = (
  thread: Pick<DependencyGateThread, "isolation">,
  dep: Pick<DependencyGateThread, "isolation" | "fanInState">,
): boolean =>
  thread.isolation !== "attached" && dep.isolation === "isolated" && dep.fanInState !== "completed";

/** A dependency-gate node that also carries its gate routes. */
export interface GatedDependencyThread extends DependencyGateThread {
  readonly routes: ReadonlyArray<WorkstreamRoute>;
}

/** One implicit edge: `from` waits on `via`'s fan-in, which waits on reviewer `to`. */
export interface ImplicitGateEdge {
  readonly from: ThreadId;
  readonly to: ThreadId;
  readonly via: ThreadId;
}

/**
 * The implicit "fan-in waits for gate resolution" edges (issue #280). A gated
 * isolated target fans in exactly once, when its review gate resolves, and a
 * dependent that waits on that fan-in therefore waits on the target's reviewer
 * too. `blockedBy` never said so, so the cycle check could not see a reviewer
 * that (transitively) waits on that dependent, and the graph deadlocked
 * silently. The authoring paths add these edges to `blockedBy` explicitly.
 *
 * Returns one edge per un-started (`planned`/`ready`) thread × fan-in dependency
 * × unresolved gate source not already in its `blockedBy`. Mirrors exactly the
 * sibling scoping of `describeUnsatisfiedDependency`, its fan-in clause
 * (`waitsForFanIn`) and the reactor's gate skip (`unresolvedGateSourcesOf`).
 */
export const implicitGateEdges = (
  threads: ReadonlyArray<GatedDependencyThread>,
): ReadonlyArray<ImplicitGateEdge> => {
  const byId = new Map(threads.map((thread) => [thread.id, thread] as const));
  return threads.flatMap((thread) =>
    thread.planLane !== "planned" && thread.planLane !== "ready"
      ? []
      : thread.blockedBy.flatMap((viaId) => {
          const via = byId.get(viaId);
          if (
            via === undefined ||
            via.parentThreadId !== thread.parentThreadId ||
            !waitsForFanIn(thread, via)
          )
            return [];
          return unresolvedGateSourcesOf(viaId, threads)
            .filter(
              (source) =>
                source.id !== thread.id &&
                source.parentThreadId === thread.parentThreadId &&
                !thread.blockedBy.includes(source.id),
            )
            .map((source) => ({ from: thread.id, to: source.id, via: viaId }));
        }),
  );
};

/**
 * The deadlocked members of a node set (a subtree's descendants, or one parent's
 * children), or `null`. Asserted conservatively: every incomplete node is a
 * released `ready` node with unsatisfied dependencies, and no `done` isolated
 * node outside an unresolved gate still owes a completed fan-in. Such a fan-in
 * is either still due (the reactor lands it on its own) or settled
 * `conflicted`/`failed` — stuck, but not a graph deadlock: the fan-in rails own
 * that notice, and the way out is resolving the merge, not re-planning. A held
 * `planned` node or an `in_progress` one means "idle", not deadlocked. The
 * single source for the web rollup's "Deadlocked" badge and the dispatcher's
 * deadlock notice.
 */
export const deadlockedNodes = <T extends GatedDependencyThread>(
  nodes: ReadonlyArray<T>,
  threadsById: ReadonlyMap<ThreadId, T>,
): ReadonlyArray<T> | null => {
  const incomplete = nodes.filter((node) => !isTerminalLane(node.planLane));
  return incomplete.length > 0 &&
    incomplete.every(
      (node) => node.planLane === "ready" && !areDependenciesSatisfied(node, threadsById),
    ) &&
    !nodes.some(
      (node) =>
        node.planLane === "done" &&
        node.isolation === "isolated" &&
        node.fanInState !== "completed" &&
        !isMemberOfUnresolvedGate(node, nodes),
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
      dep.planLane === "cancelled"
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
