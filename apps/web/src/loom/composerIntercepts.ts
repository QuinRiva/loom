/**
 * loom: the client-side composer commands that never become a turn on the
 * source thread. `/handoff` and `/retro` are recognised here and acted on by
 * the send authority in ChatView; slice 4 moves the decision + effect
 * sequencing into this module too.
 */

/**
 * Result of recognising a `/handoff <explanation>` composer draft (plan D2).
 * The send authority branches on this typed parse before it dispatches
 * anything.
 */
export type HandoffDraftParse =
  | { readonly kind: "not-handoff" }
  | { readonly kind: "empty-error" }
  | { readonly kind: "handoff"; readonly explanation: string };

// `/handoff` followed by end-of-input or whitespace + free-text explanation.
// `/handofff…` (no boundary after the word) is deliberately NOT a match.
const HANDOFF_COMMAND_PATTERN = /^\/handoff(?:\s+([\s\S]*))?$/i;

export function parseHandoffDraft(text: string): HandoffDraftParse {
  const match = HANDOFF_COMMAND_PATTERN.exec(text.trim());
  if (!match) {
    return { kind: "not-handoff" };
  }
  const explanation = (match[1] ?? "").trim();
  return explanation.length === 0 ? { kind: "empty-error" } : { kind: "handoff", explanation };
}

/**
 * Result of recognising a `/retro [focus]` composer draft. The focus is
 * optional — a bare `/retro` runs a general review.
 */
export type RetroDraftParse =
  | { readonly kind: "not-retro" }
  | { readonly kind: "retro"; readonly focus: string | undefined };

// `/retro` followed by end-of-input or whitespace + optional free-text focus.
// `/retrofit…` (no boundary after the word) is deliberately NOT a match.
const RETRO_COMMAND_PATTERN = /^\/retro(?:\s+([\s\S]*))?$/i;

export function parseRetroDraft(text: string): RetroDraftParse {
  const match = RETRO_COMMAND_PATTERN.exec(text.trim());
  if (!match) {
    return { kind: "not-retro" };
  }
  const focus = (match[1] ?? "").trim();
  return { kind: "retro", focus: focus.length === 0 ? undefined : focus };
}
