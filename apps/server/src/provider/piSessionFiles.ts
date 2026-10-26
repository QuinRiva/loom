// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/**
 * On-disk pi session-file mechanics (thread id to session id to `.jsonl` path), kept out of the pi
 * CLI module so orchestration and the MCP bridge can reach session files without importing it.
 *
 * @module piSessionFiles
 */

/**
 * Deterministic per-thread pi session id: the thread id with non-id characters
 * sanitized. pi create-or-resumes the SAME session file for it across restarts,
 * and `mcp__t3-code__consult_thread` resolves the target's frozen session by this same id.
 */
export const piSessionIdForThread = (threadId: string): string =>
  threadId.replace(/[^a-zA-Z0-9_-]/g, "-");

/**
 * pi's sessions root, resolved the way pi resolves it: `PI_CODING_AGENT_SESSION_DIR`,
 * else `$PI_CODING_AGENT_DIR/sessions`, else `<HOME>/.pi/agent/sessions`.
 *
 * `env` exists for callers holding a provider instance's own environment, which
 * may genuinely point pi's sessions elsewhere than the server's own.
 */
export const piSessionsRoot = (env: NodeJS.ProcessEnv = process.env): string =>
  env.PI_CODING_AGENT_SESSION_DIR?.trim() ||
  NodePath.join(
    env.PI_CODING_AGENT_DIR?.trim() ||
      NodePath.join(env.HOME?.trim() || NodeOS.homedir(), ".pi", "agent"),
    "sessions",
  );

/**
 * Resolves a deterministic pi session id to its newest `<timestamp>_<sessionId>.jsonl` under any
 * project dir of the sessions root (never wider); the `_` boundary and UUID-shaped id rule out
 * false positives. Undefined when none exists, and the caller falls back to the bare id.
 */
export const resolveSessionFilePath = (
  sessionId: string,
  root: string = piSessionsRoot(),
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
 * pi's project session directory for a cwd: `<root>/--<cwd with the leading separator stripped and
 * `/`, `\`, `:` replaced by `-`>--`. Matches pi's `getDefaultSessionDirPath` byte-for-byte, since
 * pi scopes a `--session-id` launch to it alone. A resume never uses it.
 */
export const piProjectSessionDir = (cwd: string, root: string = piSessionsRoot()): string =>
  NodePath.join(
    root,
    `--${NodePath.resolve(cwd)
      .replace(/^[/\\]/, "")
      .replace(/[/\\:]/g, "-")}--`,
  );

/** Bytes of a session file read when looking for its header line. */
const HEADER_PROBE_BYTES = 64 * 1024;

/**
 * A pi session file's header id under pi's own rule: the FIRST parseable JSONL line must be a
 * `type: "session"` entry (unparseable lines are skipped). Undefined when not a readable session.
 */
export const readSessionHeaderId = (path: string): string | undefined => {
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
 * The session file a resume will open, or undefined when nothing is safe to continue. A resume is
 * `--session <path> --cwd <dir>`, so pi opens that exact path (possibly under another worktree's
 * project dir); the candidate is the launch's own by-name lookup. With `--cwd` pi skips its header
 * read, so this checks the header id loudly rather than open a corrupt file as an empty session.
 */
export const resolveResumableSessionFile = (
  sessionId: string,
  root: string = piSessionsRoot(),
): string | undefined => {
  const path = resolveSessionFilePath(sessionId, root);
  if (path === undefined) return undefined;
  return readSessionHeaderId(path) === sessionId ? path : undefined;
};

/** A conversation rewind computed from a session file, ready to be written. */
export interface PiSessionRewindPlan {
  /** Full file content to write, i.e. the retained prefix of the branch. */
  readonly retainedText: string;
  /** User messages that survive the rewind. */
  readonly retainedUserMessages: number;
  /** User messages the rewind drops (with everything that followed them). */
  readonly removedUserMessages: number;
}

/**
 * Plans a rewind of the last `turns` prompts by truncating the session's active path, as pi's fork
 * does, but keeping the same file and header id the driver resumes by. Turns are user-role entries,
 * so a steer or retry re-prompt inside one server turn makes a rewind spanning it stop one short.
 * Throws on an unreadable or branched session (the driver never branches; refuse, do not guess).
 */
export const planPiSessionRewind = (path: string, turns: number): PiSessionRewindPlan => {
  const lines = NodeFS.readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const entries = lines.map(
    (line) =>
      JSON.parse(line) as {
        readonly type?: string;
        readonly id?: string;
        readonly parentId?: string | null;
        readonly message?: { readonly role?: string };
      },
  );
  if (entries[0]?.type !== "session") throw new Error(`${path} is not a pi session file.`);
  let parent: string | null = null;
  for (const entry of entries.slice(1)) {
    if ((entry.parentId ?? null) !== parent) {
      throw new Error(`${path} holds a branched pi session, which cannot be rewound in place.`);
    }
    parent = entry.id ?? null;
  }
  const promptLines = entries.flatMap((entry, index) =>
    index > 0 && entry.type === "message" && entry.message?.role === "user" ? [index] : [],
  );
  const retainedUserMessages = Math.max(0, promptLines.length - turns);
  // Rewinding every prompt leaves the bare header: the same conversation, with
  // nothing in it — which is what reverting to turn zero means.
  const cut = retainedUserMessages === 0 ? 1 : promptLines[retainedUserMessages]!;
  return {
    retainedText: lines.slice(0, cut).join("\n") + "\n",
    retainedUserMessages,
    removedUserMessages: promptLines.length - retainedUserMessages,
  };
};
