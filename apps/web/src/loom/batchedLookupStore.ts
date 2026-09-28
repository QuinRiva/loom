import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useSyncExternalStore } from "react";

/**
 * Reactive, cross-component store for a per-environment server lookup that is
 * worth batching — chat file chips' path stats and index lookups.
 *
 * Fetching is driven by a **mounted-key registry + a single shared timer**,
 * not by the React render/version cycle. Each mounted consumer registers the
 * keys it cares about (ref-counted); the scheduler owns *when* to fetch them:
 *   - uncached mounted keys are fetched after a short coalescing window, so a
 *     burst (or a streamed message) collapses into one batched RPC per env;
 *   - a cached result is revalidated once it crosses the TTL, even if the
 *     consumer just sits there idle (bounded background freshness);
 *   - a failed/partial batch backs off exponentially instead of hot-looping,
 *     and keeps any prior result visible meanwhile.
 * Results are exposed through `useSyncExternalStore`, so when any batch resolves
 * every mounted consumer re-renders and re-reads the cache — one in-flight
 * request per key serves all waiters. With no connected environment (e.g. the
 * /preview harness) nothing is registered and lookups stay undefined.
 */
const MAX_ENTRIES = 4000;
// Freshness window. Matches the readFile/statPaths query staleness so a chip
// re-verifies on the same cadence rather than trusting a first answer forever.
const TTL_MS = 30_000;
// Coalescing window: due keys accumulate this long before one batched RPC.
const COALESCE_MS = 80;
// Exponential backoff for failed/partial batches, so an unhealthy RPC never
// produces a request storm: ~1s, 2s, 4s, … capped.
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

/** Answers for the keys it resolved; a key left out counts as a failure. */
export type BatchedLookupFetcher<V> = (
  environmentId: EnvironmentId,
  keys: string[],
) => Promise<ReadonlyMap<string, V>>;

interface KeyState {
  readonly environmentId: EnvironmentId;
  readonly key: string;
  fetchedAt: number | undefined;
  inFlight: boolean;
  failureCount: number;
  /** Earliest time a (re)fetch is allowed — enforces backoff after failures. */
  nextEligibleAt: number;
}

export function createBatchedLookupStore<V>(options: {
  fetch: BatchedLookupFetcher<V>;
  /** Largest key set one RPC may carry; larger due sets are chunked. */
  batchMax: number;
}) {
  const state = new Map<string, KeyState>();
  // Ref-count of mounted consumers per key. Only mounted keys are eligible for
  // scheduled (re)fetching.
  const mountedRefCounts = new Map<string, number>();
  const listeners = new Set<() => void>();
  let fetcher = options.fetch;
  // Answers, replaced (never mutated) on every update so it doubles as the
  // `useSyncExternalStore` snapshot: a lookup closing over it genuinely changes
  // when an answer lands, which the React Compiler's memoisation can see.
  let values: ReadonlyMap<string, V> = new Map();
  let scheduleTimer: ReturnType<typeof setTimeout> | null = null;
  let scheduledFireAt = Number.POSITIVE_INFINITY;

  const notify = () => {
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const getValues = () => values;
  const stateKey = (environmentId: EnvironmentId, key: string) => `${environmentId}\u0000${key}`;

  function ensureState(environmentId: EnvironmentId, key: string): KeyState {
    const id = stateKey(environmentId, key);
    let entry = state.get(id);
    if (!entry) {
      entry = {
        environmentId,
        key,
        fetchedAt: undefined,
        inFlight: false,
        failureCount: 0,
        nextEligibleAt: 0,
      };
      state.set(id, entry);
      // Prune, but never evict a key a mounted consumer still depends on.
      for (const candidate of state.keys()) {
        if (state.size <= MAX_ENTRIES) break;
        if (!mountedRefCounts.has(candidate)) state.delete(candidate);
      }
    }
    return entry;
  }

  /** When this key is next due for a (re)fetch, or Infinity if not applicable. */
  function dueAt(entry: KeyState): number {
    if (entry.inFlight) return Number.POSITIVE_INFINITY;
    if (entry.nextEligibleAt > Date.now()) return entry.nextEligibleAt;
    if (entry.fetchedAt !== undefined && values.has(stateKey(entry.environmentId, entry.key))) {
      return entry.fetchedAt + TTL_MS; // revalidate at the TTL
    }
    return Date.now(); // never fetched (or expired backoff) → due now
  }

  function reschedule(): void {
    const now = Date.now();
    let earliest = Number.POSITIVE_INFINITY;
    for (const id of mountedRefCounts.keys()) {
      const entry = state.get(id);
      earliest = Math.min(earliest, entry ? dueAt(entry) : now);
    }
    if (earliest === Number.POSITIVE_INFINITY) {
      if (scheduleTimer !== null) clearTimeout(scheduleTimer);
      scheduleTimer = null;
      scheduledFireAt = Number.POSITIVE_INFINITY;
      return;
    }
    // Batch anything due-now over the coalescing window; honour future due times.
    const fireAt = earliest <= now ? now + COALESCE_MS : earliest;
    // Keep an already-scheduled timer if it fires no later than we'd want — avoids
    // continuous re-registration deferring the flush indefinitely.
    if (scheduleTimer !== null && scheduledFireAt <= fireAt) return;
    if (scheduleTimer !== null) clearTimeout(scheduleTimer);
    scheduledFireAt = fireAt;
    scheduleTimer = setTimeout(runDueBatches, Math.max(0, fireAt - now));
  }

  function runDueBatches(): void {
    scheduleTimer = null;
    scheduledFireAt = Number.POSITIVE_INFINITY;
    const now = Date.now();
    const dueByEnv = new Map<EnvironmentId, KeyState[]>();
    for (const id of mountedRefCounts.keys()) {
      const entry = state.get(id);
      if (!entry || dueAt(entry) > now) continue;
      entry.inFlight = true;
      dueByEnv.set(entry.environmentId, [...(dueByEnv.get(entry.environmentId) ?? []), entry]);
    }
    for (const [environmentId, entries] of dueByEnv) {
      for (let index = 0; index < entries.length; index += options.batchMax) {
        void fetchBatch(environmentId, entries.slice(index, index + options.batchMax));
      }
    }
    reschedule();
  }

  async function fetchBatch(environmentId: EnvironmentId, entries: KeyState[]): Promise<void> {
    let answers: ReadonlyMap<string, V> = new Map();
    try {
      answers = await fetcher(
        environmentId,
        entries.map((entry) => entry.key),
      );
    } finally {
      const now = Date.now();
      // Carry over only answers whose key survived pruning.
      const next = new Map([...values].filter(([id]) => state.has(id)));
      for (const entry of entries) {
        entry.inFlight = false;
        const value = answers.get(entry.key);
        if (value !== undefined) {
          // Success: record the fresh result and clear any backoff.
          next.set(stateKey(environmentId, entry.key), value);
          entry.fetchedAt = now;
          entry.failureCount = 0;
          entry.nextEligibleAt = 0;
        } else {
          // Failed/partial batch: back off. A prior result is kept so a transient
          // failure during revalidation does not flip a chip.
          entry.failureCount += 1;
          entry.nextEligibleAt =
            now + Math.min(BACKOFF_BASE_MS * 2 ** (entry.failureCount - 1), BACKOFF_MAX_MS);
        }
      }
      values = next;
      notify();
      reschedule();
    }
  }

  /**
   * Register mounted interest in a set of keys and start keeping them fresh.
   * Returns an unregister function; call it on unmount so idle keys stop being
   * revalidated.
   */
  function register(environmentId: EnvironmentId, keys: Iterable<string>): () => void {
    const ids: string[] = [];
    for (const key of keys) {
      const id = stateKey(environmentId, key);
      ids.push(id);
      ensureState(environmentId, key);
      mountedRefCounts.set(id, (mountedRefCounts.get(id) ?? 0) + 1);
    }
    reschedule();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const id of ids) {
        const count = mountedRefCounts.get(id);
        if (count === undefined) continue;
        if (count <= 1) mountedRefCounts.delete(id);
        else mountedRefCounts.set(id, count - 1);
      }
      reschedule();
    };
  }

  /**
   * Mark a known key due for an immediate refetch, then let the shared scheduler
   * run it — so a pointer sweep across several chips still costs one batched
   * RPC. The last-known value stays visible until the answer lands.
   */
  function revalidate(environmentId: EnvironmentId, key: string): void {
    const entry = state.get(stateKey(environmentId, key));
    if (entry === undefined || entry.inFlight) return;
    entry.fetchedAt = undefined; // due now
    entry.nextEligibleAt = 0; // and not held back by an earlier failure's backoff
    reschedule();
  }

  /**
   * Fetch one key right now, bypassing the TTL, and publish the result to every
   * mounted consumer. A failed RPC leaves the last-known value in place and
   * resolves to it.
   */
  async function refresh(environmentId: EnvironmentId, key: string): Promise<V | undefined> {
    const entry = ensureState(environmentId, key);
    entry.inFlight = true; // keeps the scheduler from duplicating this fetch
    await fetchBatch(environmentId, [entry]);
    return values.get(stateKey(environmentId, key));
  }

  /** The last-known value, even when stale, or undefined if never answered. */
  function read(environmentId: EnvironmentId | null, key: string): V | undefined {
    return environmentId ? values.get(stateKey(environmentId, key)) : undefined;
  }

  /**
   * Keep `keys` fresh while mounted. The returned lookup yields `undefined`
   * until a key is answered, and changes with every store update so memoised
   * consumers re-read it.
   */
  function useLookup(
    environmentId: EnvironmentId | null,
    keys: readonly string[],
  ): (key: string) => V | undefined {
    const snapshot = useSyncExternalStore(subscribe, getValues, getValues);
    // Stable dependency across renders that produce an equivalent key set.
    const keysKey = [...new Set(keys)].toSorted().join("\u0000");
    useEffect(() => {
      if (!environmentId || keysKey.length === 0) return;
      // Register once per (env, key-set); the scheduler — not this effect — owns
      // refresh timing, so the snapshot is deliberately NOT a dependency (that
      // would turn a failed batch's notify() into a tight re-enqueue loop).
      return register(environmentId, keysKey.split("\u0000"));
    }, [environmentId, keysKey]);
    return useCallback(
      (key: string) => (environmentId ? snapshot.get(stateKey(environmentId, key)) : undefined),
      [environmentId, snapshot],
    );
  }

  /** Test-only: override the fetcher and reset all state. */
  function resetForTests(override: BatchedLookupFetcher<V> | null): void {
    fetcher = override ?? options.fetch;
    state.clear();
    mountedRefCounts.clear();
    if (scheduleTimer !== null) clearTimeout(scheduleTimer);
    scheduleTimer = null;
    scheduledFireAt = Number.POSITIVE_INFINITY;
    values = new Map();
  }

  return { register, revalidate, refresh, read, useLookup, resetForTests };
}
