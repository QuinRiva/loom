// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";

import type { ThreadId } from "@t3tools/contracts";

/**
 * workstreamPromptDebug — path scheme for the per-thread effective-prompt debug
 * sidecar (debugging-only surface).
 *
 * The pi capture extension writes the fully assembled LLM prompt (system + user,
 * broken down by section) to a markdown sidecar on each `before_agent_start`.
 * The path is fully DETERMINISTIC from the durable prompt-debug dir + threadId,
 * so both the pi DRIVER (which hands the path to the pi process via an env var)
 * and the projection query (which surfaces the path to the web UI for pi
 * threads) derive it here from the same helper — no event, projector, or DB
 * column is involved. A missing file simply means the thread has not launched
 * under the capture extension yet; the surface degrades to a dead link.
 *
 * @module workstreamPromptDebug
 */

/** Filesystem-safe base name for a thread's sidecar (threadIds are uuids). */
const safeName = (threadId: ThreadId): string => threadId.replace(/[^A-Za-z0-9._-]/g, "_");

// The capture extension writes outside the server process, so expiry is the
// invalidation signal. Five seconds keeps a newly-created sidecar prompt while
// removing filesystem work from snapshot/event hot paths.
const SIDECAR_NAMES_CACHE_TTL_MS = 5_000;
const sidecarNamesCache = new Map<
  string,
  { readonly names: ReadonlySet<string>; readonly expiresAtMs: number }
>();
const sidecarNamesLoads = new Map<string, Promise<ReadonlySet<string>>>();

/** Base filename of a thread's effective-prompt debug sidecar (latest capture). */
export const promptDebugSidecarFileName = (threadId: ThreadId): string =>
  `${safeName(threadId)}.md`;

/** Absolute path to a thread's effective-prompt debug sidecar (latest capture). */
export const promptDebugSidecarPath = (dir: string, threadId: ThreadId): string =>
  NodePath.join(dir, promptDebugSidecarFileName(threadId));

/**
 * The cached set of sidecar filenames currently present in `dir` (at most one
 * asynchronous directory read per five-second window, never one stat per
 * thread). The projection query only surfaces a thread's `promptDebugPath` when its sidecar is
 * actually present, so a capture failure or a not-yet-launched thread never
 * yields a dead UI link. Best-effort: a missing/unreadable dir yields an empty
 * set (no paths surfaced) rather than throwing.
 */
export const readPromptDebugSidecarNames = async (dir: string): Promise<ReadonlySet<string>> => {
  const cached = sidecarNamesCache.get(dir);
  if (cached !== undefined && cached.expiresAtMs > NodePerfHooks.performance.now()) {
    return cached.names;
  }

  const activeLoad = sidecarNamesLoads.get(dir);
  if (activeLoad !== undefined) return activeLoad;

  const load = NodeFS.promises.readdir(dir).then(
    (names): ReadonlySet<string> => new Set(names),
    (): ReadonlySet<string> => new Set(),
  );
  sidecarNamesLoads.set(dir, load);
  try {
    const names = await load;
    sidecarNamesCache.set(dir, {
      names,
      expiresAtMs: NodePerfHooks.performance.now() + SIDECAR_NAMES_CACHE_TTL_MS,
    });
    return names;
  } finally {
    sidecarNamesLoads.delete(dir);
  }
};

/**
 * Whether a single thread's sidecar is present — the per-thread counterpart of
 * `readPromptDebugSidecarNames`, for the single-thread shell lookup that backs
 * every `thread-upserted` shell-stream event. Both paths must apply the same
 * existence gate: if the incremental lookup omitted the path while the full
 * snapshot surfaced it, the UI surface would appear on a fresh snapshot and then
 * disappear on the thread's next event. Best-effort (an unreadable dir ⇒ false).
 */
export const promptDebugSidecarExists = async (dir: string, threadId: ThreadId): Promise<boolean> =>
  (await readPromptDebugSidecarNames(dir)).has(promptDebugSidecarFileName(threadId));
