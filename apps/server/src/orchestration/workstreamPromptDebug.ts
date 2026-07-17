// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

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

/** Base filename of a thread's effective-prompt debug sidecar (latest capture). */
export const promptDebugSidecarFileName = (threadId: ThreadId): string =>
  `${safeName(threadId)}.md`;

/** Absolute path to a thread's effective-prompt debug sidecar (latest capture). */
export const promptDebugSidecarPath = (dir: string, threadId: ThreadId): string =>
  NodePath.join(dir, promptDebugSidecarFileName(threadId));

/**
 * The set of sidecar filenames currently present in `dir` (a single directory
 * read, not one stat per thread). The projection query reads this ONCE per shell
 * snapshot and only surfaces a thread's `promptDebugPath` when its sidecar is
 * actually present, so a capture failure or a not-yet-launched thread never
 * yields a dead UI link. Best-effort: a missing/unreadable dir yields an empty
 * set (no paths surfaced) rather than throwing.
 */
export const readPromptDebugSidecarNames = (dir: string): ReadonlySet<string> => {
  try {
    return new Set(NodeFS.readdirSync(dir));
  } catch {
    return new Set();
  }
};
