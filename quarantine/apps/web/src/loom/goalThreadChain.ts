/**
 * loom: serial handoff order for a goal's threads.
 *
 * `goal_continue` stamps `continuesThreadId` on the successor (migration 1035),
 * which makes "this goal's threads, in the order the work actually flowed"
 * answerable from stored data rather than from prose inside a brief. This module
 * is the walk: chain heads first (ordered by creation), each head followed
 * immediately by its successors, and threads that are on no chain interleaved by
 * creation time.
 *
 * Deliberately NOT part of the chain: `forkFromThreadId`. A fork is divergence
 * from a thread's context, not a continuation of its work — a fork keeps its own
 * place in creation order, and treating it as a chain edge would claim a serial
 * handoff that never happened.
 */

export interface GoalChainThread {
  readonly id: string;
  /** Predecessor on the same goal, or null when this thread starts a chain. */
  readonly continuesThreadId: string | null;
  readonly createdAt: string;
}

export interface GoalThreadChainEntry<T> {
  readonly thread: T;
  /** True when this thread continues a predecessor that is also in this set. */
  readonly isContinuation: boolean;
}

/** Creation order, id as the final tie-break so the walk is deterministic. */
const byCreation = <T extends GoalChainThread>(left: T, right: T): number =>
  left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);

/**
 * Order a goal's threads by serial handoff. A thread whose `continuesThreadId`
 * is absent from `threads` (predecessor archived, deleted, or in another goal)
 * is treated as a chain head — its successors still follow it. Cycles are broken
 * by the visited set: members of a pure cycle are unreachable from any head and
 * are appended in creation order rather than dropped.
 */
export function orderGoalThreadsByHandoff<T extends GoalChainThread>(
  threads: readonly T[],
): GoalThreadChainEntry<T>[] {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const hasPredecessor = (thread: T): boolean =>
    thread.continuesThreadId !== null &&
    thread.continuesThreadId !== thread.id &&
    byId.has(thread.continuesThreadId);

  const successors = new Map<string, T[]>();
  for (const thread of threads) {
    if (!hasPredecessor(thread)) continue;
    const siblings = successors.get(thread.continuesThreadId!);
    if (siblings) siblings.push(thread);
    else successors.set(thread.continuesThreadId!, [thread]);
  }
  for (const siblings of successors.values()) siblings.sort(byCreation);

  const visited = new Set<string>();
  const ordered: GoalThreadChainEntry<T>[] = [];
  const walk = (thread: T): void => {
    if (visited.has(thread.id)) return;
    visited.add(thread.id);
    ordered.push({ thread, isContinuation: hasPredecessor(thread) });
    for (const successor of successors.get(thread.id) ?? []) walk(successor);
  };

  for (const head of threads.filter((thread) => !hasPredecessor(thread)).sort(byCreation)) {
    walk(head);
  }
  // Pure-cycle members: reachable from nothing, so append them rather than lose
  // them from a surface whose job is to show every thread on the goal.
  for (const stranded of threads.filter((thread) => !visited.has(thread.id)).sort(byCreation)) {
    walk(stranded);
  }
  return ordered;
}
