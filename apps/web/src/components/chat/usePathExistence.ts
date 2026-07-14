import type { EnvironmentId, ProjectPathKind } from "@t3tools/contracts";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useSyncExternalStore } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";

/**
 * Verified existence of a resolved chip target. `exists` gates whether a chip
 * becomes a clickable link at all; `isDirectory` routes directory targets to a
 * non-file click behaviour (Fix 2). Only regular, readable files and
 * directories are ever `exists: true` — FIFOs/sockets/devices and unreadable
 * files (server kind `other`) are inert so no chip can click into a read error.
 */
export interface PathExistence {
  readonly exists: boolean;
  readonly isDirectory: boolean;
}

/**
 * Reactive, cross-component store for path-existence verification.
 *
 * Fetching is driven by a **mounted-path registry + a single shared timer**,
 * not by the React render/version cycle. Each mounted `ChatMarkdown` registers
 * the paths it cares about (ref-counted); the scheduler owns *when* to stat
 * them:
 *   - uncached mounted paths are fetched after a short coalescing window, so a
 *     burst (or a streamed message) collapses into one batched RPC per env;
 *   - a cached result is revalidated once it crosses the TTL, even if the
 *     message just sits there idle (bounded background freshness);
 *   - a failed/partial batch backs off exponentially instead of hot-looping,
 *     and keeps any prior positive result visible meanwhile.
 * Results are exposed through `useSyncExternalStore`, so when any batch resolves
 * every mounted consumer re-renders and re-reads the cache — one in-flight
 * request per key serves all waiters. When there is no connected environment
 * (e.g. the /preview harness) nothing is registered and lookups stay undefined.
 */
const PATH_EXISTENCE_MAX_ENTRIES = 4000;
// Freshness window. Matches the readFile/statPaths query staleness so a chip
// re-verifies on the same cadence rather than trusting a first stat forever.
const PATH_EXISTENCE_TTL_MS = 30_000;
// Coalescing window: due paths accumulate this long before one batched RPC.
const PATH_EXISTENCE_COALESCE_MS = 80;
// Exponential backoff for failed/partial batches, so an unhealthy RPC never
// produces a request storm: ~1s, 2s, 4s, … capped.
const PATH_EXISTENCE_BACKOFF_BASE_MS = 1_000;
const PATH_EXISTENCE_BACKOFF_MAX_MS = 30_000;
// Must not exceed the ProjectStatPathsInput cap (200); larger sets are chunked.
const STAT_BATCH_MAX = 200;

interface PathState {
  readonly environmentId: EnvironmentId;
  readonly path: string;
  existence: PathExistence | undefined;
  fetchedAt: number | undefined;
  inFlight: boolean;
  failureCount: number;
  /** Earliest time a (re)fetch is allowed — enforces backoff after failures. */
  nextEligibleAt: number;
}

const state = new Map<string, PathState>();
// Ref-count of mounted hook consumers interested in each key. Only mounted keys
// are eligible for scheduled (re)fetching.
const mountedRefCounts = new Map<string, number>();

let storeVersion = 0;
const listeners = new Set<() => void>();

let scheduleTimer: ReturnType<typeof setTimeout> | null = null;
let scheduledFireAt = Number.POSITIVE_INFINITY;

function notify(): void {
  storeVersion += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getStoreVersion(): number {
  return storeVersion;
}

function cacheKey(environmentId: EnvironmentId, path: string): string {
  return `${environmentId}\u0000${path}`;
}

function existenceForKind(kind: ProjectPathKind): PathExistence {
  // Only files and directories are clickable; `other` (non-regular or
  // unreadable) and `missing` render inert.
  return {
    exists: kind === "file" || kind === "directory",
    isDirectory: kind === "directory",
  };
}

function pruneState(): void {
  if (state.size <= PATH_EXISTENCE_MAX_ENTRIES) return;
  for (const key of state.keys()) {
    if (state.size <= PATH_EXISTENCE_MAX_ENTRIES) break;
    // Never evict a key a mounted consumer still depends on.
    if (!mountedRefCounts.has(key)) state.delete(key);
  }
}

function ensureState(environmentId: EnvironmentId, path: string): PathState {
  const key = cacheKey(environmentId, path);
  let entry = state.get(key);
  if (!entry) {
    entry = {
      environmentId,
      path,
      existence: undefined,
      fetchedAt: undefined,
      inFlight: false,
      failureCount: 0,
      nextEligibleAt: 0,
    };
    state.set(key, entry);
    pruneState();
  }
  return entry;
}

/** When this key is next due for a (re)fetch, or Infinity if not applicable. */
function dueAt(entry: PathState): number {
  if (entry.inFlight) return Number.POSITIVE_INFINITY;
  if (entry.nextEligibleAt > Date.now()) return entry.nextEligibleAt;
  if (entry.existence !== undefined && entry.fetchedAt !== undefined) {
    return entry.fetchedAt + PATH_EXISTENCE_TTL_MS; // revalidate at the TTL
  }
  return Date.now(); // never fetched (or expired backoff) → due now
}

function reschedule(): void {
  const now = Date.now();
  let earliest = Number.POSITIVE_INFINITY;
  for (const key of mountedRefCounts.keys()) {
    const entry = state.get(key);
    const due = entry ? dueAt(entry) : now;
    if (due < earliest) earliest = due;
  }

  if (earliest === Number.POSITIVE_INFINITY) {
    if (scheduleTimer !== null) {
      clearTimeout(scheduleTimer);
      scheduleTimer = null;
      scheduledFireAt = Number.POSITIVE_INFINITY;
    }
    return;
  }

  // Batch anything due-now over the coalescing window; honour future due times.
  const fireAt = earliest <= now ? now + PATH_EXISTENCE_COALESCE_MS : earliest;
  // Keep an already-scheduled timer if it fires no later than we'd want — avoids
  // continuous re-registration deferring the flush indefinitely.
  if (scheduleTimer !== null && scheduledFireAt <= fireAt) return;
  if (scheduleTimer !== null) clearTimeout(scheduleTimer);
  scheduledFireAt = fireAt;
  scheduleTimer = setTimeout(runDueBatches, Math.max(0, fireAt - now));
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function runDueBatches(): void {
  scheduleTimer = null;
  scheduledFireAt = Number.POSITIVE_INFINITY;
  const now = Date.now();

  const dueByEnv = new Map<EnvironmentId, PathState[]>();
  for (const key of mountedRefCounts.keys()) {
    const entry = state.get(key) ?? ensureState(...splitKey(key));
    if (entry.inFlight) continue;
    if (dueAt(entry) > now) continue;
    entry.inFlight = true;
    const bucket = dueByEnv.get(entry.environmentId);
    if (bucket) bucket.push(entry);
    else dueByEnv.set(entry.environmentId, [entry]);
  }

  for (const [environmentId, entries] of dueByEnv) {
    for (const batch of chunk(entries, STAT_BATCH_MAX)) {
      void fetchBatch(environmentId, batch);
    }
  }

  reschedule();
}

async function fetchBatch(environmentId: EnvironmentId, entries: PathState[]): Promise<void> {
  const paths = entries.map((entry) => entry.path);
  let returned: ReadonlyArray<{ readonly path: string; readonly kind: ProjectPathKind }> = [];
  try {
    returned = await statFetcher(environmentId, paths);
  } finally {
    const now = Date.now();
    const kindByPath = new Map(returned.map((entry) => [entry.path, entry.kind]));
    for (const entry of entries) {
      entry.inFlight = false;
      const kind = kindByPath.get(entry.path);
      if (kind !== undefined) {
        // Success: record the fresh result and clear any backoff.
        entry.existence = existenceForKind(kind);
        entry.fetchedAt = now;
        entry.failureCount = 0;
        entry.nextEligibleAt = 0;
      } else {
        // Failed/partial batch: back off. A prior positive result is kept so a
        // transient failure during revalidation does not flip a chip to inert.
        entry.failureCount += 1;
        const delay = Math.min(
          PATH_EXISTENCE_BACKOFF_BASE_MS * 2 ** (entry.failureCount - 1),
          PATH_EXISTENCE_BACKOFF_MAX_MS,
        );
        entry.nextEligibleAt = now + delay;
      }
    }
    notify();
    reschedule();
  }
}

function splitKey(key: string): [EnvironmentId, string] {
  const separator = key.indexOf("\u0000");
  return [key.slice(0, separator) as EnvironmentId, key.slice(separator + 1)];
}

let statFetcher = defaultStatFetcher;

async function defaultStatFetcher(
  environmentId: EnvironmentId,
  paths: string[],
): Promise<ReadonlyArray<{ readonly path: string; readonly kind: ProjectPathKind }>> {
  const atom = projectEnvironment.statPaths({ environmentId, input: { paths } });
  const result = await executeAtomQuery(appAtomRegistry, atom, {
    reportDefect: false,
    reportFailure: false,
  });
  // A successful RPC returns one entry per requested path; a failure returns [],
  // which fetchBatch treats as "no path resolved" → backoff.
  return result._tag === "Success" ? result.value.entries : [];
}

/**
 * Register mounted interest in a set of absolute paths and start keeping them
 * verified/fresh. Returns an unregister function; call it on unmount so idle
 * paths stop being revalidated. Exposed for tests to drive the lifecycle
 * without React.
 */
export function registerPathInterest(
  environmentId: EnvironmentId,
  paths: Iterable<string>,
): () => void {
  const keys: string[] = [];
  for (const path of paths) {
    const key = cacheKey(environmentId, path);
    keys.push(key);
    ensureState(environmentId, path);
    mountedRefCounts.set(key, (mountedRefCounts.get(key) ?? 0) + 1);
  }
  reschedule();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const key of keys) {
      const count = mountedRefCounts.get(key);
      if (count === undefined) continue;
      if (count <= 1) mountedRefCounts.delete(key);
      else mountedRefCounts.set(key, count - 1);
    }
    reschedule();
  };
}

/** Read the last-known existence for a path, or undefined if unverified. */
export function readPathExistence(
  environmentId: EnvironmentId | null,
  path: string,
): PathExistence | undefined {
  if (!environmentId) return undefined;
  // Return the last-known value even when stale so a confirmed chip does not
  // flicker back to plain code; the scheduler revalidates it in the background.
  return state.get(cacheKey(environmentId, path))?.existence;
}

/**
 * Resolve existence for a set of absolute candidate paths against `environmentId`.
 *
 * Returns a lookup yielding `undefined` while a path is unverified (render it
 * inertly, never as a dead link) and a concrete {@link PathExistence} once
 * known. When `environmentId` is null (e.g. the /preview harness with no
 * backend) no verification runs and the lookup always returns `undefined`.
 */
export function usePathExistence(
  environmentId: EnvironmentId | null,
  paths: readonly string[],
): (path: string) => PathExistence | undefined {
  const version = useSyncExternalStore(subscribe, getStoreVersion, getStoreVersion);
  // Stable dependency across renders that produce an equivalent path set.
  const pathsKey = [...new Set(paths)].sort().join("\n");

  useEffect(() => {
    if (!environmentId) return;
    // Register once per (env, path-set); the scheduler — not this effect — owns
    // refresh timing, so store `version` is deliberately NOT a dependency (that
    // would turn a failed batch's notify() into a tight re-enqueue loop).
    const unregister = registerPathInterest(environmentId, new Set(paths));
    return unregister;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [environmentId, pathsKey]);

  return useCallback(
    (path: string) => readPathExistence(environmentId, path),
    // Re-created on each store update (version bump) so memoised consumers
    // rebuild and re-read the cache, upgrading confirmed paths to chips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [environmentId, version],
  );
}

/** Test-only: override the stat fetcher and reset all module state. */
export function __setStatFetcherForTests(fetcher: typeof statFetcher | null): void {
  statFetcher = fetcher ?? defaultStatFetcher;
  state.clear();
  mountedRefCounts.clear();
  if (scheduleTimer !== null) {
    clearTimeout(scheduleTimer);
    scheduleTimer = null;
  }
  scheduledFireAt = Number.POSITIVE_INFINITY;
  storeVersion = 0;
}
