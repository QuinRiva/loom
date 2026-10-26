// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

/**
 * pi stores codex tool-call ids joined as `call_<rand>|fc_<rand>`, and Anthropic rejects a replayed
 * `tool_use.id` outside `^[a-zA-Z0-9_-]+$` with a fatal 400. This rewrites such characters to `_`
 * on disk (deterministic, so call/result pairs match; idempotent) for Anthropic-family resumes only,
 * being one-way, from the resume path just before `switch_session` loads the session file.
 */

const VALID_TOOL_ID = /^[a-zA-Z0-9_-]+$/;
const INVALID_TOOL_ID_CHAR = /[^a-zA-Z0-9_-]/g;

/** True when a pi slug dispatches to Anthropic's Messages API, which enforces the `tool_use.id`
 * pattern: the `anthropic` and `google-vertex-claude` namespaces, or any id naming a Claude model
 * (`cliproxy/claude-*`, Bedrock's `anthropic.claude…`). */
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
 * Sanitises a pi session jsonl in place; true iff something was rewritten. Everything but tool-id
 * fields is preserved verbatim. Run only while no live pi process owns the file (the resume path,
 * before `switch_session`).
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
