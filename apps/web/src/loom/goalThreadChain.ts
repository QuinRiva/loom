/**
 * loom: serial handoff order for a goal's threads, from `workstream.continuesThreadId`: chain heads
 * by creation, each followed by its successors, with unchained threads interleaved by creation.
 * `forkFromThreadId` is deliberately not a chain edge: a fork diverges from a thread's context and
 * keeps its own place in creation order, rather than claiming a handoff that never happened.
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
 * Order a goal's threads by serial handoff. A thread whose predecessor is absent from `threads`
 * (archived, deleted or in another goal) heads a chain and its successors still follow it. Members
 * of a pure cycle are unreachable from any head, so they are appended in creation order, not dropped.
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
