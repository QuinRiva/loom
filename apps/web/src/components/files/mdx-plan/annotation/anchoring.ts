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

/** Escape an id for a quoted attribute selector so a malformed authored id
 * (quotes, brackets, backslashes) can never produce an invalid selector. Uses
 * `CSS.escape` when available (browser), else a quote/backslash fallback (jsdom
 * test env sometimes has no global `CSS`). */
const escapeId = (id: string): string =>
  typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id.replace(/["\\]/g, "\\$&");

/** A whole-block anchor selector with the id safely escaped. */
export const blockSelector = (id: string): string => `[data-plan-block-id="${escapeId(id)}"]`;

/** Artboard block types whose contents are positioned HTML (wireframe / design
 * screens), annotated by node pin rather than text-quote or whole-block. Both
 * render into the live DOM (§1.1 of the Phase-4 scoping), so their pinned nodes
 * carry real client rects — the overlay geometry model is identical to prose. */
export const WIREFRAME_BLOCK_TYPES = new Set(["wireframe", "design"]);

/** A pixel-space box relative to the board container that a coordinate anchor
 * resolves to. Distinct from a DOM `Range` (which free-floating canvas notes
 * have no element to produce) — the canvas overlay draws from this directly. */
export interface AnchorBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Board→pixel transform the canvas layout renderer (a later wave) owns and
 * hands this branch. Board units are the free-floating coordinate space canvas
 * notes are authored in; the renderer maps them to on-screen pixels relative to
 * the board container (accounting for pan/zoom). This is the contract the canvas
 * renderer must provide for `anchorKind:"canvas"` resolution. */
export interface CanvasTransform {
  /** Map a board-space point to a pixel point relative to the board container. */
  boardToPixel(point: { x: number; y: number }): { x: number; y: number };
  /** Board-units → pixels multiplier, for sizing an optional region box. */
  boardScale: number;
}

/** Fallback pixel footprint (in board units, pre-scale) for a point anchor with
 * no authored region size, so it still overlays a visible marker. */
const CANVAS_POINT_SIZE = 12;

/** Count non-overlapping occurrences of `needle` in `haystack`. */
const countOccurrences = (haystack: string, needle: string): number => {
  if (!needle) return 0;
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) count++;
  return count;
};

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
  "checklist",
  "table",
  "visual-questions",
  "diff",
  "openapi-spec",
  "mermaid",
]);

/** Map a plan block type to the anchor's coarse `targetKind`. */
function targetKindForBlock(blockType: string | null): PlanCommentTargetKind {
  switch (blockType) {
    case "code":
    case "annotated-code":
    case "json-explorer":
    case "diff":
    case "openapi-spec":
      return "code";
    case "diagram":
    case "mermaid":
      return "diagram";
    case "data-model":
    case "table":
      return "table";
    case "question-form":
    case "visual-questions":
      return "control";
    case "wireframe":
    case "design":
      return "wireframe";
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

/** The custom plan block ([data-plan-block-type]) enclosing a node, if any. For a
 * selection inside a block nested in a container (`Columns`/`Tabs`), `closest`
 * returns the *nearest* block ancestor — the nested block, not the container — so
 * whole-block anchoring keys on the nested block (which `assignBlockIds` gives a
 * unique id). */
export function enclosingBlock(node: Node): { element: Element; id: string; type: string } | null {
  const element = asElement(node)?.closest("[data-plan-block-type]");
  if (!element) return null;
  return {
    element,
    id: element.getAttribute("data-plan-block-id") ?? "",
    type: element.getAttribute("data-plan-block-type") ?? "",
  };
}

/** Nearest preceding heading = the "section" a node belongs to. A nested block's
 * section is still a *document-level* heading: the climb rises to the top-level
 * child of the plan root (through any container) before scanning prior siblings,
 * so nesting depth never changes which section a node reports. */
function sectionFor(node: Node, root: Element): { id: string; title: string } | null {
  let el: Element | null = asElement(node);
  // Climb to the top-level child of the plan root (through any container block).
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

  // A selection inside a wireframe/design artboard pins the innermost element it
  // lands on (node pin), not a text-quote — the artboard is positioned HTML.
  if (block && WIREFRAME_BLOCK_TYPES.has(block.type)) {
    const target = asElement(range.startContainer) ?? block.element;
    const pin = anchorForWireframeNode(target, root);
    if (pin) return pin;
  }

  if (block && NON_PROSE_BLOCK_TYPES.has(block.type)) {
    const quotedText = collapse(block.element.textContent ?? "", BLOCK_SNIPPET_MAX);
    return {
      anchor: {
        anchorKind: "visual",
        targetKind: targetKindForBlock(block.type),
        blockType: block.type,
        targetSelector: blockSelector(block.id),
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
      ...(countOccurrences(text, textQuote) > 1 ? { ambiguous: true } : {}),
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
      targetSelector: blockSelector(id),
      snippet: quotedText || undefined,
      ...(section ? { sectionId: section.id, sectionTitle: section.title } : {}),
    },
    quotedText: quotedText || type || "block",
  };
}

/** The structural child-index path from an artboard down to a target element
 * (e.g. `"0/2"`), used as a fallback locator when the `data-wf-node` id is
 * absent or regenerated by a re-render. Empty when target *is* the artboard. */
function nodePathWithin(artboard: Element, target: Element): string {
  const indices: number[] = [];
  let el: Element = target;
  while (el !== artboard) {
    const parentEl: Element | null = el.parentElement;
    if (!parentEl) return ""; // target escaped the artboard — no usable path
    indices.unshift(Array.prototype.indexOf.call(parentEl.children, el));
    el = parentEl;
  }
  return indices.join("/");
}

/** Walk a `nodePathWithin` chain from an artboard back to its element. */
function elementAtPath(artboard: Element, path: string): Element | null {
  let el: Element | null = artboard;
  for (const seg of path.split("/").filter(Boolean)) {
    const idx = Number(seg);
    if (!Number.isInteger(idx)) return null;
    el = el?.children[idx] ?? null;
    if (!el) return null;
  }
  return el;
}

/** Resolve a wireframe node pin within its artboard: prefer the stable
 * `data-wf-node` id, fall back to the structural path, else `null` (detached). */
function resolveWireframeNode(artboard: Element, anchor: PlanCommentAnchor): Element | null {
  if (anchor.targetNodeId) {
    try {
      const byId = artboard.querySelector(`[data-wf-node="${escapeId(anchor.targetNodeId)}"]`);
      if (byId) return byId;
    } catch {
      /* malformed id → fall through to the path locator */
    }
  }
  return anchor.targetNodePath ? elementAtPath(artboard, anchor.targetNodePath) : null;
}

/** Serialise a pin on an element inside a wireframe/design artboard into a
 * `"wireframe"` anchor: `targetSelector` = the enclosing artboard,
 * `targetNodeId` = the element's stable `data-wf-node` id (stamped by the
 * wireframe renderer, a later wave), `targetNodePath` = a structural fallback.
 * Returns `null` when the element is not inside an artboard. */
export function anchorForWireframeNode(
  target: Element,
  root: Element,
): { anchor: PlanCommentAnchor; quotedText: string } | null {
  const artboard = target.closest<HTMLElement>(
    '[data-plan-block-type="wireframe"],[data-plan-block-type="design"]',
  );
  if (!artboard) return null;
  const wfNode = target.closest<HTMLElement>("[data-wf-node]");
  const nodeEl = wfNode && artboard.contains(wfNode) ? wfNode : target;
  const targetNodeId = nodeEl.getAttribute("data-wf-node") ?? undefined;
  const blockType = artboard.getAttribute("data-plan-block-type") ?? undefined;
  const section = sectionFor(artboard, root);
  const snippet = collapse(nodeEl.textContent ?? "", BLOCK_SNIPPET_MAX);
  return {
    anchor: {
      anchorKind: "wireframe",
      targetKind: "wireframe",
      blockType,
      targetSelector: blockSelector(artboard.getAttribute("data-plan-block-id") ?? ""),
      targetNodeId: targetNodeId || undefined,
      targetNodePath: nodePathWithin(artboard, nodeEl) || undefined,
      snippet: snippet || undefined,
      ...(section ? { sectionId: section.id, sectionTitle: section.title } : {}),
    },
    quotedText: snippet || targetNodeId || blockType || "wireframe",
  };
}

/** Serialise a free-floating board-space point (optionally a region) into a
 * `"canvas"` anchor. The canvas renderer captures a click, inverts its own
 * transform to board units, and calls this; resolution is via
 * {@link resolveCanvasAnchor}. Node-pinned canvas notes use the wireframe
 * branch instead — only truly free-floating markup needs this. */
export function anchorForCanvasPoint(board: {
  x: number;
  y: number;
  width?: number;
  height?: number;
}): PlanCommentAnchor {
  return {
    anchorKind: "canvas",
    targetKind: "canvas",
    canvasX: board.x,
    canvasY: board.y,
    ...(board.width !== undefined ? { canvasWidth: board.width } : {}),
    ...(board.height !== undefined ? { canvasHeight: board.height } : {}),
  };
}

/** Resolve a `"canvas"` anchor to a pixel-space box via the board→pixel
 * transform the canvas renderer provides, or `null` when the anchor carries no
 * board coordinates (detached). Guarded: never throws for a bad anchor. */
export function resolveCanvasAnchor(
  anchor: PlanCommentAnchor,
  transform: CanvasTransform,
): AnchorBox | null {
  if (anchor.anchorKind !== "canvas") return null;
  if (anchor.canvasX === undefined || anchor.canvasY === undefined) return null;
  const origin = transform.boardToPixel({ x: anchor.canvasX, y: anchor.canvasY });
  return {
    x: origin.x,
    y: origin.y,
    width: (anchor.canvasWidth ?? CANVAS_POINT_SIZE) * transform.boardScale,
    height: (anchor.canvasHeight ?? CANVAS_POINT_SIZE) * transform.boardScale,
  };
}

/** Re-resolve an anchor to a live `Range`, or `null` when it is detached.
 * Canvas coordinate anchors have no element — resolve those via
 * {@link resolveCanvasAnchor} instead (this returns `null` for them). */
export function resolveAnchor(anchor: PlanCommentAnchor, root: Element): Range | null {
  if (anchor.anchorKind === "wireframe") {
    if (!anchor.targetSelector) return null;
    let artboard: Element | null;
    try {
      artboard = root.querySelector(anchor.targetSelector);
    } catch {
      return null; // malformed selector → detached rather than throw
    }
    const node = artboard && resolveWireframeNode(artboard, anchor);
    if (!node) return null;
    const range = root.ownerDocument!.createRange();
    range.selectNode(node);
    return range;
  }
  if (anchor.anchorKind === "canvas") return null; // resolve via resolveCanvasAnchor

  if (anchor.anchorKind === "visual" || (anchor.targetSelector && !anchor.textQuote)) {
    if (!anchor.targetSelector) return null;
    let element: Element | null;
    try {
      element = root.querySelector(anchor.targetSelector);
    } catch {
      return null; // malformed selector → treat as detached rather than throw
    }
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
