import type { PullRequestReviewPosition } from "@t3tools/contracts";
import type { FileDiffMetadata, SelectedLineRange, SelectionSide } from "@pierre/diffs";
import { PlanCommentAnchor } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { planCommentAnchorDetails } from "./planCommentAnchor";

/**
 * Injected review-comment evidence, as a discriminated union on `kind` (decision
 * D6 — no dual-shape optional cruft):
 *   - `line`: the original source/diff-review path (unchanged behaviour) — line
 *     indices + a source/diff fence.
 *   - `mdx-anchor`: rendered-MDX-plan annotation — a {@link PlanCommentAnchor}
 *     (text-quote + section/block) plus the quoted passage as evidence.
 *
 * The Phase 1-Fan (server + injection) thread owns the authoritative
 * agent-prompt serialisation/parse of the `mdx-anchor` variant; the format below
 * is a correct first cut so the union is exhaustive today. Nothing constructs
 * `mdx-anchor` yet (the Phase 2 annotation layer will).
 */
const ReviewCommentSelectionSchema = Schema.Struct({
  start: Schema.Number,
  side: Schema.Literals(["additions", "deletions"]),
  end: Schema.Number,
  endSide: Schema.Literals(["additions", "deletions"]),
});

const reviewCommentBaseFields = {
  id: Schema.String,
  sectionId: Schema.String,
  sectionTitle: Schema.String,
  filePath: Schema.String,
  rangeLabel: Schema.String,
  text: Schema.String,
};

export const LineReviewCommentContextSchema = Schema.Struct({
  kind: Schema.Literal("line"),
  ...reviewCommentBaseFields,
  startIndex: Schema.Number,
  endIndex: Schema.Number,
  diff: Schema.String,
  fenceLanguage: Schema.optional(Schema.String),
  selection: Schema.optional(ReviewCommentSelectionSchema),
});

export const MdxAnchorReviewCommentContextSchema = Schema.Struct({
  kind: Schema.Literal("mdx-anchor"),
  ...reviewCommentBaseFields,
  anchor: PlanCommentAnchor,
  quotedText: Schema.String,
});

export const ReviewCommentContextSchema = Schema.Union([
  LineReviewCommentContextSchema,
  MdxAnchorReviewCommentContextSchema,
]);

export type LineReviewCommentContext = typeof LineReviewCommentContextSchema.Type;
export type MdxAnchorReviewCommentContext = typeof MdxAnchorReviewCommentContextSchema.Type;
export type ReviewCommentContext = typeof ReviewCommentContextSchema.Type;

interface DiffReviewLine {
  readonly change: "context" | "add" | "delete";
  readonly oldLineNumber: number | null;
  readonly newLineNumber: number | null;
  readonly content: string;
}

export type ReviewCommentMessageSegment =
  | {
      readonly kind: "text";
      readonly id: string;
      readonly text: string;
    }
  | {
      readonly kind: "review-comment";
      readonly comment: ReviewCommentContext;
    };

const REVIEW_COMMENT_BLOCK_PATTERN = /<review_comment\b([^>]*)>\s*([\s\S]*?)<\/review_comment>/g;
const REVIEW_COMMENT_ATTRIBUTE_PATTERN = /([a-zA-Z][a-zA-Z0-9_-]*)="([^"]*)"/g;
const REVIEW_COMMENT_FENCE_PATTERN = /(`{3,})([^\s`]*)[^\n]*\n([\s\S]*?)\n\1/g;

function escapeReviewCommentAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function unescapeReviewCommentAttribute(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

function readReviewCommentAttributes(rawAttributes: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of rawAttributes.matchAll(REVIEW_COMMENT_ATTRIBUTE_PATTERN)) {
    attributes[match[1]!] = unescapeReviewCommentAttribute(match[2] ?? "");
  }
  return attributes;
}

function readNonNegativeInteger(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) {
    return null;
  }
  return Number(value);
}

function extractReviewCommentBody(rawBody: string): {
  text: string;
  language: string;
  contents: string;
} {
  const matches = Array.from(rawBody.matchAll(REVIEW_COMMENT_FENCE_PATTERN));
  const match = matches.at(-1);
  const fenceIndex = match?.index;
  return {
    text: rawBody.slice(0, fenceIndex ?? rawBody.length).trim(),
    language: match?.[2]?.trim() || "diff",
    contents: match?.[3] ?? "",
  };
}

const decodePlanCommentAnchor = Schema.decodeUnknownOption(PlanCommentAnchor);

function parseMdxAnchorReviewComment(
  attributes: Record<string, string>,
  rawBody: string,
  index: number,
): MdxAnchorReviewCommentContext | null {
  const filePath = attributes.filePath?.trim();
  const sectionId = attributes.sectionId?.trim();
  const rawAnchor = attributes.anchor;
  if (!filePath || !sectionId || !rawAnchor) {
    return null;
  }
  let parsedAnchor: unknown;
  try {
    parsedAnchor = JSON.parse(rawAnchor);
  } catch {
    return null;
  }
  const decoded = decodePlanCommentAnchor(parsedAnchor);
  if (Option.isNone(decoded)) {
    return null;
  }
  // The agent-facing detail block is rendered after the quoted-passage fence and
  // is derived from the anchor, so we recover the reviewer's text (before the
  // fence) and the quoted passage (fence contents) and drop the trailing prose.
  const body = extractReviewCommentBody(rawBody);
  return {
    kind: "mdx-anchor",
    id: attributes.id?.trim() || `review-comment:${index}:${sectionId}:${filePath}`,
    sectionId,
    sectionTitle: attributes.sectionTitle?.trim() || "Review",
    filePath,
    rangeLabel: attributes.rangeLabel?.trim() || "annotation",
    text: body.text,
    anchor: decoded.value,
    quotedText: body.contents,
  };
}

function parseReviewCommentContext(
  rawAttributes: string,
  rawBody: string,
  index: number,
): ReviewCommentContext | null {
  const attributes = readReviewCommentAttributes(rawAttributes);
  if (attributes.kind === "mdx-anchor") {
    return parseMdxAnchorReviewComment(attributes, rawBody, index);
  }
  const startIndex = readNonNegativeInteger(attributes.startIndex);
  const endIndex = readNonNegativeInteger(attributes.endIndex);
  const filePath = attributes.filePath?.trim();
  const sectionId = attributes.sectionId?.trim();
  if (!filePath || !sectionId || startIndex === null || endIndex === null) {
    return null;
  }
  const body = extractReviewCommentBody(rawBody);

  return {
    kind: "line",
    id: `review-comment:${index}:${sectionId}:${filePath}:${startIndex}:${endIndex}`,
    sectionId,
    sectionTitle: attributes.sectionTitle?.trim() || "Review",
    filePath,
    startIndex: Math.min(startIndex, endIndex),
    endIndex: Math.max(startIndex, endIndex),
    rangeLabel: attributes.rangeLabel?.trim() || "line",
    text: body.text,
    diff: body.contents,
    fenceLanguage: body.language,
  };
}

export function parseReviewCommentMessageSegments(
  value: string,
): ReadonlyArray<ReviewCommentMessageSegment> {
  const segments: ReviewCommentMessageSegment[] = [];
  let cursor = 0;
  let parsedCommentIndex = 0;

  for (const match of value.matchAll(REVIEW_COMMENT_BLOCK_PATTERN)) {
    const matchIndex = match.index ?? 0;
    const beforeText = value.slice(cursor, matchIndex);
    if (beforeText.length > 0) {
      segments.push({
        kind: "text",
        id: `review-comment-text:${cursor}`,
        text: beforeText,
      });
    }

    const comment = parseReviewCommentContext(match[1] ?? "", match[2] ?? "", parsedCommentIndex);
    if (comment) {
      segments.push({ kind: "review-comment", comment });
      parsedCommentIndex += 1;
    } else {
      segments.push({
        kind: "text",
        id: `review-comment-invalid:${matchIndex}`,
        text: match[0],
      });
    }

    cursor = matchIndex + match[0].length;
  }

  const rest = value.slice(cursor);
  if (rest.length > 0) {
    segments.push({
      kind: "text",
      id: `review-comment-text:${cursor}`,
      text: rest,
    });
  }

  return segments;
}

export function hasReviewCommentMessageSegments(value: string): boolean {
  return parseReviewCommentMessageSegments(value).some(
    (segment) => segment.kind === "review-comment",
  );
}

export function formatReviewCommentFence(language: string, contents: string): string {
  const longestBacktickRun = Math.max(
    0,
    ...Array.from(contents.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return [`${fence}${language}`, contents.trimEnd(), fence].join("\n");
}

/**
 * Serialise the `mdx-anchor` variant into the injected user turn. Layout (kept
 * consistent with the line variant — attributes, reviewer text, then a fenced
 * evidence block):
 *   - Attributes carry the base fields plus the full {@link PlanCommentAnchor}
 *     as an escaped-JSON `anchor="…"` value. That JSON is the machine round-trip
 *     truth (lossless across every tier, so parse re-hydrates the exact anchor).
 *   - The reviewer's request is the leading prose.
 *   - The quoted passage is a fenced block — the concrete "which passage" the
 *     comment targets (mirrors the diff fence of the line variant).
 *   - A BuilderIO-style anchor detail block (section, block type, context,
 *     ambiguity, expected resolver) follows the fence as agent-facing prose; it
 *     is derived from the anchor and is ignored on parse (the JSON is the truth).
 */
function formatMdxAnchorReviewComment(comment: MdxAnchorReviewCommentContext): string {
  const details = planCommentAnchorDetails(comment.anchor);
  const fenceLanguage = inferReviewCommentFenceLanguage(comment.filePath);
  const body = [
    comment.text.trim(),
    formatReviewCommentFence(fenceLanguage, comment.quotedText),
    details.length > 0 ? details.join("\n") : "",
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
  return [
    [
      "<review_comment",
      ` kind="mdx-anchor"`,
      ` id="${escapeReviewCommentAttribute(comment.id)}"`,
      ` sectionId="${escapeReviewCommentAttribute(comment.sectionId)}"`,
      ` sectionTitle="${escapeReviewCommentAttribute(comment.sectionTitle)}"`,
      ` filePath="${escapeReviewCommentAttribute(comment.filePath)}"`,
      ` rangeLabel="${escapeReviewCommentAttribute(comment.rangeLabel)}"`,
      ` anchor="${escapeReviewCommentAttribute(JSON.stringify(comment.anchor))}"`,
      ">",
    ].join(""),
    body,
    "</review_comment>",
  ].join("\n");
}

/**
 * Keeps a comment's own words from closing the block they travel in. The parser ends an
 * attachment at the first `</review_comment>`, so text carrying one would spill the rest of
 * itself into the prompt — and could open a forged attachment naming any file it liked. Only
 * ever the local reader's words before, but a pull request's review bodies come from whoever
 * wrote them.
 */
function neutralizeReviewCommentTags(text: string): string {
  return text.replace(/<(?=\/?review_comment\b)/giu, "&lt;");
}

export function formatReviewCommentContext(comment: ReviewCommentContext): string {
  if (comment.kind === "mdx-anchor") {
    return formatMdxAnchorReviewComment(comment);
  }
  return [
    [
      "<review_comment",
      ` sectionId="${escapeReviewCommentAttribute(comment.sectionId)}"`,
      ` sectionTitle="${escapeReviewCommentAttribute(comment.sectionTitle)}"`,
      ` filePath="${escapeReviewCommentAttribute(comment.filePath)}"`,
      ` startIndex="${comment.startIndex}"`,
      ` endIndex="${comment.endIndex}"`,
      ` rangeLabel="${escapeReviewCommentAttribute(comment.rangeLabel)}"`,
      ">",
    ].join(""),
    neutralizeReviewCommentTags(comment.text.trim()),
    formatReviewCommentFence(comment.fenceLanguage ?? "diff", comment.diff),
    "</review_comment>",
  ].join("\n");
}

export function appendReviewCommentsToPrompt(
  prompt: string,
  comments: ReadonlyArray<ReviewCommentContext>,
): string {
  const blocks = comments.map(formatReviewCommentContext);
  if (blocks.length === 0) return prompt;
  const trimmedPrompt = prompt.trim();
  return trimmedPrompt.length > 0
    ? `${trimmedPrompt}\n\n${blocks.join("\n\n")}`
    : blocks.join("\n\n");
}

export function buildFileReviewComment(input: {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  text: string;
  contents: string;
}): ReviewCommentContext {
  const startLine = Math.max(1, Math.min(input.startLine, input.endLine));
  const endLine = Math.max(startLine, Math.max(input.startLine, input.endLine));
  const selectedLines = input.contents.split("\n").slice(startLine - 1, endLine);
  return {
    kind: "line",
    id: input.id,
    sectionId: `file:${input.filePath}`,
    sectionTitle: "File comment",
    filePath: input.filePath,
    startIndex: startLine - 1,
    endIndex: endLine - 1,
    rangeLabel: startLine === endLine ? `L${startLine}` : `L${startLine} to L${endLine}`,
    text: input.text.trim(),
    diff: selectedLines.join("\n"),
    fenceLanguage: inferReviewCommentFenceLanguage(input.filePath),
  };
}

export function inferReviewCommentFenceLanguage(filePath: string): string {
  const normalizedPath = filePath.replaceAll("\\", "/");
  const fileName = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1).toLowerCase();
  const extensionIndex = fileName.lastIndexOf(".");
  if (extensionIndex > 0 && extensionIndex < fileName.length - 1) {
    return fileName.slice(extensionIndex + 1);
  }
  if (fileName.startsWith(".") && fileName.length > 1) {
    return fileName.slice(1);
  }
  return "text";
}

function stripTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

function buildDiffReviewLines(
  fileDiff: FileDiffMetadata,
  includeExpandedContext: boolean,
  slice?: { readonly startIndex: number; readonly endIndex: number },
): ReadonlyArray<DiffReviewLine> {
  const rows: DiffReviewLine[] = [];
  let rowIndex = 0;
  let oldContextStart = 1;
  let newContextStart = 1;
  const pushRow = (row: DiffReviewLine) => {
    if (!slice || (rowIndex >= slice.startIndex && rowIndex <= slice.endIndex)) {
      rows.push(row);
    }
    rowIndex += 1;
  };
  const pushContextGap = (oldStart: number, newStart: number, lineCount: number) => {
    const count = Math.max(0, lineCount);
    const firstOffset = slice ? Math.max(0, slice.startIndex - rowIndex) : 0;
    const lastOffset = slice ? Math.min(count - 1, slice.endIndex - rowIndex) : count - 1;
    for (let offset = firstOffset; offset <= lastOffset; offset += 1) {
      rows.push({
        change: "context",
        oldLineNumber: oldStart + offset,
        newLineNumber: newStart + offset,
        content: stripTrailingNewline(fileDiff.additionLines[newStart + offset - 1] ?? ""),
      });
    }
    rowIndex += count;
  };

  for (const hunk of fileDiff.hunks) {
    if (includeExpandedContext) {
      const oldHunkStart = hunk.deletionStart + (hunk.deletionCount === 0 ? 1 : 0);
      const newHunkStart = hunk.additionStart + (hunk.additionCount === 0 ? 1 : 0);
      const contextLines = Math.min(oldHunkStart - oldContextStart, newHunkStart - newContextStart);
      pushContextGap(oldContextStart, newContextStart, contextLines);
    }

    let oldLineNumber = hunk.deletionStart;
    let newLineNumber = hunk.additionStart;
    let deletionLineIndex = hunk.deletionLineIndex;
    let additionLineIndex = hunk.additionLineIndex;

    for (const segment of hunk.hunkContent) {
      if (segment.type === "context") {
        for (let index = 0; index < segment.lines; index += 1) {
          pushRow({
            change: "context",
            oldLineNumber,
            newLineNumber,
            content: stripTrailingNewline(
              fileDiff.additionLines[additionLineIndex] ??
                fileDiff.deletionLines[deletionLineIndex] ??
                "",
            ),
          });
          oldLineNumber += 1;
          newLineNumber += 1;
          deletionLineIndex += 1;
          additionLineIndex += 1;
        }
        continue;
      }

      for (let index = 0; index < segment.deletions; index += 1) {
        pushRow({
          change: "delete",
          oldLineNumber,
          newLineNumber: null,
          content: stripTrailingNewline(fileDiff.deletionLines[deletionLineIndex] ?? ""),
        });
        oldLineNumber += 1;
        deletionLineIndex += 1;
      }

      for (let index = 0; index < segment.additions; index += 1) {
        pushRow({
          change: "add",
          oldLineNumber: null,
          newLineNumber,
          content: stripTrailingNewline(fileDiff.additionLines[additionLineIndex] ?? ""),
        });
        newLineNumber += 1;
        additionLineIndex += 1;
      }
    }

    oldContextStart = hunk.deletionStart + hunk.deletionCount;
    newContextStart = hunk.additionStart + hunk.additionCount;
    if (hunk.deletionCount === 0) oldContextStart += 1;
    if (hunk.additionCount === 0) newContextStart += 1;
  }

  if (includeExpandedContext) {
    const trailingLines = Math.min(
      fileDiff.deletionLines.length - oldContextStart + 1,
      fileDiff.additionLines.length - newContextStart + 1,
    );
    pushContextGap(oldContextStart, newContextStart, trailingLines);
  }

  return rows;
}

function getDiffReviewSelectionPoint(
  line: DiffReviewLine,
): { lineNumber: number; side: SelectionSide } | null {
  if (line.change === "delete" && line.oldLineNumber !== null) {
    return { lineNumber: line.oldLineNumber, side: "deletions" };
  }
  if (line.newLineNumber !== null) {
    return { lineNumber: line.newLineNumber, side: "additions" };
  }
  if (line.oldLineNumber !== null) {
    return { lineNumber: line.oldLineNumber, side: "deletions" };
  }
  return null;
}

export function restoreDiffReviewCommentRange(
  fileDiff: FileDiffMetadata,
  comment: ReviewCommentContext,
): SelectedLineRange | null {
  if (comment.kind !== "line") return null;
  if (comment.selection) return comment.selection;

  const includeExpandedContext = !fileDiff.isPartial;
  const startLine = buildDiffReviewLines(fileDiff, includeExpandedContext, {
    startIndex: comment.startIndex,
    endIndex: comment.startIndex,
  })[0];
  const endLine =
    comment.endIndex === comment.startIndex
      ? startLine
      : buildDiffReviewLines(fileDiff, includeExpandedContext, {
          startIndex: comment.endIndex,
          endIndex: comment.endIndex,
        })[0];
  if (!startLine || !endLine) return null;
  const start = getDiffReviewSelectionPoint(startLine);
  const end = getDiffReviewSelectionPoint(endLine);
  if (!start || !end) return null;
  return {
    start: start.lineNumber,
    side: start.side,
    end: end.lineNumber,
    endSide: end.side,
  };
}

function findDiffReviewLineIndex(
  fileDiff: FileDiffMetadata,
  lineNumber: number,
  side: SelectionSide | undefined,
  includeExpandedContext = !fileDiff.isPartial,
): number {
  const findOnSide = (selectedSide: "left" | "right") => {
    let rowIndex = 0;
    let oldContextStart = 1;
    let newContextStart = 1;
    const findContextIndex = (oldStart: number, newStart: number, lineCount: number) => {
      const count = Math.max(0, lineCount);
      const selectedStart = selectedSide === "left" ? oldStart : newStart;
      const offset = lineNumber - selectedStart;
      return offset >= 0 && offset < count ? rowIndex + offset : -1;
    };

    for (const hunk of fileDiff.hunks) {
      if (includeExpandedContext) {
        const oldContextEnd = hunk.deletionStart + (hunk.deletionCount === 0 ? 1 : 0);
        const newContextEnd = hunk.additionStart + (hunk.additionCount === 0 ? 1 : 0);
        const contextLines = Math.min(
          oldContextEnd - oldContextStart,
          newContextEnd - newContextStart,
        );
        const contextIndex = findContextIndex(oldContextStart, newContextStart, contextLines);
        if (contextIndex >= 0) return contextIndex;
        rowIndex += Math.max(0, contextLines);
      }

      let oldLineNumber = hunk.deletionStart;
      let newLineNumber = hunk.additionStart;
      for (const segment of hunk.hunkContent) {
        if (segment.type === "context") {
          const contextIndex = findContextIndex(oldLineNumber, newLineNumber, segment.lines);
          if (contextIndex >= 0) return contextIndex;
          rowIndex += segment.lines;
          oldLineNumber += segment.lines;
          newLineNumber += segment.lines;
          continue;
        }

        if (
          selectedSide === "left" &&
          lineNumber >= oldLineNumber &&
          lineNumber < oldLineNumber + segment.deletions
        ) {
          return rowIndex + lineNumber - oldLineNumber;
        }
        rowIndex += segment.deletions;
        oldLineNumber += segment.deletions;

        if (
          selectedSide === "right" &&
          lineNumber >= newLineNumber &&
          lineNumber < newLineNumber + segment.additions
        ) {
          return rowIndex + lineNumber - newLineNumber;
        }
        rowIndex += segment.additions;
        newLineNumber += segment.additions;
      }

      oldContextStart = hunk.deletionStart + hunk.deletionCount;
      newContextStart = hunk.additionStart + hunk.additionCount;
      if (hunk.deletionCount === 0) oldContextStart += 1;
      if (hunk.additionCount === 0) newContextStart += 1;
    }

    if (!includeExpandedContext) return -1;
    const trailingLines = Math.min(
      fileDiff.deletionLines.length - oldContextStart + 1,
      fileDiff.additionLines.length - newContextStart + 1,
    );
    return findContextIndex(oldContextStart, newContextStart, trailingLines);
  };

  const selectedSide = side === "deletions" ? "left" : "right";
  const preferredIndex = findOnSide(selectedSide);
  return preferredIndex >= 0
    ? preferredIndex
    : findOnSide(selectedSide === "left" ? "right" : "left");
}

/** Resolve the host-facing coordinates of a line selected in the diff viewer. */
export function resolveDiffReviewPosition(
  fileDiff: FileDiffMetadata,
  lineNumber: number,
  side: SelectionSide | undefined,
): PullRequestReviewPosition | null {
  const lineIndex = findDiffReviewLineIndex(fileDiff, lineNumber, side);
  if (lineIndex < 0) return null;
  const line = buildDiffReviewLines(fileDiff, !fileDiff.isPartial, {
    startIndex: lineIndex,
    endIndex: lineIndex,
  })[0];
  if (line === undefined) return null;

  switch (line.change) {
    case "add":
      return line.newLineNumber === null ? null : { kind: "added", newLine: line.newLineNumber };
    case "delete":
      return line.oldLineNumber === null ? null : { kind: "deleted", oldLine: line.oldLineNumber };
    case "context":
      return line.oldLineNumber === null || line.newLineNumber === null
        ? null
        : {
            kind: "context",
            oldLine: line.oldLineNumber,
            newLine: line.newLineNumber,
            side: side === "deletions" ? "left" : "right",
          };
  }
}

function getDiffRange(
  lines: ReadonlyArray<DiffReviewLine>,
  key: "oldLineNumber" | "newLineNumber",
): { start: number; count: number } {
  const numberedLines = lines.filter((line) => line[key] !== null);
  return {
    start: numberedLines[0]?.[key] ?? 0,
    count: numberedLines.length,
  };
}

function getDiffChangeMarker(change: DiffReviewLine["change"]): string {
  if (change === "add") return "+";
  if (change === "delete") return "-";
  return " ";
}

function formatDiffReviewRangeLabel(lines: ReadonlyArray<DiffReviewLine>): string {
  const firstLine = lines[0];
  const lastLine = lines.at(-1);
  if (!firstLine || !lastLine) return "line";
  const firstNumber = firstLine.newLineNumber ?? firstLine.oldLineNumber;
  const lastNumber = lastLine.newLineNumber ?? lastLine.oldLineNumber;
  if (firstNumber === null || lastNumber === null) {
    return lines.length === 1 ? "line" : `${lines.length} lines`;
  }

  const firstMarker = getDiffChangeMarker(firstLine.change).trim();
  const marker =
    firstMarker.length > 0 && lines.every((line) => line.change === firstLine.change)
      ? firstMarker
      : "";
  return firstNumber === lastNumber
    ? `${marker}${firstNumber}`
    : `${marker}${firstNumber} to ${marker}${lastNumber}`;
}

export function buildDiffReviewComment(input: {
  id: string;
  sectionId: string;
  sectionTitle: string;
  filePath: string;
  fileDiff: FileDiffMetadata;
  range: SelectedLineRange;
  text: string;
}): ReviewCommentContext | null {
  const includeExpandedContext = !input.fileDiff.isPartial;
  const startIndex = findDiffReviewLineIndex(
    input.fileDiff,
    input.range.start,
    input.range.side,
    includeExpandedContext,
  );
  const endIndex = findDiffReviewLineIndex(
    input.fileDiff,
    input.range.end,
    input.range.endSide ?? input.range.side,
    includeExpandedContext,
  );
  if (startIndex < 0 || endIndex < 0) return null;

  const normalizedStartIndex = Math.min(startIndex, endIndex);
  const normalizedEndIndex = Math.max(startIndex, endIndex);
  const selectedLines = buildDiffReviewLines(input.fileDiff, includeExpandedContext, {
    startIndex: normalizedStartIndex,
    endIndex: normalizedEndIndex,
  });
  const oldRange = getDiffRange(selectedLines, "oldLineNumber");
  const newRange = getDiffRange(selectedLines, "newLineNumber");

  return {
    kind: "line",
    id: input.id,
    sectionId: input.sectionId,
    sectionTitle: input.sectionTitle,
    filePath: input.filePath,
    startIndex: normalizedStartIndex,
    endIndex: normalizedEndIndex,
    rangeLabel: formatDiffReviewRangeLabel(selectedLines),
    text: input.text.trim(),
    diff: [
      `@@ -${oldRange.start},${oldRange.count} +${newRange.start},${newRange.count} @@`,
      ...selectedLines.map((line) => `${getDiffChangeMarker(line.change)}${line.content}`),
    ].join("\n"),
    fenceLanguage: "diff",
    selection: {
      start: input.range.start,
      side: input.range.side ?? "additions",
      end: input.range.end,
      endSide: input.range.endSide ?? input.range.side ?? "additions",
    },
  };
}

export function buildReviewCommentRenderablePatch(comment: ReviewCommentContext): string {
  if (comment.kind !== "line") return "";
  if ((comment.fenceLanguage ?? "diff") !== "diff") {
    return "";
  }
  const diff = comment.diff.trim();
  if (diff.length === 0) {
    return "";
  }
  if (diff.startsWith("diff --git ")) {
    return diff;
  }

  const normalizedPath = comment.filePath.replaceAll("\\", "/");
  return [
    `diff --git a/${normalizedPath} b/${normalizedPath}`,
    `--- a/${normalizedPath}`,
    `+++ b/${normalizedPath}`,
    diff,
  ].join("\n");
}
