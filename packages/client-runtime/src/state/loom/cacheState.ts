import type {
  EnvironmentId,
  LoomCacheShellStreamItem,
  LoomThreadCache,
  ThreadId,
} from "@t3tools/contracts";

/**
 * Live `cache.updated` rows, kept off the shell snapshot (persisted on every write) since they arrive
 * every few minutes per idle thread. The server publishes after the write, so a row is never older
 * than its snapshot; a new authoritative snapshot supersedes them all ({@link clearLoomCacheState}),
 * an enrichment-only one (no threads) does not. Readers prefer the live row to `workstream.cache`.
 */
const rows = new Map<string, LoomThreadCache>();
const listeners = new Map<string, Set<() => void>>();

export const cacheStateKey = (environmentId: EnvironmentId, threadId: ThreadId) =>
  `${environmentId}\u0000${threadId}`;

const notify = (key: string) => {
  for (const listener of listeners.get(key) ?? []) listener();
};

export function applyLoomCacheUpdate(
  environmentId: EnvironmentId,
  { threadId, cache }: LoomCacheShellStreamItem,
): void {
  const key = cacheStateKey(environmentId, threadId);
  rows.set(key, cache);
  notify(key);
}

/** A fresh authoritative snapshot carries every row as persisted: drop the environment's live rows. */
export function clearLoomCacheState(environmentId: EnvironmentId): void {
  const prefix = `${environmentId}\u0000`;
  for (const key of [...rows.keys()].filter((key) => key.startsWith(prefix))) {
    rows.delete(key);
    notify(key);
  }
}

export const getCacheState = (key: string): LoomThreadCache | null => rows.get(key) ?? null;

export function subscribeCacheState(key: string, listener: () => void): () => void {
  const set = listeners.get(key) ?? new Set();
  listeners.set(key, set.add(listener));
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}
