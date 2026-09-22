import { isLinkablePathText } from "~/markdown-links";
import { FILE_PATH_PATTERN, trimClosingDelimiters, URL_PATTERN } from "~/terminal-links";

/**
 * Loom's two *loose* path scanners for chat markdown, restored after the slice-1
 * re-home onto upstream's ChatMarkdown (which only links explicit markdown links
 * and inline-code spans).
 *
 * Agents constantly name files as bare prose ("the verdict is at
 * `_findings/verdict.md`" written without backticks) and dump paths inside
 * fenced blocks, and both shapes were clickable in loom before the pull. This
 * module is the purely-syntactic half: it says *where* a path-shaped substring
 * sits. Whether a hit becomes a chip is decided elsewhere by the shared
 * existence verification, so a false positive here just stays plain text.
 */

export interface TextPathSpan {
  /** The trimmed path text (trailing punctuation/delimiters removed). */
  readonly text: string;
  /** Start offset of the trimmed span within the scanned string. */
  readonly start: number;
  /** End offset (exclusive) of the trimmed span within the scanned string. */
  readonly end: number;
}

/**
 * Scan a plain string for path-like substrings, reusing the terminal link
 * patterns and trimming so prose/code-block detection matches the terminal
 * exactly. URLs are excluded, trailing punctuation/unbalanced brackets are
 * trimmed, and each remaining candidate must pass the strict
 * {@link isLinkablePathText} gate.
 */
export function matchTextPathSpans(text: string): TextPathSpan[] {
  const urlRanges: Array<readonly [number, number]> = [];
  URL_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? -1;
    if (start >= 0) urlRanges.push([start, start + match[0].length]);
  }

  const spans: TextPathSpan[] = [];
  FILE_PATH_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(FILE_PATH_PATTERN)) {
    const raw = match[0];
    const rawStart = match.index ?? -1;
    if (rawStart < 0 || raw.length === 0) continue;
    // Skip anything overlapping a URL match (e.g. the `//host/path` tail).
    if (urlRanges.some(([us, ue]) => rawStart < ue && us < rawStart + raw.length)) continue;

    const trimmed = trimClosingDelimiters(raw);
    if (trimmed.length === 0) continue;
    if (!isLinkablePathText(trimmed)) continue;

    // trimClosingDelimiters only removes trailing characters, so the trimmed
    // span still starts at the raw match index.
    spans.push({ text: trimmed, start: rawStart, end: rawStart + trimmed.length });
  }
  return spans;
}

// Perf guards for code-block path linking. The DOM decorator skips blocks/lines
// past these bounds, so candidate discovery for existence checks applies the
// SAME bounds — otherwise a huge fenced block that is never decorated would
// still register unbounded path interest and trigger repeated stat RPCs.
export const CODE_BLOCK_MAX_LINES = 400;
export const CODE_LINE_MAX_LENGTH = 2000;
// Hard ceiling on path candidates discovered from a single message, so no one
// message can produce an unbounded stat set regardless of content.
const MAX_MESSAGE_PATH_CANDIDATES = 500;

const FENCE_LINE_PATTERN = /^ {0,3}(`{3,}|~{3,})/;

type MessageSegment = { readonly kind: "prose" | "code"; readonly lines: string[] };

/**
 * Split a markdown message into prose vs fenced-code segments (line-granular),
 * tracking fenced blocks (``` / ~~~, closed by an equal-or-longer run of the
 * same fence character). Indented code blocks count as prose — they are rare in
 * agent output and still bounded by {@link MAX_MESSAGE_PATH_CANDIDATES}.
 */
function splitMessageSegments(text: string): MessageSegment[] {
  const lines = text.split("\n");
  const segments: MessageSegment[] = [];
  let prose: string[] = [];
  const flushProse = () => {
    if (prose.length > 0) {
      segments.push({ kind: "prose", lines: prose });
      prose = [];
    }
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const open = FENCE_LINE_PATTERN.exec(line);
    if (!open) {
      prose.push(line);
      continue;
    }
    flushProse();
    const fence = open[1] ?? "```";
    const fenceChar = fence[0] === "~" ? "~" : "`";
    const closePattern = new RegExp(`^ {0,3}\\${fenceChar}{${fence.length},}\\s*$`);
    const codeLines: string[] = [];
    index += 1;
    while (index < lines.length && !closePattern.test(lines[index] ?? "")) {
      codeLines.push(lines[index] ?? "");
      index += 1;
    }
    // `index` now sits on the closing fence (or past the end); the outer loop's
    // increment steps over it.
    segments.push({ kind: "code", lines: codeLines });
  }
  flushProse();
  return segments;
}

/**
 * Existence-candidate path strings for a whole message, aligned with what the
 * renderers will actually attempt to link and bounded so a single message can
 * never produce an unbounded stat set. Prose is scanned in full; fenced-code
 * segments are scanned line-by-line and skipped entirely when they exceed
 * {@link CODE_BLOCK_MAX_LINES} (matching the DOM decorator), with over-length
 * lines skipped. Prose comes first so ordinary prose paths stay eligible even
 * when a large in-bounds code block follows.
 */
export function extractMessagePathCandidates(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (candidate: string): boolean => {
    if (!seen.has(candidate)) {
      seen.add(candidate);
      out.push(candidate);
    }
    return out.length < MAX_MESSAGE_PATH_CANDIDATES;
  };

  const segments = splitMessageSegments(text);
  const ordered = [
    ...segments.filter((segment) => segment.kind === "prose"),
    ...segments.filter((segment) => segment.kind === "code"),
  ];
  for (const segment of ordered) {
    if (out.length >= MAX_MESSAGE_PATH_CANDIDATES) break;
    if (segment.kind === "code" && segment.lines.length > CODE_BLOCK_MAX_LINES) continue;
    const scanLines = segment.kind === "code" ? segment.lines : [segment.lines.join("\n")];
    for (const line of scanLines) {
      if (segment.kind === "code" && line.length > CODE_LINE_MAX_LENGTH) continue;
      for (const span of matchTextPathSpans(line)) {
        if (!add(span.text)) return out;
      }
    }
  }
  return out;
}

/**
 * Custom hast tag {@link rehypeChatFilePaths} injects around a prose path hit;
 * ChatMarkdown maps it to the component that verifies and renders the chip.
 */
export const PROSE_FILE_PATH_TAG = "t3-file-path";

// Never scan inside these: fenced/inline code is the code decorator's and the
// inline-code chip's business, and an existing link keeps its own behaviour.
const PROSE_FILE_PATH_SKIP_TAGS = new Set(["code", "pre", "a", PROSE_FILE_PATH_TAG]);

interface HastTextNode {
  type: "text";
  value: string;
}
interface HastElementNode {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastChildNode[];
}
type HastChildNode = HastTextNode | HastElementNode | { type: string; children?: HastChildNode[] };

/**
 * A quoted path is part of a command, a directive, or some other literal the
 * renderer deliberately left as text (an escaped or malformed
 * `:codex-file-citation{path="..."}`, a pasted shell argument) rather than a
 * prose reference; prose names files bare. Only the prose scanner applies this
 * — inside a fenced block quoted paths are ordinary code and stay linkable.
 */
function isQuotedInProse(value: string, span: TextPathSpan): boolean {
  const before = value[span.start - 1];
  return before === '"' || before === "'";
}

function buildProsePathNodes(value: string, spans: readonly TextPathSpan[]): HastChildNode[] {
  const nodes: HastChildNode[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) nodes.push({ type: "text", value: value.slice(cursor, span.start) });
    nodes.push({
      type: "element",
      tagName: PROSE_FILE_PATH_TAG,
      properties: {},
      children: [{ type: "text", value: value.slice(span.start, span.end) }],
    });
    cursor = span.end;
  }
  if (cursor < value.length) nodes.push({ type: "text", value: value.slice(cursor) });
  return nodes;
}

/**
 * Rehype plugin: split plain-prose text nodes on path-like substrings and inject
 * {@link PROSE_FILE_PATH_TAG} elements for them. Runs *after* rehype-sanitize so
 * the injected (trusted) nodes are not stripped, and skips code/pre/anchor
 * subtrees so inline code, fenced blocks and existing links keep their own
 * handling. The mapped component decides whether each hit resolves to a file
 * that exists.
 */
export function rehypeChatFilePaths() {
  return (tree: { children?: HastChildNode[] }) => {
    const visit = (node: { children?: HastChildNode[] }) => {
      const children = node.children;
      if (!children) return;
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index];
        if (!child) continue;
        if (child.type === "text") {
          const value = (child as HastTextNode).value;
          const spans = matchTextPathSpans(value).filter((span) => !isQuotedInProse(value, span));
          if (spans.length === 0) continue;
          const replacement = buildProsePathNodes(value, spans);
          children.splice(index, 1, ...replacement);
          index += replacement.length - 1;
        } else if (child.type === "element") {
          if (PROSE_FILE_PATH_SKIP_TAGS.has((child as HastElementNode).tagName)) continue;
          visit(child as HastElementNode);
        }
      }
    };
    visit(tree);
  };
}
