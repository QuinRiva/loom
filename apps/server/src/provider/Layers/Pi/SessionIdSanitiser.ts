// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import { piSessionIdForThread, resolveSessionFilePath } from "../../piSessionFiles.ts";

/**
 * Loom's defence at its own boundary for a latent pi defect: codex (OpenAI
 * Responses) tool calls carry two ids, which pi stores JOINED as
 * `call_<rand>|fc_<rand>` in the session jsonl. Anthropic validates every
 * `tool_use.id` against `^[a-zA-Z0-9_-]+$` on the FULL history it replays each
 * turn, so the `|` triggers a fatal, non-retryable HTTP 400 the instant a
 * codex-origin session is dispatched onto an Anthropic-family model (manual
 * switch or cross-provider failover). This module rewrites the offending ids on
 * disk so the replayed history is accepted.
 *
 * The transform mirrors the fix-codex-session skill: replace every character
 * outside `[a-zA-Z0-9_-]` with `_`. It is DETERMINISTIC (a given id always maps
 * to the same output) so call/result pairs stay matched, and IDEMPOTENT (a
 * clean history is left byte-for-byte untouched). It is one-way with respect to
 * codex: a rewritten id can no longer replay under OpenAI Responses, which is
 * why it runs ONLY for Anthropic-family dispatches (never for a codex resume).
 *
 * @module SessionIdSanitiser
 */

const VALID_TOOL_ID = /^[a-zA-Z0-9_-]+$/;
const INVALID_TOOL_ID_CHAR = /[^a-zA-Z0-9_-]/g;

/** True when a pi model slug (`provider/modelId`) dispatches to Anthropic's API
 * — the backends that enforce the `tool_use.id` pattern and thus reject
 * codex-style joined ids. `bedrock` is narrowed to its Anthropic model ids
 * (`anthropic.claude…`, regional `us.anthropic.claude…`) because Bedrock also
 * hosts non-Anthropic models the one-way rewrite must never touch. */
export const slugRoutesToAnthropic = (slug: string): boolean => {
  const slash = slug.indexOf("/");
  const provider = slash === -1 ? slug : slug.slice(0, slash);
  const modelId = slash === -1 ? "" : slug.slice(slash + 1);
  if (provider === "anthropic" || provider === "google-vertex-claude") return true;
  if (provider === "bedrock") return /(?:^|\.)anthropic\./.test(modelId);
  return false;
};

const sanitiseId = (value: string): string =>
  VALID_TOOL_ID.test(value) ? value : value.replace(INVALID_TOOL_ID_CHAR, "_");

const TOOL_ID_BLOCK_KEYS = ["id", "tool_use_id", "toolUseId", "toolCallId"] as const;

/**
 * Visit every tool-id string across parsed pi session entries. Covers pi-shape
 * `toolResult.toolCallId` and the `id`/`tool_use_id`/`toolUseId`/`toolCallId`
 * variants on message content blocks (assistant `toolCall` blocks and
 * Anthropic-shape result blocks). When `visit` returns a string the field is
 * rewritten in place; a `void` return leaves it untouched.
 */
const forEachToolId = (
  entries: ReadonlyArray<Record<string, unknown>>,
  visit: (id: string) => string | void,
): void => {
  const apply = (holder: Record<string, unknown>, key: string) => {
    const current = holder[key];
    if (typeof current !== "string") return;
    const next = visit(current);
    if (typeof next === "string") holder[key] = next;
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
};

/**
 * Rewrite invalid tool ids across parsed pi session entries in place, returning
 * the number of id fields changed.
 */
export const sanitiseSessionEntries = (entries: ReadonlyArray<Record<string, unknown>>): number => {
  let changed = 0;
  forEachToolId(entries, (id) => {
    const next = sanitiseId(id);
    if (next !== id) {
      changed += 1;
      return next;
    }
  });
  return changed;
};

/** True iff any tool id in the parsed entries fails Anthropic's id pattern. */
export const entriesHavePoisonedToolIds = (
  entries: ReadonlyArray<Record<string, unknown>>,
): boolean => {
  let poisoned = false;
  forEachToolId(entries, (id) => {
    if (!VALID_TOOL_ID.test(id)) poisoned = true;
  });
  return poisoned;
};

/**
 * Parse a pi session jsonl into its non-empty lines with their JSON values.
 * Blank and unparseable lines (e.g. the leading `{"type":"session"}` header is
 * parseable, but any non-JSON noise is not) carry a `null` value so the writer
 * can preserve them verbatim. Returns undefined when the file cannot be read.
 */
const readSessionLines = (
  path: string,
): ReadonlyArray<{ line: string; value: Record<string, unknown> | null }> | undefined => {
  let raw: string;
  try {
    raw = NodeFS.readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  return raw.split("\n").map((line) => {
    if (!line.trim()) return { line, value: null };
    try {
      return { line, value: JSON.parse(line) as Record<string, unknown> };
    } catch {
      return { line, value: null };
    }
  });
};

/**
 * Sanitise a pi session jsonl in place. Returns true iff something was
 * rewritten; a missing file or already-clean history is a no-op returning
 * false. Non-message and unparseable lines (e.g. the leading `{"type":"session"}`
 * header) are preserved verbatim, so only tool-id fields ever change.
 */
export const sanitiseSessionFile = (path: string): boolean => {
  const rows = readSessionLines(path);
  if (rows === undefined) return false;
  const entries = rows.flatMap((row) => (row.value === null ? [] : [row.value]));
  if (sanitiseSessionEntries(entries) === 0) return false;
  NodeFS.writeFileSync(
    path,
    rows.map((row) => (row.value === null ? row.line : JSON.stringify(row.value))).join("\n"),
  );
  return true;
};

/** True iff the thread's session file exists and carries codex-poisoned ids. */
export const threadSessionHasPoisonedToolIds = (threadId: string): boolean => {
  const path = resolveSessionFilePath(piSessionIdForThread(threadId));
  if (path === undefined) return false;
  const rows = readSessionLines(path);
  return rows === undefined
    ? false
    : entriesHavePoisonedToolIds(rows.flatMap((row) => (row.value === null ? [] : [row.value])));
};

/**
 * Locate the deterministic pi session file for a thread and sanitise it in
 * place. Returns whether anything was rewritten (false when no file exists yet
 * or it is already clean). MUST only be called when no live pi process owns the
 * file for this thread (i.e. before spawning/resuming it) so the rewrite cannot
 * race pi's own writes.
 */
export const sanitisePiSessionForThread = (threadId: string): boolean => {
  const path = resolveSessionFilePath(piSessionIdForThread(threadId));
  return path === undefined ? false : sanitiseSessionFile(path);
};
