import type { ClientSettings } from "@t3tools/contracts/settings";
import type { AssistantCitation } from "@t3tools/contracts";
import {
  serializeAssistantCitation,
  withAssistantCitationComment,
} from "@t3tools/shared/assistantCitations";
import {
  splitPromptIntoComposerSegments,
  type ComposerPromptSegment,
} from "./composer-editor-mentions";

export type ComposerTriggerKind = "path" | "thread" | "pull-request" | "slash-command" | "skill";
export type ComposerSlashCommand = "model" | "plan" | "default" | "handoff" | "retro";
export type ComposerSubmissionIntent = "foreground" | "background" | "alternate";

/**
 * Result of recognising a `/handoff <explanation>` composer draft (plan D2).
 * `/handoff` is intercepted client-side and NEVER becomes a turn on the source
 * thread, so the send authority branches on this typed parse before it
 * dispatches anything.
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
  if (explanation.length === 0) {
    return { kind: "empty-error" };
  }
  return { kind: "handoff", explanation };
}

/**
 * Result of recognising a `/retro [focus]` composer draft. `/retro` is
 * intercepted client-side and NEVER becomes a turn on the source thread. The
 * focus is optional — a bare `/retro` runs a general review.
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

export interface ComposerTrigger {
  kind: ComposerTriggerKind;
  query: string;
  rangeStart: number;
  rangeEnd: number;
}

export function formatAssistantCitationForComposer(citation: AssistantCitation, comment = "") {
  return `${serializeAssistantCitation(withAssistantCitationComment(citation, comment))} `;
}

export function composerSubmissionIntentForEnter(input: {
  isMobileViewport: boolean;
  shiftKey: boolean;
  modifierKey: boolean;
  isDraftThread: boolean;
  isRunning?: boolean;
  sendShortcut?: ClientSettings["sendShortcut"];
  prompt?: string;
}): ComposerSubmissionIntent | null {
  const requiresModifier =
    input.sendShortcut === "mod-enter" ||
    (input.sendShortcut === "mod-enter-multiline" && /[\r\n]/.test(input.prompt ?? ""));
  if (input.isMobileViewport || (requiresModifier && !input.modifierKey)) return null;
  if (input.shiftKey && !(requiresModifier && input.modifierKey && input.isRunning)) return null;
  if (input.isRunning && input.modifierKey && (!requiresModifier || input.shiftKey)) {
    return "alternate";
  }
  return input.modifierKey && input.isDraftThread ? "background" : "foreground";
}

const isInlineTokenSegment = (segment: ComposerPromptSegment): boolean => segment.type !== "text";

function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return text.length;
  return Math.max(0, Math.min(text.length, Math.floor(cursor)));
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\n" || char === "\t" || char === "\r";
}

function tokenStartForCursor(text: string, cursor: number): number {
  let index = cursor - 1;
  while (index >= 0 && !isWhitespace(text[index] ?? "")) {
    index -= 1;
  }
  return index + 1;
}

/**
 * Locate the `#` that opens the active thread mention the cursor sits inside, or
 * null if there is none. Unlike `@`/`$` (single whitespace-delimited tokens), a
 * thread query spans spaces — titles are multi-word — so we scan the current
 * line back to the nearest `#` that starts a token (line start or preceded by
 * whitespace). Everything from there to the cursor is the live query; callers
 * close the menu once that query matches no thread, so a stray `#` in prose
 * never leaves a menu hanging.
 */
function threadMentionStart(text: string, lineStart: number, cursor: number): number | null {
  for (let index = cursor - 1; index >= lineStart; index -= 1) {
    if (text[index] !== "#") continue;
    if (index === lineStart || isWhitespace(text[index - 1] ?? "")) return index;
  }
  return null;
}

export function expandCollapsedComposerCursor(text: string, cursorInput: number): number {
  const collapsedCursor = clampCursor(text, cursorInput);
  const segments = splitPromptIntoComposerSegments(text);
  if (segments.length === 0) {
    return collapsedCursor;
  }

  let remaining = collapsedCursor;
  let expandedCursor = 0;

  for (const segment of segments) {
    if (
      segment.type === "mention" ||
      segment.type === "thread" || // loom:
      segment.type === "citation" ||
      segment.type === "context-reference"
    ) {
      const expandedLength = segment.source.length;
      if (remaining <= 1) {
        return expandedCursor + (remaining === 0 ? 0 : expandedLength);
      }
      remaining -= 1;
      expandedCursor += expandedLength;
      continue;
    }
    if (segment.type === "skill") {
      const expandedLength = segment.source.length;
      if (remaining <= 1) {
        return expandedCursor + (remaining === 0 ? 0 : expandedLength);
      }
      remaining -= 1;
      expandedCursor += expandedLength;
      continue;
    }

    const segmentLength = segment.text.length;
    if (remaining <= segmentLength) {
      return expandedCursor + remaining;
    }
    remaining -= segmentLength;
    expandedCursor += segmentLength;
  }

  return expandedCursor;
}

function collapsedSegmentLength(segment: ComposerPromptSegment): number {
  if (segment.type === "text") {
    return segment.text.length;
  }
  return 1;
}

function clampCollapsedComposerCursorForSegments(
  segments: ReadonlyArray<ComposerPromptSegment>,
  cursorInput: number,
): number {
  const collapsedLength = segments.reduce(
    (total, segment) => total + collapsedSegmentLength(segment),
    0,
  );
  if (!Number.isFinite(cursorInput)) {
    return collapsedLength;
  }
  return Math.max(0, Math.min(collapsedLength, Math.floor(cursorInput)));
}

export function clampCollapsedComposerCursor(text: string, cursorInput: number): number {
  return clampCollapsedComposerCursorForSegments(
    splitPromptIntoComposerSegments(text),
    cursorInput,
  );
}

export function collapseExpandedComposerCursor(text: string, cursorInput: number): number {
  const expandedCursor = clampCursor(text, cursorInput);
  const segments = splitPromptIntoComposerSegments(text);
  if (segments.length === 0) {
    return expandedCursor;
  }

  let remaining = expandedCursor;
  let collapsedCursor = 0;

  for (const segment of segments) {
    if (
      segment.type === "mention" ||
      segment.type === "thread" || // loom:
      segment.type === "citation" ||
      segment.type === "context-reference"
    ) {
      const expandedLength = segment.source.length;
      if (remaining === 0) {
        return collapsedCursor;
      }
      if (remaining <= expandedLength) {
        return collapsedCursor + 1;
      }
      remaining -= expandedLength;
      collapsedCursor += 1;
      continue;
    }
    if (segment.type === "skill") {
      const expandedLength = segment.source.length;
      if (remaining === 0) {
        return collapsedCursor;
      }
      if (remaining <= expandedLength) {
        return collapsedCursor + 1;
      }
      remaining -= expandedLength;
      collapsedCursor += 1;
      continue;
    }

    const segmentLength = segment.text.length;
    if (remaining <= segmentLength) {
      return collapsedCursor + remaining;
    }
    remaining -= segmentLength;
    collapsedCursor += segmentLength;
  }

  return collapsedCursor;
}

export function isCollapsedCursorAdjacentToInlineToken(
  text: string,
  cursorInput: number,
  direction: "left" | "right",
): boolean {
  const segments = splitPromptIntoComposerSegments(text);
  if (!segments.some(isInlineTokenSegment)) {
    return false;
  }

  const cursor = clampCollapsedComposerCursorForSegments(segments, cursorInput);
  let collapsedOffset = 0;

  for (const segment of segments) {
    if (isInlineTokenSegment(segment)) {
      if (direction === "left" && cursor === collapsedOffset + 1) {
        return true;
      }
      if (direction === "right" && cursor === collapsedOffset) {
        return true;
      }
    }
    collapsedOffset += collapsedSegmentLength(segment);
  }

  return false;
}

export function detectComposerTrigger(text: string, cursorInput: number): ComposerTrigger | null {
  const cursor = clampCursor(text, cursorInput);
  const lineStart = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const linePrefix = text.slice(lineStart, cursor);

  if (linePrefix.startsWith("/")) {
    const commandMatch = /^\/(\S*)$/.exec(linePrefix);
    if (commandMatch) {
      const commandQuery = commandMatch[1] ?? "";
      return {
        kind: "slash-command",
        query: commandQuery,
        rangeStart: lineStart,
        rangeEnd: cursor,
      };
    }
  }

  const tokenStart = tokenStartForCursor(text, cursor);
  const token = text.slice(tokenStart, cursor);
  const pullRequestMatch = /^#([\p{L}\p{N}][\p{L}\p{N}_-]*)?$/u.exec(token);
  if (pullRequestMatch) {
    return {
      kind: "pull-request",
      query: pullRequestMatch[1] ?? "",
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  }
  const skillPrefix = /^\p{Sc}/u.exec(token);
  if (skillPrefix) {
    return {
      kind: "skill",
      query: token.slice(skillPrefix[0].length),
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  }
  if (token.startsWith("@")) {
    return {
      kind: "path",
      query: token.slice(1),
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  }

  const threadStart = threadMentionStart(text, lineStart, cursor);
  if (threadStart !== null) {
    return {
      kind: "thread",
      query: text.slice(threadStart + 1, cursor),
      rangeStart: threadStart,
      rangeEnd: cursor,
    };
  }

  return null;
}

/** Caret and trigger after replacing composer text and continuing at the end. */
export function composerStateAtPromptEnd(text: string): {
  cursor: number;
  trigger: ComposerTrigger | null;
} {
  const cursor = collapseExpandedComposerCursor(text, text.length);
  return {
    cursor,
    trigger: detectComposerTrigger(text, expandCollapsedComposerCursor(text, cursor)),
  };
}

// loom: the fork widened ComposerSlashCommand with `handoff`/`retro`, which are
// parsed by their own recognisers, so this stays explicitly plan/default.
export function parseStandaloneComposerSlashCommand(text: string): "plan" | "default" | null {
  const match = /^\/(plan|default)\s*$/i.exec(text.trim());
  if (!match) {
    return null;
  }
  const command = match[1]?.toLowerCase();
  if (command === "plan") return "plan";
  return "default";
}

export function replaceTextRange(
  text: string,
  rangeStart: number,
  rangeEnd: number,
  replacement: string,
): { text: string; cursor: number } {
  const safeStart = Math.max(0, Math.min(text.length, rangeStart));
  const safeEnd = Math.max(safeStart, Math.min(text.length, rangeEnd));
  const nextText = `${text.slice(0, safeStart)}${replacement}${text.slice(safeEnd)}`;
  return { text: nextText, cursor: safeStart + replacement.length };
}
