// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/**
 * On-disk pi session-file mechanics: mapping a thread id to its deterministic
 * session id and resolving that id to the absolute `.jsonl` path on disk.
 *
 * Kept OUT of the pi CLI-invocation module (`Layers/Pi/Cli.ts`) and out of the
 * orchestration layer so the two sit at their proper level: orchestration
 * (`threadResolve`/`stallContext`) and the MCP HTTP bridge reach for session
 * files without importing a provider CLI-invocation module, and the CLI module
 * keeps only invocation concerns.
 *
 * @module piSessionFiles
 */

/**
 * Deterministic per-thread pi session id: the thread id with non-id characters
 * sanitized. pi create-or-resumes the SAME session file for it across restarts,
 * and `consult_thread` resolves the target's frozen session by this same id.
 */
export const piSessionIdForThread = (threadId: string): string =>
  threadId.replace(/[^a-zA-Z0-9_-]/g, "-");

/** Default pi sessions root: `~/.pi/agent/sessions`. */
export const defaultSessionsRoot = (): string =>
  NodePath.join(NodeOS.homedir(), ".pi", "agent", "sessions");

/**
 * Resolve a deterministic pi session id to its absolute `.jsonl` path by
 * scanning every project-slug dir under the sessions root for a file ending in
 * `_<sessionId>.jsonl` (pi names files `<timestamp>_<sessionId>.jsonl`). The
 * `_` boundary plus the UUID-shaped id make false positives effectively
 * impossible. Returns the newest match, or undefined when none exists (the
 * caller then falls back to the bare id). Scoped to the sessions root only —
 * never an unbounded filesystem walk.
 */
export const resolveSessionFilePath = (
  sessionId: string,
  root: string = defaultSessionsRoot(),
): string | undefined => {
  if (!NodeFS.existsSync(root)) return undefined;
  const suffix = `_${sessionId}.jsonl`;
  let best: { path: string; mtimeMs: number } | undefined;
  for (const slug of NodeFS.readdirSync(root)) {
    const dir = NodePath.join(root, slug);
    let entries: ReadonlyArray<string>;
    try {
      entries = NodeFS.readdirSync(dir);
    } catch {
      continue; // Not a readable directory; skip.
    }
    for (const name of entries) {
      if (!name.endsWith(suffix)) continue;
      const path = NodePath.join(dir, name);
      const mtimeMs = NodeFS.statSync(path).mtimeMs;
      if (best === undefined || mtimeMs > best.mtimeMs) best = { path, mtimeMs };
    }
  }
  return best?.path;
};
