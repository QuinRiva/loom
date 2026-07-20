/**
 * Pure ordered-tab-list helpers shared by tabbed surfaces.
 *
 * These encode the close semantics that the right-panel surface list and the
 * centre-panel thread-tab list share: an index-nearest neighbour fallback on
 * close, keep-only (close others), and truncate-after (close to the right).
 * Identity is supplied by the caller via `keyOf`, so the same reducers apply to
 * any ordered list keyed by a string id.
 *
 * `threadTabsStore` consumes these today. Migrating `rightPanelStore`'s
 * `closeSurface`/`closeOtherSurfaces`/`closeSurfacesToRight` onto them is a
 * deliberate follow-up (kept out of this change to keep the diff reviewable).
 */

export interface CloseResult<T> {
  /** The list with the target removed. Same reference when the key was absent. */
  list: T[];
  /**
   * The index-nearest surviving neighbour, i.e. `list[min(index, len - 1)]`
   * after removal. This is what a caller navigates to when the closed item was
   * the active one. `null` when the list emptied or the key was absent.
   */
  fallback: T | null;
}

/**
 * Remove the entry identified by `key`, returning the trimmed list plus the
 * index-nearest neighbour to fall back to. Mirrors `rightPanelStore`'s
 * `surfaces[Math.min(index, surfaces.length - 1)]` close behaviour exactly.
 */
export function closeWithNeighbourFallback<T>(
  list: readonly T[],
  key: string,
  keyOf: (item: T) => string,
): CloseResult<T> {
  const index = list.findIndex((item) => keyOf(item) === key);
  if (index < 0) return { list: list as T[], fallback: null };
  const next = list.filter((_, entryIndex) => entryIndex !== index);
  const fallback = next.length > 0 ? (next[Math.min(index, next.length - 1)] ?? null) : null;
  return { list: next, fallback };
}

/** Keep only the entry identified by `key` (close others). */
export function keepOnly<T>(list: readonly T[], key: string, keyOf: (item: T) => string): T[] {
  const item = list.find((entry) => keyOf(entry) === key);
  return item ? [item] : (list as T[]);
}

/** Keep the entry identified by `key` and everything before it (close to the right). */
export function truncateAfter<T>(list: readonly T[], key: string, keyOf: (item: T) => string): T[] {
  const index = list.findIndex((item) => keyOf(item) === key);
  if (index < 0) return list as T[];
  return list.slice(0, index + 1);
}
