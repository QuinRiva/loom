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

/**
 * pi's project session directory for a cwd: `<root>/--<cwd with the leading
 * separator stripped and `/`, `\`, `:` replaced by `-`>--`.
 *
 * Mirrors pi's own `getDefaultSessionDirPath`. pi scopes a `--session-id` launch
 * (first launch of a new thread, and the `--fork` target id) to THIS directory
 * alone, so the encoding has to match pi's byte-for-byte. A RESUME does not go
 * through this directory at all — see `resolveResumableSessionFile`.
 */
export const piProjectSessionDir = (cwd: string, root: string = defaultSessionsRoot()): string =>
  NodePath.join(
    root,
    `--${NodePath.resolve(cwd)
      .replace(/^[/\\]/, "")
      .replace(/[/\\:]/g, "-")}--`,
  );

/** Bytes of a session file read when looking for its header line. */
const HEADER_PROBE_BYTES = 64 * 1024;

/**
 * Read a pi session file's header id, applying pi's own acceptance rule: the
 * FIRST parseable JSONL line must be a `type: "session"` entry (pi skips
 * unparseable lines, but bails the moment the first parseable one is not a
 * header). Returns that header's `id`, or undefined when the file is not a
 * readable pi session.
 */
const readSessionHeaderId = (path: string): string | undefined => {
  let handle: number | undefined;
  try {
    handle = NodeFS.openSync(path, "r");
    const buffer = Buffer.allocUnsafe(HEADER_PROBE_BYTES);
    const read = NodeFS.readSync(handle, buffer, 0, HEADER_PROBE_BYTES, 0);
    const text = buffer.toString("utf8", 0, read);
    // Only COMPLETE lines are considered: a trailing partial line would parse as
    // malformed and wrongly reject an otherwise-valid session.
    const lastNewline = text.lastIndexOf("\n");
    const complete = lastNewline === -1 ? text : text.slice(0, lastNewline);
    for (const line of complete.split("\n")) {
      if (line.trim().length === 0) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // pi skips unparseable lines while hunting the header.
      }
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as { readonly type?: unknown; readonly id?: unknown };
      // The first parseable entry decides: header or not a session at all.
      if (record.type !== "session") return undefined;
      return typeof record.id === "string" ? record.id : undefined;
    }
    return undefined;
  } catch {
    return undefined; // Unreadable => not resumable.
  } finally {
    if (handle !== undefined) NodeFS.closeSync(handle);
  }
};

/**
 * Resolve the session file a RESUME will actually open for this thread, or
 * undefined when there is nothing safe to continue.
 *
 * A pi resume is `--session <path> --cwd <dir>` (the bundled patch), NOT
 * `--session-id`: the driver names the file outright and pins the working
 * directory, so pi opens exactly that path — its project-dir listing is never
 * consulted, and the file may well live under ANOTHER worktree's project dir
 * (the relocated-worktree case the `--cwd` flag exists for). The candidate is
 * therefore the same global by-name lookup the launch itself performs
 * (`resolveSessionFilePath`), so the probe and the launch cannot disagree about
 * WHICH file is at stake.
 *
 * What the probe adds on top is validation of that one file: it must be
 * readable, its first parseable line must be a `session` header, and that
 * header's id must equal `sessionId`. pi with `--cwd` skips its own header read
 * entirely, so a corrupt or non-session file would be opened as an empty
 * conversation — alive-looking with its orchestration context silently gone. A
 * loud refusal is better, hence the validation.
 */
export const resolveResumableSessionFile = (
  sessionId: string,
  root: string = defaultSessionsRoot(),
): string | undefined => {
  const path = resolveSessionFilePath(sessionId, root);
  if (path === undefined) return undefined;
  return readSessionHeaderId(path) === sessionId ? path : undefined;
};
