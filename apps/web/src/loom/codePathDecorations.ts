import type { MarkdownFileLinkMeta } from "~/markdown-links";

import { CODE_BLOCK_MAX_LINES, CODE_LINE_MAX_LENGTH, matchTextPathSpans } from "./chatPathScan";

/**
 * Decorates file paths in a rendered Shiki code block by reparenting existing text nodes into `<a>`s,
 * so `textContent` (and every copy) stays byte-identical and token spans are untouched. Safe against
 * React: every `.line` walked is in a `dangerouslySetInnerHTML` subtree, so React owns no text node
 * here, and a changed line is re-rendered wholesale and re-decorated by the effect.
 */

/** Shared with the prose scanner's anchor, so both forms look and behave alike. */
export const SCANNED_PATH_LINK_CLASS_NAME = "chat-scanned-path-link";

export interface CodePathTarget {
  readonly meta: MarkdownFileLinkMeta;
}

interface ResolvedRange {
  readonly start: number;
  readonly end: number;
  readonly target: CodePathTarget;
}

/** Unwrap any decorations from a prior pass so re-decoration is idempotent. */
function unwrapExistingDecorations(container: HTMLElement): void {
  for (const link of container.querySelectorAll(`a.${SCANNED_PATH_LINK_CLASS_NAME}`)) {
    link.parentNode?.replaceChild(link.ownerDocument.createTextNode(link.textContent ?? ""), link);
  }
  // Merge adjacent text nodes split by a previous pass so offsets align again.
  container.normalize();
}

/**
 * Wrap `ranges` (offsets into `lineEl`'s text content) in anchors by splitting text nodes so each
 * covered slice is its own node, then reparenting it. A range spanning several token `<span>`s
 * yields one anchor per token, visually contiguous.
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
  options: {
    /** Resolve a raw path substring to a click target, or null to leave it plain. */
    readonly resolveTarget: (rawPath: string) => CodePathTarget | null;
    /** Invoked when a decorated path is activated (clicked). */
    readonly onActivate: (target: CodePathTarget) => void;
  },
): void {
  unwrapExistingDecorations(container);

  const lineElements = container.querySelectorAll<HTMLElement>(".line");
  const lines = lineElements.length > 0 ? [...lineElements] : [container];
  if (lines.length > CODE_BLOCK_MAX_LINES) return;

  for (const lineElement of lines) {
    const text = lineElement.textContent ?? "";
    if (text.length === 0 || text.length > CODE_LINE_MAX_LENGTH) continue;

    const ranges = matchTextPathSpans(text).flatMap((span) => {
      const target = options.resolveTarget(span.text);
      return target ? [{ start: span.start, end: span.end, target }] : [];
    });
    if (ranges.length === 0) continue;

    decorateLineElement(lineElement, ranges, (value, target) => {
      const anchor = lineElement.ownerDocument.createElement("a");
      anchor.className = SCANNED_PATH_LINK_CLASS_NAME;
      anchor.textContent = value;
      anchor.setAttribute("href", target.meta.targetPath);
      // The clipboard serialiser honours this, so a copied selection carries the
      // raw path rather than a `[text](href)` markdown link.
      anchor.setAttribute("data-markdown-copy", value);
      anchor.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        options.onActivate(target);
      });
      return anchor;
    });
  }
}
