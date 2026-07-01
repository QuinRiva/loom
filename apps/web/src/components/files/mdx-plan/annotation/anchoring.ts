import type { PlanCommentAnchor, PlanCommentTargetKind } from "@t3tools/contracts";

/**
 * Rendered-MDX anchoring engine — serialise a DOM `Range` into a portable
 * {@link PlanCommentAnchor} and re-resolve that anchor back to a live `Range`
 * after a re-render (or to `null` when the target is gone / "detached").
 *
 * Ported to TypeScript from the validated spike (`scratch-mdx-spike/anchoring.mjs`,
 * 7/7). Two things the port adds over the spike:
 *   1. Section is derived from the nearest preceding heading (the MDX render is a
 *      flat sibling list under `[data-plan-root]`, so there is no ancestor
 *      `data-plan-section-id` element to climb to).
 *   2. A tagged union over `anchorKind`: prose selections resolve via text-quote
 *      + context disambiguation (`"text"`); selections inside a structured,
 *      non-prose block fall back to a whole-block anchor keyed on the rendered
 *      `data-plan-block-id` (`"visual"`). The resolver dispatches on
 *      `anchorKind`, so Phase 4 can add `wireframe`/`canvas` kinds without a
 *      rewrite of the text path.
 */

const CTX = 32; // chars of context captured either side for disambiguation
const BLOCK_SNIPPET_MAX = 280;

/** Block types whose bodies are not prose — a selection inside these falls back
 * to a whole-block anchor rather than a text-quote (nothing sensible to quote). */
export const NON_PROSE_BLOCK_TYPES = new Set([
  "code",
  "annotated-code",
  "diagram",
  "data-model",
  "file-tree",
  "question-form",
  "json-explorer",
]);

/** Map a plan block type to the anchor's coarse `targetKind`. */
function targetKindForBlock(blockType: string | null): PlanCommentTargetKind {
  switch (blockType) {
    case "code":
    case "annotated-code":
    case "json-explorer":
      return "code";
    case "diagram":
      return "diagram";
    case "data-model":
      return "table";
    case "question-form":
      return "control";
    default:
      return "block";
  }
}

interface TextSpan {
  node: Text;
  start: number;
  end: number;
}

function collectTextNodes(root: Node): Text[] {
  const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    nodes.push(current as Text);
    current = walker.nextNode();
  }
  return nodes;
}

/** Flatten a subtree's text nodes into one string + a prefix-offset index. */
function flatten(root: Node): { text: string; spans: TextSpan[] } {
  let text = "";
  const spans = collectTextNodes(root).map((node) => {
    const start = text.length;
    text += node.data;
    return { node, start, end: text.length };
  });
  return { text, spans };
}

function locate(spans: TextSpan[], offset: number): { node: Text; offset: number } {
  const span = spans.find((s) => offset >= s.start && offset <= s.end) ?? spans[spans.length - 1]!;
  return { node: span.node, offset: offset - span.start };
}

function asElement(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

/** The custom plan block ([data-plan-block-type]) enclosing a node, if any. */
export function enclosingBlock(node: Node): { element: Element; id: string; type: string } | null {
  const element = asElement(node)?.closest("[data-plan-block-type]");
  if (!element) return null;
  return {
    element,
    id: element.getAttribute("data-plan-block-id") ?? "",
    type: element.getAttribute("data-plan-block-type") ?? "",
  };
}

/** Nearest preceding heading = the "section" a node belongs to. */
function sectionFor(node: Node, root: Element): { id: string; title: string } | null {
  let el: Element | null = asElement(node);
  // Climb to the top-level child of the plan root.
  while (el && el.parentElement && el.parentElement !== root) el = el.parentElement;
  // Walk backwards over previous siblings (incl. self) to the nearest heading.
  while (el) {
    if (/^H[1-6]$/.test(el.tagName)) {
      const title = el.textContent?.trim() ?? "";
      const id = el.getAttribute("data-plan-block-id") || title || "section";
      return { id, title: title || "Section" };
    }
    el = el.previousElementSibling;
  }
  return null;
}

function collapse(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const suffixOverlap = (a: string, b: string): number => {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
};
const prefixOverlap = (a: string, b: string): number => {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
};

/** Serialise a selection into an anchor + the passage/preview it evidences.
 *
 * A selection inside a non-prose block yields a whole-block (`"visual"`) anchor;
 * anything else yields a text-quote (`"text"`) anchor. Returns `null` when the
 * selection carries no usable target (empty quote outside any block). */
export function anchorFromRange(
  range: Range,
  root: Element,
): { anchor: PlanCommentAnchor; quotedText: string } | null {
  const block = enclosingBlock(range.commonAncestorContainer);
  const section = sectionFor(range.commonAncestorContainer, root);
  const sectionFields = section ? { sectionId: section.id, sectionTitle: section.title } : {};

  if (block && NON_PROSE_BLOCK_TYPES.has(block.type)) {
    const quotedText = collapse(block.element.textContent ?? "", BLOCK_SNIPPET_MAX);
    return {
      anchor: {
        anchorKind: "visual",
        targetKind: targetKindForBlock(block.type),
        blockType: block.type,
        targetSelector: `[data-plan-block-id="${block.id}"]`,
        snippet: quotedText || undefined,
        ...sectionFields,
      },
      quotedText: quotedText || block.type,
    };
  }

  const { text, spans } = flatten(root);
  const offsetOf = (node: Node, nodeOffset: number): number => {
    const span = spans.find((s) => s.node === node);
    return (span ? span.start : 0) + nodeOffset;
  };
  const start = offsetOf(range.startContainer, range.startOffset);
  const end = offsetOf(range.endContainer, range.endOffset);
  const textQuote = text.slice(start, end);
  if (!textQuote.trim()) return null;

  return {
    anchor: {
      anchorKind: "text",
      targetKind: "text",
      textQuote,
      contextBefore: text.slice(Math.max(0, start - CTX), start),
      contextAfter: text.slice(end, end + CTX),
      blockType: block?.type,
      ...sectionFields,
    },
    quotedText: textQuote,
  };
}

/** Serialise a whole top-level block element into a `"visual"` anchor. Used by
 * the per-block "comment" affordance (no text selection needed) so a reviewer
 * can always comment on a block, prose or not. */
export function anchorForBlockElement(
  element: Element,
  root: Element,
): { anchor: PlanCommentAnchor; quotedText: string } {
  const type = element.getAttribute("data-plan-block-type");
  const id = element.getAttribute("data-plan-block-id") ?? "";
  const section = sectionFor(element, root);
  const quotedText = collapse(element.textContent ?? "", BLOCK_SNIPPET_MAX);
  return {
    anchor: {
      anchorKind: "visual",
      targetKind: targetKindForBlock(type),
      blockType: type ?? undefined,
      targetSelector: `[data-plan-block-id="${id}"]`,
      snippet: quotedText || undefined,
      ...(section ? { sectionId: section.id, sectionTitle: section.title } : {}),
    },
    quotedText: quotedText || type || "block",
  };
}

/** Re-resolve an anchor to a live `Range`, or `null` when it is detached. */
export function resolveAnchor(anchor: PlanCommentAnchor, root: Element): Range | null {
  if (anchor.anchorKind === "visual" || (anchor.targetSelector && !anchor.textQuote)) {
    if (!anchor.targetSelector) return null;
    const element = root.querySelector(anchor.targetSelector);
    if (!element) return null;
    const range = root.ownerDocument!.createRange();
    range.selectNode(element);
    return range;
  }

  const quote = anchor.textQuote;
  if (!quote) return null;
  const { text, spans } = flatten(root);
  if (spans.length === 0) return null;

  const hits: number[] = [];
  for (let i = text.indexOf(quote); i !== -1; i = text.indexOf(quote, i + 1)) hits.push(i);
  if (hits.length === 0) return null; // detached: quoted text is gone

  const score = (i: number): number => {
    const before = text.slice(Math.max(0, i - CTX), i);
    const after = text.slice(i + quote.length, i + quote.length + CTX);
    return (
      suffixOverlap(anchor.contextBefore ?? "", before) +
      prefixOverlap(anchor.contextAfter ?? "", after)
    );
  };
  const best = hits.reduce((a, b) => (score(b) > score(a) ? b : a), hits[0]!);

  const range = root.ownerDocument!.createRange();
  const s = locate(spans, best);
  const e = locate(spans, best + quote.length);
  range.setStart(s.node, s.offset);
  range.setEnd(e.node, e.offset);
  return range;
}
