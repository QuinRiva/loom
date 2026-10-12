// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

/**
 * Loom's defence at its own boundary for a latent pi defect: codex (OpenAI
 * Responses) tool calls carry two ids, which pi stores JOINED as
 * `call_<rand>|fc_<rand>` in the session jsonl. Anthropic validates every
 * `tool_use.id` against `^[a-zA-Z0-9_-]+$` on the FULL history it replays each
 * turn, so the `|` triggers a fatal, non-retryable HTTP 400 the instant a
 * codex-origin session is dispatched onto an Anthropic-family model (a manual
 * switch or the cross-vendor reroute). This module rewrites the offending ids
 * on disk so the replayed history is accepted.
 *
 * The transform mirrors the fix-codex-session skill: replace every character
 * outside `[a-zA-Z0-9_-]` with `_`. It is DETERMINISTIC (a given id always maps
 * to the same output) so call/result pairs stay matched, and IDEMPOTENT (a
 * clean history is left byte-for-byte untouched). It is one-way with respect to
 * codex, which is why it runs ONLY for Anthropic-family resumes.
 *
 * Pull 9 (3c-2): it takes the session FILE (the provider thread's
 * `nativeThreadRef`), never a thread name, and runs from the pi adapter's resume
 * path immediately before `switch_session` — the moment a fresh pi process is
 * about to load the file (P3-12).
 *
 * @module provider/Drivers/Pi/SessionIdSanitiser
 */

const VALID_TOOL_ID = /^[a-zA-Z0-9_-]+$/;
const INVALID_TOOL_ID_CHAR = /[^a-zA-Z0-9_-]/g;

/** True when a pi model slug (`provider/modelId`) dispatches to Anthropic's
 * Messages API — the backends that enforce the `tool_use.id` pattern. Besides
 * the `anthropic` and `google-vertex-claude` namespaces, any model id naming a
 * Claude model counts: Loom's own pool is `cliproxy/claude-*` (CLI Proxy, an
 * `anthropic-messages` provider), and Bedrock's Anthropic ids are
 * `anthropic.claude…`, while Bedrock's other models never match. */
export const slugRoutesToAnthropic = (slug: string): boolean => {
  const slash = slug.indexOf("/");
  const provider = slash === -1 ? slug : slug.slice(0, slash);
  const modelId = slash === -1 ? "" : slug.slice(slash + 1);
  return (
    provider === "anthropic" ||
    provider === "google-vertex-claude" ||
    /(?:^|[./])claude/i.test(modelId)
  );
};

const sanitiseId = (value: string): string =>
  VALID_TOOL_ID.test(value) ? value : value.replace(INVALID_TOOL_ID_CHAR, "_");

const TOOL_ID_BLOCK_KEYS = ["id", "tool_use_id", "toolUseId", "toolCallId"] as const;

/**
 * Rewrite every invalid tool id across parsed pi session entries in place:
 * pi-shape `toolResult.toolCallId` and the `id`/`tool_use_id`/`toolUseId`/
 * `toolCallId` variants on message content blocks. Returns how many changed.
 */
const sanitiseSessionEntries = (entries: ReadonlyArray<Record<string, unknown>>): number => {
  let changed = 0;
  const apply = (holder: Record<string, unknown>, key: string) => {
    const current = holder[key];
    if (typeof current !== "string") return;
    const next = sanitiseId(current);
    if (next === current) return;
    holder[key] = next;
    changed += 1;
  };
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message === null || typeof message !== "object") continue;
    const messageRecord = message as Record<string, unknown>;
    if (messageRecord.role === "toolResult") apply(messageRecord, "toolCallId");
    const content = messageRecord.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block === null || typeof block !== "object") continue;
      for (const key of TOOL_ID_BLOCK_KEYS) apply(block as Record<string, unknown>, key);
    }
  }
  return changed;
};

/**
 * Sanitise a pi session jsonl in place. Returns true iff something was
 * rewritten; a missing file or already-clean history is a no-op returning
 * false. Blank, non-message and unparseable lines are preserved verbatim, so
 * only tool-id fields ever change. Must only run while no live pi process owns
 * the file (the resume path, before `switch_session`).
 */
export const sanitisePiSessionFile = (path: string): boolean => {
  let raw: string;
  try {
    raw = NodeFS.readFileSync(path, "utf8");
  } catch {
    return false;
  }
  const rows = raw.split("\n").map((line) => {
    if (!line.trim()) return { line, value: null };
    try {
      return { line, value: JSON.parse(line) as Record<string, unknown> };
    } catch {
      return { line, value: null };
    }
  });
  if (sanitiseSessionEntries(rows.flatMap((row) => (row.value === null ? [] : [row.value]))) === 0)
    return false;
  NodeFS.writeFileSync(
    path,
    rows.map((row) => (row.value === null ? row.line : JSON.stringify(row.value))).join("\n"),
  );
  return true;
};
