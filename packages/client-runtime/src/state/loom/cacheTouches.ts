import type { EnvironmentId, LoomCacheShellStreamItem, ThreadId } from "@t3tools/contracts";

/**
 * Live cache touches from the shell stream's `cache.touched` items (every real
 * request's end and every pi warming ping, coalesced server-side), held here
 * rather than on the shell snapshot: the snapshot is persisted on every write,
 * and these arrive every few minutes per idle thread. The snapshot's
 * `workstream.cache.touchedAt` seeds a reload; readers take the latest of both.
 */
const touches = new Map<string, string>();
const listeners = new Map<string, Set<() => void>>();

export const cacheTouchKey = (environmentId: EnvironmentId, threadId: ThreadId) =>
  `${environmentId}\u0000${threadId}`;

export function applyLoomCacheTouch(
  environmentId: EnvironmentId,
  { threadId, touchedAt }: LoomCacheShellStreamItem,
): void {
  const key = cacheTouchKey(environmentId, threadId);
  const current = touches.get(key);
  if (current !== undefined && Date.parse(current) >= Date.parse(touchedAt)) return;
  touches.set(key, touchedAt);
  for (const listener of listeners.get(key) ?? []) listener();
}

export const getCacheTouch = (key: string): string | null => touches.get(key) ?? null;

export function subscribeCacheTouch(key: string, listener: () => void): () => void {
  const set = listeners.get(key) ?? new Set();
  listeners.set(key, set.add(listener));
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}
