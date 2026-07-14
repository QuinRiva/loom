import {
  CODE_BLOCK_MAX_LINES,
  CODE_LINE_MAX_LENGTH,
  matchTextPathSpans,
  type MarkdownFileLinkMeta,
} from "./markdown-links";

/**
 * In-place, copy-fidelity-preserving decoration of file paths inside a rendered
 * (Shiki-highlighted) code block. Path substrings are wrapped in inert `<a>`
 * elements so they become clickable/underline-on-hover *without* changing the
 * block's text content: wrapping only reparents existing text nodes, so
 * `Element.textContent` (and therefore copy) is byte-identical to the original.
 *
 * The scan is syntactic ({@link matchTextPathSpans}); the caller's
 * `resolveTarget` decides which hits actually resolve to an existing target, so
 * a false-positive path simply stays undecorated plain text.
 */

export const CODE_PATH_LINK_CLASS_NAME = "chat-code-path-link";

export interface CodePathTarget {
  readonly meta: MarkdownFileLinkMeta;
  readonly isDirectory: boolean;
}

export interface DecorateCodeBlockPathsOptions {
  /** Resolve a raw path substring to a click target, or null to leave it plain. */
  readonly resolveTarget: (rawPath: string) => CodePathTarget | null;
  /** Invoked when a decorated path is activated (clicked). */
  readonly onActivate: (target: CodePathTarget) => void;
  /** Skip blocks larger than this many lines (perf guard). Default {@link CODE_BLOCK_MAX_LINES}. */
  readonly maxLines?: number;
  /** Skip individual lines longer than this many chars (perf guard). Default {@link CODE_LINE_MAX_LENGTH}. */
  readonly maxLineLength?: number;
}

interface ResolvedRange {
  readonly start: number;
  readonly end: number;
  readonly target: CodePathTarget;
}

/** Unwrap any decorations from a prior pass so re-decoration is idempotent. */
function unwrapExistingDecorations(container: HTMLElement): void {
  const links = container.querySelectorAll(`a.${CODE_PATH_LINK_CLASS_NAME}`);
  for (const link of links) {
    const parent = link.parentNode;
    if (!parent) continue;
    parent.replaceChild(link.ownerDocument.createTextNode(link.textContent ?? ""), link);
  }
  // Merge adjacent text nodes split by a previous pass so offsets align again.
  container.normalize();
}

/**
 * Wrap `ranges` (offsets into `lineEl`'s text content) in anchors. Walks the
 * line's text nodes and splits each so the covered slice becomes its own node,
 * then reparents it into an anchor. A range spanning several highlight token
 * `<span>`s yields one anchor per token — visually contiguous, and text
 * content is preserved regardless.
 */
function decorateLineElement(
  lineEl: HTMLElement,
  ranges: readonly ResolvedRange[],
  makeAnchor: (text: string, target: CodePathTarget) => HTMLAnchorElement,
): void {
  const walker = lineEl.ownerDocument.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);
  const textNodes: Array<{ node: Text; start: number; end: number }> = [];
  let offset = 0;
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    const node = current as Text;
    const length = node.nodeValue?.length ?? 0;
    textNodes.push({ node, start: offset, end: offset + length });
    offset += length;
  }

  for (const { node, start, end } of textNodes) {
    // Local ranges within this text node, right-to-left so a split never shifts
    // the offsets of a not-yet-processed (earlier) range in the same node.
    const localRanges = ranges
      .map((range) => ({
        start: Math.max(range.start, start) - start,
        end: Math.min(range.end, end) - start,
        target: range.target,
      }))
      .filter((range) => range.end > range.start)
      .sort((a, b) => b.start - a.start);

    for (const range of localRanges) {
      node.splitText(range.end);
      const middle = node.splitText(range.start);
      middle.replaceWith(makeAnchor(middle.nodeValue ?? "", range.target));
    }
  }
}

export function decorateCodeBlockPaths(
  container: HTMLElement,
  options: DecorateCodeBlockPathsOptions,
): void {
  const maxLines = options.maxLines ?? CODE_BLOCK_MAX_LINES;
  const maxLineLength = options.maxLineLength ?? CODE_LINE_MAX_LENGTH;

  unwrapExistingDecorations(container);

  const lineElements = container.querySelectorAll<HTMLElement>(".line");
  const lines: HTMLElement[] = lineElements.length > 0 ? [...lineElements] : [container];
  if (lines.length > maxLines) return;

  for (const lineElement of lines) {
    const text = lineElement.textContent ?? "";
    if (text.length === 0 || text.length > maxLineLength) continue;

    const spans = matchTextPathSpans(text);
    if (spans.length === 0) continue;

    const ranges: ResolvedRange[] = [];
    for (const span of spans) {
      const target = options.resolveTarget(span.text);
      if (target) ranges.push({ start: span.start, end: span.end, target });
    }
    if (ranges.length === 0) continue;

    decorateLineElement(lineElement, ranges, (value, target) => {
      const anchor = lineElement.ownerDocument.createElement("a");
      anchor.className = CODE_PATH_LINK_CLASS_NAME;
      anchor.textContent = value;
      anchor.setAttribute("href", target.meta.targetPath);
      anchor.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        options.onActivate(target);
      });
      return anchor;
    });
  }
}
