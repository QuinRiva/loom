/**
 * stallContext - informed-recovery context for a State-C stall (liveness §3c).
 *
 * When the liveness sweep detects a stalled sub-thread (open turn, runtime
 * heartbeat frozen past the window), a blind re-prompt is not enough: the error
 * that stalled the child sits in its pi session transcript, but the stalled
 * child may be unaware of it. This module reads that transcript and extracts a
 * concise account of the last meaningful event so the recovery nudge — and, if
 * the child stays frozen, the human escalation — can say *what happened*.
 *
 * The parser is pure (testable over raw JSONL); the reader is the thin IO that
 * resolves the thread's deterministic pi session file and loads it.
 *
 * @module stallContext
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";

import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { piSessionIdForThread } from "../provider/Layers/Pi/Cli.ts";
import { resolveSessionFilePath } from "./threadResolve.ts";

export interface StallContext {
  /** Whether the account came from a thrown tool error or the last assistant turn. */
  readonly source: "tool-error" | "last-assistant";
  /** The failing tool's name (tool-error source only). */
  readonly toolName: string | null;
  /** The concise, truncated account of what happened. */
  readonly detail: string;
}

/** Cap on the extracted detail embedded in a nudge / escalation (chars). */
const MAX_DETAIL_CHARS = 800;

const truncate = (text: string): string =>
  text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}…` : text;

/** Join the `text` parts of a pi message `content` array into one string. */
const textFromContent = (content: unknown): string =>
  Array.isArray(content)
    ? content
        .filter(
          (part): part is { readonly text: string } =>
            typeof part === "object" &&
            part !== null &&
            typeof (part as { readonly text?: unknown }).text === "string",
        )
        .map((part) => part.text)
        .join("\n")
        .trim()
    : "";

/**
 * Extract the most informative "what happened" account from a pi session JSONL
 * transcript: the LAST meaningful event, where meaningful is either an errored
 * tool result (the thrown error the child may be stuck on) or an assistant
 * message with text. Whichever appears last wins — so "error then silence"
 * surfaces the error, "spoke then silence" surfaces the last words, and a stale
 * error buried behind later progress is not resurfaced. Returns null when the
 * transcript holds neither.
 */
export const extractStallContext = (jsonl: string): StallContext | null => {
  let best: StallContext | null = null;
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let record: { readonly type?: unknown; readonly message?: unknown };
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue; // pi may interleave non-JSON noise; skip it.
    }
    const message = record.message as
      | {
          readonly role?: unknown;
          readonly isError?: unknown;
          readonly toolName?: unknown;
          readonly content?: unknown;
        }
      | undefined;
    if (record.type !== "message" || typeof message !== "object" || message === null) continue;

    if (message.role === "toolResult" && message.isError === true) {
      const detail = textFromContent(message.content);
      best = {
        source: "tool-error",
        toolName: typeof message.toolName === "string" ? message.toolName : null,
        detail: truncate(detail.length > 0 ? detail : "(tool reported an error with no detail)"),
      };
    } else if (message.role === "assistant") {
      const detail = textFromContent(message.content);
      if (detail.length > 0)
        best = { source: "last-assistant", toolName: null, detail: truncate(detail) };
    }
  }
  return best;
};

/** Human-readable rendering of an extracted stall context (or its absence). */
export const renderStallContext = (context: StallContext | null): string => {
  if (context === null) return "(no specific error or last message was found in the transcript)";
  return context.source === "tool-error"
    ? `The last tool call${context.toolName ? ` (\`${context.toolName}\`)` : ""} failed:\n\n${context.detail}`
    : `Your last message was:\n\n${context.detail}`;
};

/**
 * Resolve a thread's deterministic pi session file and extract its stall
 * context. Returns null when the session file cannot be found or read (the
 * caller falls back to an uninformed nudge rather than failing the sweep).
 */
export const readThreadStallContext = (threadId: ThreadId): Effect.Effect<StallContext | null> =>
  Effect.gen(function* () {
    const path = resolveSessionFilePath(piSessionIdForThread(threadId));
    if (path === undefined) return null;
    const jsonl = yield* Effect.promise(() => NodeFSP.readFile(path, "utf8").catch(() => ""));
    return jsonl.length === 0 ? null : extractStallContext(jsonl);
  });
