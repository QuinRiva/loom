/**
 * loom: interim — the `<terminal_context>` / `<element_context>` prompt-block
 * machinery loom's composer and timeline still rely on, lifted out of
 * `lib/terminalContext.ts` and `lib/elementContext.ts` when those were adopted
 * upstream-verbatim in slice 2.
 *
 * Upstream models terminal excerpts and element picks as context records, so
 * none of this survives the re-home: slice 3 deletes the timeline consumers
 * (`MessagesTimeline`, `userMessageTerminalContexts`) and slice 4 the ChatView
 * ones. Delete this module with the last of them.
 */
import {
  formatTerminalContextLabel,
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  normalizeTerminalContextText,
  type TerminalContextSelection,
} from "../lib/terminalContext";
import type { ElementContextSelection } from "../lib/elementContext";

export interface ParsedTerminalContextEntry {
  header: string;
  body: string;
}

export interface ParsedElementContextEntry {
  header: string;
  body: string;
}

export interface ExtractedElementContexts {
  promptText: string;
  contextCount: number;
  contexts: ParsedElementContextEntry[];
}

export interface DisplayedUserMessageState {
  visibleText: string;
  copyText: string;
  contextCount: number;
  previewTitle: string | null;
  contexts: ParsedTerminalContextEntry[];
  elementContexts: ParsedElementContextEntry[];
}

const TRAILING_TERMINAL_CONTEXT_BLOCK_PATTERN =
  /\n*<terminal_context>\n([\s\S]*?)\n<\/terminal_context>\s*$/;
const TRAILING_ELEMENT_CONTEXT_BLOCK_PATTERN =
  /\n*<element_context>\n([\s\S]*?)\n<\/element_context>\s*$/;
const ELEMENT_CONTEXT_LABEL_TAG_MAX = 24;

/** Inline `@terminal:12-18` marker a placeholder expands to at send time. */
export function formatInlineTerminalContextLabel(selection: {
  terminalLabel: string;
  lineStart: number;
  lineEnd: number;
}): string {
  const terminalLabel = selection.terminalLabel.trim().toLowerCase().replace(/\s+/g, "-");
  const range =
    selection.lineStart === selection.lineEnd
      ? `${selection.lineStart}`
      : `${selection.lineStart}-${selection.lineEnd}`;
  return `@${terminalLabel}:${range}`;
}

export function stripInlineTerminalContextPlaceholders(prompt: string): string {
  return prompt.replaceAll(INLINE_TERMINAL_CONTEXT_PLACEHOLDER, "");
}

function normalizeTerminalContextSelection(
  selection: TerminalContextSelection,
): TerminalContextSelection | null {
  const text = normalizeTerminalContextText(selection.text);
  const terminalId = selection.terminalId.trim();
  const terminalLabel = selection.terminalLabel.trim();
  if (text.length === 0 || terminalId.length === 0 || terminalLabel.length === 0) {
    return null;
  }
  const lineStart = Math.max(1, Math.floor(selection.lineStart));
  return {
    terminalId,
    terminalLabel,
    lineStart,
    lineEnd: Math.max(lineStart, Math.floor(selection.lineEnd)),
    text,
  };
}

function buildTerminalContextBlock(contexts: ReadonlyArray<TerminalContextSelection>): string {
  const normalized = contexts
    .map(normalizeTerminalContextSelection)
    .filter((context) => context !== null);
  if (normalized.length === 0) return "";
  const lines = normalized.flatMap((context, index) => [
    `- ${formatTerminalContextLabel(context)}:`,
    ...normalizeTerminalContextText(context.text)
      .split("\n")
      .map((line, offset) => `  ${context.lineStart + offset} | ${line}`),
    ...(index < normalized.length - 1 ? [""] : []),
  ]);
  return ["<terminal_context>", ...lines, "</terminal_context>"].join("\n");
}

/** Replaces each U+FFFC placeholder with its context's inline label, in order. */
function materializeInlineTerminalContextPrompt(
  prompt: string,
  contexts: ReadonlyArray<{ terminalLabel: string; lineStart: number; lineEnd: number }>,
): string {
  let nextContextIndex = 0;
  let result = "";
  for (const char of prompt) {
    if (char !== INLINE_TERMINAL_CONTEXT_PLACEHOLDER) {
      result += char;
      continue;
    }
    const context = contexts[nextContextIndex] ?? null;
    nextContextIndex += 1;
    if (context) result += formatInlineTerminalContextLabel(context);
  }
  return result;
}

export function appendTerminalContextsToPrompt(
  prompt: string,
  contexts: ReadonlyArray<TerminalContextSelection>,
): string {
  const trimmedPrompt = materializeInlineTerminalContextPrompt(prompt, contexts).trim();
  const contextBlock = buildTerminalContextBlock(contexts);
  if (contextBlock.length === 0) return trimmedPrompt;
  return trimmedPrompt.length > 0 ? `${trimmedPrompt}\n\n${contextBlock}` : contextBlock;
}

function parseContextEntries(block: string): ParsedTerminalContextEntry[] {
  const entries: ParsedTerminalContextEntry[] = [];
  let current: { header: string; bodyLines: string[] } | null = null;
  const commit = () => {
    if (!current) return;
    entries.push({ header: current.header, body: current.bodyLines.join("\n").trimEnd() });
    current = null;
  };
  for (const line of block.split("\n")) {
    const headerMatch = /^- (.+):$/.exec(line);
    if (headerMatch) {
      commit();
      current = { header: headerMatch[1]!, bodyLines: [] };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("  ")) current.bodyLines.push(line.slice(2));
    else if (line.length === 0) current.bodyLines.push("");
  }
  commit();
  return entries;
}

/**
 * Mirror image of the append helpers for transcript display: detects (and
 * strips) a trailing block so the prompt body and chips render separately.
 */
export function extractTrailingElementContexts(prompt: string): ExtractedElementContexts {
  const match = TRAILING_ELEMENT_CONTEXT_BLOCK_PATTERN.exec(prompt);
  if (!match) return { promptText: prompt, contextCount: 0, contexts: [] };
  const contexts = parseContextEntries(match[1] ?? "");
  return {
    promptText: prompt.slice(0, match.index).replace(/\n+$/, ""),
    contextCount: contexts.length,
    contexts,
  };
}

export function deriveDisplayedUserMessageState(prompt: string): DisplayedUserMessageState {
  // Order matters: send-time appends `<terminal_context>` first, then
  // `<element_context>` last. Strip element first so the (now-trailing)
  // terminal block can be matched.
  const extractedElement = extractTrailingElementContexts(prompt);
  const terminalMatch = TRAILING_TERMINAL_CONTEXT_BLOCK_PATTERN.exec(extractedElement.promptText);
  const contexts = terminalMatch ? parseContextEntries(terminalMatch[1] ?? "") : [];
  return {
    visibleText: terminalMatch
      ? extractedElement.promptText.slice(0, terminalMatch.index).replace(/\n+$/, "")
      : extractedElement.promptText,
    copyText: prompt,
    contextCount: contexts.length,
    previewTitle:
      contexts.length > 0
        ? contexts
            .map(({ header, body }) => (body.length > 0 ? `${header}\n${body}` : header))
            .join("\n\n")
        : null,
    contexts,
    elementContexts: extractedElement.contexts,
  };
}

function formatElementContextSourceLabel(context: ElementContextSelection): string | null {
  const fileName = context.source?.fileName;
  if (!fileName) return null;
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  return context.source?.lineNumber == null ? base : `${base}:${context.source.lineNumber}`;
}

function buildContextHeader(context: ElementContextSelection): string {
  const tag =
    context.tagName.length <= ELEMENT_CONTEXT_LABEL_TAG_MAX
      ? context.tagName
      : `${context.tagName.slice(0, ELEMENT_CONTEXT_LABEL_TAG_MAX - 1)}…`;
  const label = `<${context.componentName ?? tag}>`;
  const source = formatElementContextSourceLabel(context);
  return source ? `${label} (${source})` : label;
}

function buildSingleContextLines(context: ElementContextSelection): string[] {
  const html = context.htmlPreview.trim();
  const styles = context.styles.trim();
  const indent = (value: string) => value.split("\n").map((line) => `  ${line}`);
  const source = context.source?.fileName
    ? `${context.source.fileName}${
        context.source.lineNumber != null
          ? `:${context.source.lineNumber}${
              context.source.columnNumber != null ? `:${context.source.columnNumber}` : ""
            }`
          : ""
      }`
    : null;
  return [
    `- ${buildContextHeader(context)}:`,
    ...(context.pageUrl.length > 0 ? [`  url: ${context.pageUrl}`] : []),
    ...(context.selector ? [`  selector: ${context.selector}`] : []),
    ...(source ? [`  source: ${source}`] : []),
    ...(html.length > 0 ? ["  html:", ...indent(html)] : []),
    ...(styles.length > 0 ? ["  styles:", ...indent(styles)] : []),
  ];
}

/** Serializes element-context picks into the `<element_context>` prompt block. */
export function buildElementContextBlock(contexts: ReadonlyArray<ElementContextSelection>): string {
  if (contexts.length === 0) return "";
  const lines = contexts.flatMap((context, index) => [
    ...buildSingleContextLines(context),
    ...(index < contexts.length - 1 ? [""] : []),
  ]);
  return ["<element_context>", ...lines, "</element_context>"].join("\n");
}
