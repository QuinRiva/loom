import {
  FILESYSTEM_METADATA_BATCH_LIMIT,
  type EnvironmentId,
  type FilesystemEntryMetadata,
} from "@t3tools/contracts";
import { executeAtomQuery, runAtomCommand } from "@t3tools/client-runtime/state/runtime";

import { createBatchedLookupStore } from "~/loom/batchedLookupStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";

/**
 * Only regular, readable files and directories are ever `exists: true`. FIFOs, sockets and
 * devices (kind `other`) and missing or unreadable files (null metadata) stay inert, so no
 * chip can click into a read error.
 */
export interface PathExistence {
  readonly exists: boolean;
  readonly isDirectory: boolean;
}

/** Metadata per path, null when missing or unreadable; a path left out is unverified. */
type MetadataFetcher = (
  environmentId: EnvironmentId,
  paths: string[],
) => Promise<ReadonlyMap<string, FilesystemEntryMetadata | null>>;

// getMetadata's per-path cap; a longer path stays unverified, as for the chip icon.
const MAX_PATH_LENGTH = 512;

/**
 * Reads through upstream's per-path file-metadata cache — the one each chip's
 * own icon fills — so verifying a chip costs no lookup of its own once the icon
 * has one. Concurrent per-path reads share upstream's batched
 * `filesystem.getMetadata` requests.
 */
async function defaultMetadataFetcher(
  environmentId: EnvironmentId,
  paths: string[],
): ReturnType<MetadataFetcher> {
  const entries = await Promise.all(
    paths
      .filter((path) => path.length <= MAX_PATH_LENGTH)
      .map(async (path) => {
        const result = await executeAtomQuery(
          appAtomRegistry,
          projectEnvironment.fileMetadata({ environmentId, input: { path } }),
          // The query atom only re-reads when its node recomputes, and
          // re-mounting a computed node does neither, so revalidation would
          // re-read its first answer forever. Freshness is the store's job (TTL,
          // coalescing, backoff); the metadata cache's own staleness still holds.
          { refresh: true, reportDefect: false, reportFailure: false },
        );
        // A failure is left out, which the store treats as unverified → backoff.
        return result._tag === "Success" ? [[path, result.value] as const] : [];
      }),
  );
  return new Map(entries.flat());
}

/** Drops the cached metadata for a path so the next read asks the server. */
const defaultInvalidate = (environmentId: EnvironmentId, path: string) =>
  runAtomCommand(
    appAtomRegistry,
    projectEnvironment.invalidateFileMetadata,
    { environmentId, input: { paths: [path] } },
    { reportDefect: false, reportFailure: false },
  );
let invalidate: (environmentId: EnvironmentId, path: string) => Promise<unknown> =
  defaultInvalidate;

// Only files and directories are clickable; `other` and null render inert.
const existenceFor = (metadata: FilesystemEntryMetadata | null): PathExistence => ({
  exists: metadata?.kind === "file" || metadata?.kind === "directory",
  isDirectory: metadata?.kind === "directory",
});

const toStoreFetcher =
  (fetchMetadata: MetadataFetcher) => async (environmentId: EnvironmentId, paths: string[]) =>
    new Map(
      [...(await fetchMetadata(environmentId, paths))].map(([path, metadata]) => [
        path,
        existenceFor(metadata),
      ]),
    );

/** Batched, TTL-revalidated existence for absolute paths; see `createBatchedLookupStore`. */
const store = createBatchedLookupStore<PathExistence>({
  fetch: toStoreFetcher(defaultMetadataFetcher),
  batchMax: FILESYSTEM_METADATA_BATCH_LIMIT,
});

/**
 * Register mounted interest in a set of absolute paths and start keeping them
 * verified/fresh. Returns an unregister function. Exposed for tests to drive
 * the lifecycle without React.
 */
export const registerPathInterest = store.register;

/**
 * Re-check a known path from the server soon. This is how a chip the server
 * once called missing gets back: background revalidation is bounded by the TTL
 * and the metadata cache, and a human who doubts a "missing?" chip hovers it.
 */
export function revalidatePathExistence(environmentId: EnvironmentId, path: string): void {
  void invalidate(environmentId, path).then(() => store.revalidate(environmentId, path));
}

/**
 * Check one path with the server right now, bypassing the TTL and the metadata
 * cache. A chip rendered while its file existed keeps looking live after the
 * file moves, so a click re-verifies through here first. A failed RPC resolves
 * to the last-known value, so an unhealthy check never blocks an open.
 */
export async function refreshPathExistence(
  environmentId: EnvironmentId,
  path: string,
): Promise<PathExistence | undefined> {
  await invalidate(environmentId, path);
  return store.refresh(environmentId, path);
}

/** Read the last-known existence for a path, or undefined if unverified. */
export const readPathExistence = store.read;

/**
 * Resolve existence for a set of absolute candidate paths. The lookup yields
 * `undefined` while a path is unverified (render it inertly, never as a dead
 * link). When `environmentId` is null nothing is verified and the lookup always
 * returns `undefined`.
 */
export const usePathExistence = store.useLookup;

/** Test-only: override the metadata fetcher (and skip cache invalidation) and reset all module state. */
export function __setMetadataFetcherForTests(fetcher: MetadataFetcher | null): void {
  invalidate = fetcher ? () => Promise.resolve() : defaultInvalidate;
  store.resetForTests(fetcher ? toStoreFetcher(fetcher) : null);
}
