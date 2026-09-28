import type { EnvironmentId, ProjectPathKind } from "@t3tools/contracts";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";

import { createBatchedLookupStore } from "~/loom/batchedLookupStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";

/**
 * Verified existence of a resolved chip target. `exists` gates whether a chip
 * becomes a clickable link at all; `isDirectory` routes directory targets to a
 * non-file click behaviour. Only regular, readable files and directories are
 * ever `exists: true` — FIFOs/sockets/devices and unreadable files (server kind
 * `other`) are inert so no chip can click into a read error.
 */
export interface PathExistence {
  readonly exists: boolean;
  readonly isDirectory: boolean;
}

type StatFetcher = (
  environmentId: EnvironmentId,
  paths: string[],
) => Promise<ReadonlyArray<{ readonly path: string; readonly kind: ProjectPathKind }>>;

async function defaultStatFetcher(
  environmentId: EnvironmentId,
  paths: string[],
): ReturnType<StatFetcher> {
  const atom = projectEnvironment.statPaths({ environmentId, input: { paths } });
  const result = await executeAtomQuery(appAtomRegistry, atom, {
    // The query atom family caches per (environment, path-set) behind an SWR
    // wrapper that only re-reads when its node recomputes — and re-mounting an
    // already-computed node neither recomputes it nor lets it expire, because
    // each mount cancels the idle-TTL disposal. Without this, every
    // revalidation re-reads the first answer for that path set and a chip
    // stats `missing` once and stays missing until the page reloads. Freshness
    // is the store's job (TTL, coalescing, backoff), so the query cache is
    // deliberately bypassed.
    refresh: true,
    reportDefect: false,
    reportFailure: false,
  });
  // A failure returns [], which the store treats as "no path resolved" → backoff.
  return result._tag === "Success" ? result.value.entries : [];
}

// Only files and directories are clickable; `other` (non-regular or
// unreadable) and `missing` render inert.
const existenceForKind = (kind: ProjectPathKind): PathExistence => ({
  exists: kind === "file" || kind === "directory",
  isDirectory: kind === "directory",
});

const toStoreFetcher =
  (fetchStats: StatFetcher) => async (environmentId: EnvironmentId, paths: string[]) =>
    new Map(
      (await fetchStats(environmentId, paths)).map(({ path, kind }) => [
        path,
        existenceForKind(kind),
      ]),
    );

/** Batched, TTL-revalidated stats for absolute paths; see `createBatchedLookupStore`. */
const store = createBatchedLookupStore<PathExistence>({
  fetch: toStoreFetcher(defaultStatFetcher),
  // Must not exceed the ProjectStatPathsInput cap (200).
  batchMax: 200,
});

/**
 * Register mounted interest in a set of absolute paths and start keeping them
 * verified/fresh. Returns an unregister function. Exposed for tests to drive
 * the lifecycle without React.
 */
export const registerPathInterest = store.register;

/**
 * Mark a known path due for an immediate re-stat. This is how a chip the server
 * once called missing gets back: background revalidation is bounded by the TTL,
 * and a human who doubts a "missing?" chip hovers it.
 */
export const revalidatePathExistence = store.revalidate;

/**
 * Stat one path right now, bypassing the TTL. A chip rendered while its file
 * existed keeps looking live after the file moves, so a click re-verifies
 * through here first. A failed RPC resolves to the last-known value, so an
 * unhealthy stat never blocks an open.
 */
export const refreshPathExistence = store.refresh;

/** Read the last-known existence for a path, or undefined if unverified. */
export const readPathExistence = store.read;

/**
 * Resolve existence for a set of absolute candidate paths. The lookup yields
 * `undefined` while a path is unverified (render it inertly, never as a dead
 * link). When `environmentId` is null (e.g. the /preview harness) nothing is
 * verified and the lookup always returns `undefined`.
 */
export const usePathExistence = store.useLookup;

/** Test-only: override the stat fetcher and reset all module state. */
export function __setStatFetcherForTests(fetcher: StatFetcher | null): void {
  store.resetForTests(fetcher ? toStoreFetcher(fetcher) : null);
}
