// loom: the thread lists show only root threads; workstream sub-threads (non-null
// parentThreadId) stay hidden and surface through the orchestrator row's
// WorkstreamGraphIndicator badge instead.
export function filterRootThreads<T extends { parentThreadId: string | null }>(
  shells: readonly T[],
): T[] {
  return shells.filter((thread) => thread.parentThreadId === null);
}
