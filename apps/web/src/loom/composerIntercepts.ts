/**
 * loom: the client-side composer commands that never become a turn on the
 * source thread. `/handoff` and `/retro` are recognised, decided and sequenced
 * here; ChatView's send authority owns only the mount (one marked branch that
 * calls `decideHandoffSend` / `decideRetroSend` and hands the effects back to
 * `runComposerDraftIntercept`).
 */
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";

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

// Inline copy for the `/handoff` composer intercept (plan D2). Australian
// English in UI prose.
export const HANDOFF_EMPTY_EXPLANATION_MESSAGE =
  "Add an explanation after /handoff before sending.";
export const HANDOFF_BLOCKED_CONTEXT_MESSAGE =
  "Attachments and contexts aren’t supported with /handoff yet. Remove them and try again.";

/**
 * Result of the `/handoff` intercept decision at the send authority. Every kind
 * except `not-handoff` short-circuits the send — a recognised `/handoff` must
 * NEVER become a turn on the source thread (plan D2). `not-handoff` is the ONLY
 * kind that lets `onSend` fall through to a normal turn-start.
 */
export type HandoffSendDecision =
  | { readonly kind: "not-handoff" }
  | { readonly kind: "empty-error"; readonly message: string }
  | { readonly kind: "blocked-context"; readonly message: string }
  | { readonly kind: "dispatch"; readonly explanation: string };

/**
 * Pure decision for the `/handoff` intercept. `onSend` performs the effects
 * (inline error, RPC dispatch, draft clear/preserve) but the branch selection
 * lives here so the no-fall-through invariant is unit-testable in isolation.
 * Attachments/terminal/element/preview/review/thread contexts alongside a
 * recognised `/handoff` are rejected (plan D2), never silently discarded.
 */
export function decideHandoffSend(input: {
  trimmedPrompt: string;
  hasAttachmentsOrContexts: boolean;
}): HandoffSendDecision {
  const parse = parseHandoffDraft(input.trimmedPrompt);
  if (parse.kind === "not-handoff") {
    return { kind: "not-handoff" };
  }
  if (parse.kind === "empty-error") {
    return { kind: "empty-error", message: HANDOFF_EMPTY_EXPLANATION_MESSAGE };
  }
  if (input.hasAttachmentsOrContexts) {
    return { kind: "blocked-context", message: HANDOFF_BLOCKED_CONTEXT_MESSAGE };
  }
  return { kind: "dispatch", explanation: parse.explanation };
}

// Inline copy for the `/retro` composer intercept. Australian English in UI
// prose.
export const RETRO_BLOCKED_CONTEXT_MESSAGE =
  "Attachments and contexts aren’t supported with /retro. Remove them and try again.";

/**
 * Result of the `/retro` intercept decision at the send authority. Every kind
 * except `not-retro` short-circuits the send — a recognised `/retro` must
 * NEVER become a turn on the source thread. `not-retro` is the ONLY kind that
 * lets `onSend` fall through to a normal turn-start.
 */
export type RetroSendDecision =
  | { readonly kind: "not-retro" }
  | { readonly kind: "blocked-context"; readonly message: string }
  | { readonly kind: "dispatch"; readonly focus: string | undefined };

/**
 * Pure decision for the `/retro` intercept, mirroring `decideHandoffSend`.
 * The focus is optional (a bare `/retro` runs a general review), so there is
 * no empty-error branch.
 */
export function decideRetroSend(input: {
  trimmedPrompt: string;
  hasAttachmentsOrContexts: boolean;
}): RetroSendDecision {
  const parse = parseRetroDraft(input.trimmedPrompt);
  if (parse.kind === "not-retro") {
    return { kind: "not-retro" };
  }
  if (input.hasAttachmentsOrContexts) {
    return { kind: "blocked-context", message: RETRO_BLOCKED_CONTEXT_MESSAGE };
  }
  return { kind: "dispatch", focus: parse.focus };
}

/** Composer content counts, as read at the moment a failed send wants to restore. */
export interface ComposerContentSnapshot {
  readonly prompt: string;
  readonly attachmentCount: number;
  readonly terminalContextCount: number;
  readonly previewAnnotationCount: number;
  readonly reviewCommentCount: number;
  readonly threadReferenceCount: number;
}

/**
 * Collision rule for putting a failed send's text back into the composer: only
 * restore when the composer is still completely empty. If the human typed (or
 * attached) anything while the send was in flight, their content wins and the
 * submitted text is left out — never clobbered over the top.
 */
export function shouldRestoreSubmittedDraft(snapshot: ComposerContentSnapshot): boolean {
  return (
    snapshot.prompt.length === 0 &&
    snapshot.attachmentCount === 0 &&
    snapshot.terminalContextCount === 0 &&
    snapshot.previewAnnotationCount === 0 &&
    snapshot.reviewCommentCount === 0 &&
    snapshot.threadReferenceCount === 0
  );
}

export type ComposerDraftInterceptOutcome = "success" | "failure";

/**
 * Effect sequencing shared by the `/handoff` and `/retro` composer intercepts.
 *
 * Both intercepts `await` an RPC, which is the one thing the normal send path
 * never does before clearing the composer — and that yield point was the whole
 * double-fire bug: a still-populated, still-armed composer dispatched one
 * drafter per keypress. So the order here is load-bearing:
 *
 * 1. arm the in-flight guard the caller checks at entry, with no intervening
 *    `await`, so repeated submissions collapse to one dispatch;
 * 2. clear the composer BEFORE the `await`, exactly as the normal path does
 *    (which is also why the second submission no longer parses as a draft
 *    command at all);
 * 3. release the guard on every exit, and on failure put the submitted text
 *    back only when the composer is still empty.
 */
export async function runComposerDraftIntercept<A, E>(ports: {
  readonly submittedPrompt: string;
  readonly setSendInFlight: (inFlight: boolean) => void;
  readonly clearComposer: () => void;
  readonly readComposerContent: () => ComposerContentSnapshot;
  readonly restoreComposer: (prompt: string) => void;
  readonly dispatch: () => Promise<AtomCommandResult<A, E>>;
  readonly onSuccess: (result: Extract<AtomCommandResult<A, E>, { _tag: "Success" }>) => void;
  readonly onFailure: (result: Extract<AtomCommandResult<A, E>, { _tag: "Failure" }>) => void;
}): Promise<ComposerDraftInterceptOutcome> {
  ports.setSendInFlight(true);
  ports.clearComposer();
  try {
    const result = await ports.dispatch();
    if (result._tag === "Failure") {
      if (shouldRestoreSubmittedDraft(ports.readComposerContent())) {
        ports.restoreComposer(ports.submittedPrompt);
      }
      ports.onFailure(result);
      return "failure";
    }
    ports.onSuccess(result);
    return "success";
  } finally {
    ports.setSendInFlight(false);
  }
}
