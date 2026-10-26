import type { PlanCommentAnchor, PlanCommentTargetKind } from "@t3tools/contracts";

/**
 * Serialises a DOM `Range` into a portable {@link PlanCommentAnchor} and re-resolves
 * it to a live `Range` after a re-render (`null` when detached). Sections come from
 * the nearest preceding heading: the MDX render is a flat sibling list under
 * `[data-plan-root]`, so there is no section ancestor to climb to.
 */

const CTX = 32; // chars of context captured either side for disambiguation
const BLOCK_SNIPPET_MAX = 280;

/** Escape an id for a quoted attribute selector so a malformed authored id
 * (quotes, brackets, backslashes) can never produce an invalid selector. Uses
 * `CSS.escape` when available (browser), else a quote/backslash fallback (jsdom
 * test env sometimes has no global `CSS`). */
export const escapeId = (id: string): string =>
  typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id.replace(/["\\]/g, "\\$&");

/** A whole-block anchor selector with the id safely escaped. */
export const blockSelector = (id: string): string => `[data-plan-block-id="${escapeId(id)}"]`;

/** Artboard block types whose contents are positioned HTML (wireframe / design
 * screens), annotated by node pin rather than text-quote or whole-block. Both
 * render into the live DOM (§1.1 of the Phase-4 scoping), so their pinned nodes
 * carry real client rects — the overlay geometry model is identical to prose. */
const WIREFRAME_BLOCK_TYPES = new Set(["wireframe", "design"]);

/** A pixel-space box relative to the board container that a coordinate anchor
 * resolves to. Distinct from a DOM `Range` (which free-floating canvas notes
 * have no element to produce) — the canvas overlay draws from this directly. */
export interface AnchorBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Board→pixel transform the canvas renderer provides for `anchorKind:"canvas"`
 * resolution: maps free-floating board units to pixels relative to the board
 * container, accounting for pan/zoom. */
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

/** Block types whose DOM text order is not visual order (`diagram`, `mermaid`) or
 * that a host-document `Range` cannot reach (`prototype`, `html` iframes), so any
 * selection inside them anchors to the whole block. Every other block anchors to
 * exactly the selected text. */
const OPAQUE_BLOCK_TYPES = new Set(["diagram", "mermaid", "prototype", "html"]);

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
    case "review-choice":
      return "control";
    case "field-diff":
      return "table";
    case "wireframe":
    case "design":
      return "wireframe";
    case "prototype":
      return "prototype";
    default:
      return "block";
  }
}

interface TextSpan {
  node: Text;
  start: number;
  end: number;
}

/** A document flattened to its concatenated text + a prefix-offset index over
 * the source text nodes. Produced once per overlay recompute pass and shared
 * across every text-quote {@link resolveAnchor} so the pass is O(document +
 * comments) rather than O(comments × document). */
export interface FlattenedDocument {
  text: string;
  spans: TextSpan[];
}

/** Tags that open a new line box. {@link flattenDocument} inserts a separator
 * before them so a selection across two table cells does not read as `"budget120"`;
 * the same function captures and re-resolves quotes, so the round-trip holds. */
const BOUNDARY_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BR", "DD", "DETAILS", "DIV", "DL", "DT",
  "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6",
  "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "SUMMARY", "TABLE",
  "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
]); // prettier-ignore
const BOUNDARY_SEP = "\n";

/** Flatten a subtree's text into one string + a prefix-offset index over its
 * text nodes, with a newline at every block boundary (see {@link BOUNDARY_TAGS}). */
const NON_CONTENT_TAGS = new Set(["style", "script"]);

export function flattenDocument(root: Node): FlattenedDocument {
  // A rendered diagram's SVG carries a <style> sheet; its text is not content.
  const walker = root.ownerDocument!.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    (node) =>
      node.nodeType === Node.ELEMENT_NODE && NON_CONTENT_TAGS.has((node as Element).localName)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  );
  let text = "";
  const spans: TextSpan[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (BOUNDARY_TAGS.has((node as Element).tagName) && text && !text.endsWith(BOUNDARY_SEP))
        text += BOUNDARY_SEP;
      continue;
    }
    const start = text.length;
    text += (node as Text).data;
    spans.push({ node: node as Text, start, end: text.length });
  }
  return { text, spans };
}

/** Map a flattened offset back to a text node + node offset. An offset landing
 * inside a boundary separator (no text node owns it) snaps to the start of the
 * next node; the result is clamped so a `Range` endpoint can never overflow. */
function locate(spans: TextSpan[], offset: number): { node: Text; offset: number } {
  const span =
    spans.find((s) => offset >= s.start && offset <= s.end) ??
    spans.find((s) => s.start > offset) ??
    spans[spans.length - 1]!;
  return {
    node: span.node,
    offset: Math.min(Math.max(offset - span.start, 0), span.node.data.length),
  };
}

function asElement(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

/** The plan block ([data-plan-block-type]) enclosing a node. Inside a container
 * (`Columns`/`Tabs`), `closest` returns the nested block, not the container, so
 * whole-block anchors key on the nested block's unique id. */
export function enclosingBlock(node: Node): { element: Element; id: string; type: string } | null {
  const element = asElement(node)?.closest("[data-plan-block-type]");
  if (!element) return null;
  return {
    element,
    id: element.getAttribute("data-plan-block-id") ?? "",
    type: element.getAttribute("data-plan-block-type") ?? "",
  };
}

/** The visible handle and collapse actions for a node hidden inside closed
 * `<details>` or hidden tab panels. The badge goes on the OUTERMOST surface's handle,
 * since inner handles are hidden by the outer one. `null` means not collapsed: the
 * layer classifies a zero-rects annotation as `collapsed` only when this is set. */
export interface CollapsedSurface {
  /** Nearest VISIBLE element to badge on (outermost surface's handle). */
  badgeElement: Element;
  /** Closed `<details>` ancestors to open on navigate. */
  detailsToOpen: HTMLDetailsElement[];
  /** Tab buttons to activate (click) on navigate for hidden panels. */
  tabsToActivate: HTMLElement[];
}

export function collapsedSurfaceFor(node: Node, root: Element): CollapsedSurface | null {
  const detailsToOpen: HTMLDetailsElement[] = [];
  const tabsToActivate: HTMLElement[] = [];
  let badgeElement: Element | null = null;
  let el: Element | null = asElement(node);
  while (el && el !== root) {
    if (el instanceof HTMLDetailsElement && !el.open) {
      detailsToOpen.push(el);
      const summary = el.querySelector(":scope > summary");
      badgeElement = summary ?? el; // outermost wins (loop runs inner → outer)
    } else if (el.getAttribute("role") === "tabpanel" && (el as HTMLElement).hidden) {
      const panelId = el.id;
      const tab = panelId
        ? root.querySelector<HTMLElement>(`[role="tab"][aria-controls="${escapeId(panelId)}"]`)
        : null;
      if (tab) {
        tabsToActivate.push(tab);
        badgeElement = tab;
      }
    }
    el = el.parentElement;
  }
  if (detailsToOpen.length === 0 && tabsToActivate.length === 0) return null;
  return { badgeElement: badgeElement ?? root, detailsToOpen, tabsToActivate };
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

/** Serialise a selection into an anchor plus the passage it evidences. Text-quote
 * (`"text"`) is the default, even inside structured blocks; whole-block (`"visual"`)
 * only for {@link OPAQUE_BLOCK_TYPES opaque} blocks or a selection with no text.
 * `null` for an empty selection outside any block. */
export function anchorFromRange(
  range: Range,
  root: Element,
): { anchor: PlanCommentAnchor; quotedText: string; rangeLabel?: string } | null {
  const frame = hostFrameOf(range.startContainer, root);
  if (frame) return anchorForFrameRange(range, frame, root);
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

  const wholeBlock = () => (block ? anchorForBlockElement(block.element, root) : null);
  if (block && OPAQUE_BLOCK_TYPES.has(block.type)) return wholeBlock();

  const quote = quoteFromRange(range, root);
  if (!quote) return wholeBlock();

  return {
    anchor: {
      anchorKind: "text",
      targetKind: "text",
      ...quote,
      ...(block ? { blockType: block.type } : {}),
      ...sectionFields,
    },
    quotedText: quote.textQuote,
  };
}

/** The text-quote fields (quote + disambiguating context) for a range, measured
 * over `scope`'s flattened text; `null` when the range captures no text. */
function quoteFromRange(range: Range, scope: Node) {
  const { text, spans } = flattenDocument(scope);
  const offsetOf = (node: Node, nodeOffset: number): number => {
    const span = spans.find((s) => s.node === node);
    return (span ? span.start : 0) + nodeOffset;
  };
  const start = offsetOf(range.startContainer, range.startOffset);
  const end = offsetOf(range.endContainer, range.endOffset);
  const textQuote = text.slice(start, end);
  if (!textQuote.trim()) return null;
  return {
    textQuote,
    contextBefore: text.slice(Math.max(0, start - CTX), start),
    contextAfter: text.slice(end, end + CTX),
    ...(countOccurrences(text, textQuote) > 1 ? { ambiguous: true } : {}),
  };
}

/** The plan `<HtmlBlock>` iframe a node lives inside, or `null` for a node in
 * the host document. HtmlBlock frames are same-origin (scripts off), so the host
 * can read their DOM and `frameElement`; a node in any other document — or a
 * frame outside this plan — is not ours to pin. */
export function hostFrameOf(node: Node, root: Element): HTMLIFrameElement | null {
  const doc = node.ownerDocument ?? (node as Document);
  if (doc === root.ownerDocument) return null;
  const frame = doc.defaultView?.frameElement;
  return frame instanceof HTMLIFrameElement && root.contains(frame) ? frame : null;
}

/** The rendered srcdoc document of an HtmlBlock frame, or `null` until it has
 * parsed (frames are `loading="lazy"`) or if it navigated away from the srcdoc. */
export function frameDocument(frame: HTMLIFrameElement): Document | null {
  const doc = frame.contentDocument;
  return doc && doc.URL === "about:srcdoc" && doc.readyState !== "loading" ? doc : null;
}

/** Serialise a selection INSIDE an HtmlBlock's frame into a `"wireframe"` node pin
 * with the frame `<body>` as the artboard: the enclosing element's path plus a text
 * quote over the whole body, so the highlight survives the card moving in the markup. */
function anchorForFrameRange(
  range: Range,
  frame: HTMLIFrameElement,
  root: Element,
): { anchor: PlanCommentAnchor; quotedText: string; rangeLabel?: string } | null {
  const host = enclosingBlock(frame);
  const body = range.startContainer.ownerDocument?.body;
  if (!host || !body) return null;
  const quote = quoteFromRange(range, body);
  if (!quote) return anchorForBlockElement(host.element, root);
  const node = asElement(range.commonAncestorContainer) ?? body;
  const targetNodePath = nodePathWithin(body, node);
  const section = sectionFor(host.element, root);
  return {
    anchor: {
      anchorKind: "wireframe",
      targetKind: targetKindForBlock(host.type),
      blockType: host.type,
      targetSelector: blockSelector(host.id),
      ...(targetNodePath ? { targetNodePath } : {}),
      ...quote,
      tagName: node.tagName.toLowerCase(),
      ...(section ? { sectionId: section.id, sectionTitle: section.title } : {}),
    },
    quotedText: quote.textQuote,
    rangeLabel: frameRangeLabel(host, node),
  };
}

/** Grouping elements a mockup's "cards" are usually built from. */
const FRAME_GROUP_SELECTOR = "section, article, li, figure, aside, fieldset, details";

/** Label for an in-frame pin — the composer chip and the `range:` line the agent
 * reads — naming the HtmlBlock (its caption, else an authored id) and the card
 * the selection is in (the first heading of the nearest grouping element), e.g.
 * `annotation in HtmlBlock "Six treatments…" › "B · Glyph before the title"`. */
function frameRangeLabel(host: { element: Element; id: string }, node: Element): string {
  const caption = host.element.querySelector("figcaption")?.textContent;
  const block = caption
    ? ` "${collapse(caption, 48)}"`
    : host.id.startsWith("plan-block-")
      ? ""
      : ` #${host.id}`;
  const group = node.closest(FRAME_GROUP_SELECTOR);
  const heading =
    group?.querySelector("h1, h2, h3, h4, h5, h6") ??
    group?.querySelector("b, strong, legend, summary, caption, dt");
  const card = heading?.textContent ? ` › "${collapse(heading.textContent, 48)}"` : "";
  return `annotation in HtmlBlock${block}${card}`;
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
  // Flatten (not `textContent`) so the block snippet reads as separate cells/rows
  // rather than one run-on string — same boundary rule as a text quote.
  const quotedText = collapse(flattenDocument(element).text, BLOCK_SNIPPET_MAX);
  return {
    anchor: {
      anchorKind: "visual",
      targetKind: targetKindForBlock(type),
      ...(type ? { blockType: type } : {}),
      targetSelector: blockSelector(id),
      ...(quotedText ? { snippet: quotedText } : {}),
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
 * `"wireframe"` anchor: the artboard selector, the element's `data-wf-node` id and a
 * structural path fallback. `null` when the element is not inside an artboard. */
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
  const targetNodeId = nodeEl.getAttribute("data-wf-node");
  const blockType = artboard.getAttribute("data-plan-block-type");
  const targetNodePath = nodePathWithin(artboard, nodeEl);
  const section = sectionFor(artboard, root);
  const snippet = collapse(nodeEl.textContent ?? "", BLOCK_SNIPPET_MAX);
  return {
    anchor: {
      anchorKind: "wireframe",
      targetKind: "wireframe",
      ...(blockType ? { blockType } : {}),
      targetSelector: blockSelector(artboard.getAttribute("data-plan-block-id") ?? ""),
      ...(targetNodeId ? { targetNodeId } : {}),
      ...(targetNodePath ? { targetNodePath } : {}),
      ...(snippet ? { snippet } : {}),
      ...(section ? { sectionId: section.id, sectionTitle: section.title } : {}),
    },
    quotedText: snippet || targetNodeId || blockType || "wireframe",
  };
}

/** Serialise a free-floating board-space point (optionally a region) into a
 * `"canvas"` anchor, resolved by {@link resolveCanvasAnchor}. Node-pinned canvas
 * notes use the wireframe branch instead. */
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
export function resolveAnchor(
  anchor: PlanCommentAnchor,
  root: Element,
  flattened?: FlattenedDocument,
): Range | null {
  if (anchor.anchorKind === "wireframe") {
    if (!anchor.targetSelector) return null;
    let artboard: Element | null;
    try {
      artboard = root.querySelector(anchor.targetSelector);
    } catch {
      return null; // malformed selector → detached rather than throw
    }
    if (artboard?.getAttribute("data-plan-block-type") === "html") {
      // An in-frame HtmlBlock pin. Until the (lazy) frame has parsed, ring the
      // whole host block so the comment stays visible rather than "detached".
      const frame = artboard.querySelector("iframe");
      const body = frame && frameDocument(frame)?.body;
      if (!body) {
        const range = root.ownerDocument!.createRange();
        range.selectNode(artboard);
        return range;
      }
      const pinned = anchor.targetNodePath ? elementAtPath(body, anchor.targetNodePath) : null;
      return (
        (pinned && quoteRange(anchor, flattenDocument(pinned))) ??
        quoteRange(anchor, flattenDocument(body))
      );
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

  return quoteRange(anchor, flattened ?? flattenDocument(root));
}

/** Re-find an anchor's text quote in a flattened subtree, picking the occurrence
 * whose surrounding text best matches the captured context; `null` if absent. */
function quoteRange(anchor: PlanCommentAnchor, { text, spans }: FlattenedDocument): Range | null {
  const quote = anchor.textQuote;
  if (!quote || spans.length === 0) return null;

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

  const range = spans[0]!.node.ownerDocument.createRange();
  const s = locate(spans, best);
  const e = locate(spans, best + quote.length);
  range.setStart(s.node, s.offset);
  range.setEnd(e.node, e.offset);
  return range;
}
