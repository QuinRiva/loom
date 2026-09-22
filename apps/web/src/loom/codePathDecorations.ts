import type { MarkdownFileLinkMeta } from "~/markdown-links";

import { CODE_BLOCK_MAX_LINES, CODE_LINE_MAX_LENGTH, matchTextPathSpans } from "./chatPathScan";

/**
 * In-place, copy-fidelity-preserving decoration of file paths inside a rendered
 * (Shiki-highlighted) code block. The fence reads exactly as the agent wrote it
 * and the path substring itself is what you click: each hit is wrapped in an
 * `<a>` *without* changing the block's text content, since wrapping only
 * reparents existing text nodes. `Element.textContent` (and therefore a manual
 * selection copy, and the Copy button) is byte-identical to the original, and
 * the highlight token spans are untouched.
 *
 * Safe against React: every `.line` this walks lives inside a
 * `dangerouslySetInnerHTML` subtree (both the cached-HTML block and the
 * incremental per-line renderer), so React owns no text node here. A line whose
 * HTML changes is re-rendered wholesale by React and re-decorated by the effect.
 *
 * The scan is syntactic ({@link matchTextPathSpans}); the caller's
 * `resolveTarget` decides which hits actually resolve to an existing file, so a
 * false-positive path simply stays undecorated plain text.
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
 * Wrap `ranges` (offsets into `lineEl`'s text content) in anchors. Walks the
 * line's text nodes and splits each so the covered slice becomes its own node,
 * then reparents it into an anchor. A range spanning several highlight token
 * `<span>`s yields one anchor per token — visually contiguous, and text content
 * is preserved regardless.
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
