import type { PlanCommentAnchor } from "@t3tools/contracts";
import { Eye, GripVertical, MessageCircle, Pencil, Trash2, Unlink } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { useStableCallback } from "~/hooks/useStableCallback";
import { observeResize } from "~/lib/observeResize";
import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import {
  annotationDraftKey,
  questionAnswerDraftKey,
  reviewChoiceDraftKey,
  useMdxAnnotationDraftStore,
} from "~/mdxAnnotationDraftStore";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  type MdxAnchorReviewCommentContext,
  type ReviewCommentContext,
} from "~/reviewCommentContext";

import { MdxPlanRenderer, PLAN_BLEED_ATTR } from "../MdxPlanRenderer";
import { PlanEagerMountContext } from "../planEagerMount";
import {
  EMPTY_QUESTION_ANSWER,
  formatQuestionAnswerText,
  isEmptyQuestionAnswer,
  isQuestionAnswerCommentId,
  parseQuestionAnswerDraft,
  PlanQuestionAnswersContext,
  type PlanQuestionAnswersApi,
  questionAnswerCommentId,
} from "../questionAnswers";
import {
  EMPTY_REVIEW_CHOICE,
  formatReviewChoiceText,
  isEmptyReviewChoice,
  isReviewChoiceCommentId,
  parseReviewChoiceDraft,
  PlanReviewChoicesContext,
  type PlanReviewChoicesApi,
  reviewChoiceCommentId,
} from "../reviewChoices";
import {
  anchorForBlockElement,
  anchorFromRange,
  blockSelector,
  collapsedSurfaceFor,
  type CollapsedSurface,
  flattenDocument,
  frameDocument,
  hostFrameOf,
  resolveAnchor,
} from "./anchoring";

/**
 * Annotation layer over a rendered MDX plan: selections become portable anchors and
 * comments that ride the composer's review-comment channel, as do question-block
 * answers. Anchors re-resolve on every layout change; one that no longer resolves
 * degrades to a "detached" card rather than being dropped.
 */

interface MdxPlanAnnotationLayerProps {
  source: string;
  filePath: string;
  composerDraftTarget: ScopedThreadRef | DraftId;
}

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface Overlay {
  id: string;
  comment: MdxAnchorReviewCommentContext;
  boxes: Box[];
  badge: { top: number; left: number };
  /** `fill` = per-line prose highlight (text anchor); `ring` = a single outline
   * around a whole annotated block (visual/wireframe anchor) — a fill over an
   * entire card reads as "everything selected", the bug B fixes. */
  variant: "fill" | "ring";
  /** `resolved` = visible highlight; `collapsed` = hidden inside a closed
   * `<details>` / tab panel (badge on the enclosing surface, open-on-navigate);
   * `detached` = anchor no longer resolves at all. */
  state: "resolved" | "collapsed" | "detached";
  /** Present only for `collapsed`: the surfaces to reveal on navigate. */
  collapsed?: CollapsedSurface;
}

const clampCardLeft = (left: number, wrapperWidth: number) =>
  Math.max(8, Math.min(left, wrapperWidth - CARD_WIDTH - 8));

interface ComposerState {
  id: string;
  anchor: PlanCommentAnchor;
  quotedText: string;
  initialText: string;
  /** localStorage key the in-progress draft is cached under (issue 6). */
  draftKey: string;
  /** Overrides the default text/block label (an in-frame pin names its card;
   * an edit keeps the label the comment was created with). */
  rangeLabel?: string;
  top: number;
  left: number;
}

const CARD_WIDTH = 320;
/** Estimated composer height, used only to keep the initial placement on-screen. */
const COMPOSER_EST_HEIGHT = 220;
const GAP = 12;

/**
 * Place the composer beside a viewport `rect` so it never covers the annotated
 * passage: right gutter, else left, else below. Returns wrapper-relative values
 * clamped into view.
 */
function placeBeside(rect: DOMRect, wrapper: DOMRect): { top: number; left: number } {
  const relTop = rect.top - wrapper.top;
  const clampTop = (top: number) =>
    Math.max(8, Math.min(top, wrapper.height - COMPOSER_EST_HEIGHT - 8));
  const rightLeft = rect.right - wrapper.left + GAP;
  const leftLeft = rect.left - wrapper.left - CARD_WIDTH - GAP;
  if (rightLeft + CARD_WIDTH <= wrapper.width - 8)
    return { top: clampTop(relTop), left: rightLeft };
  if (leftLeft >= 8) return { top: clampTop(relTop), left: leftLeft };
  const below = Math.max(8, Math.min(rect.left - wrapper.left, wrapper.width - CARD_WIDTH - 8));
  return { top: clampTop(rect.bottom - wrapper.top + GAP), left: below };
}

/** The element an anchor's range targets. A block anchor's range `selectNode`s
 * its element (the child at `startOffset`); a text anchor's starts in a text node
 * whose parent element is the target. */
function anchorElement(range: Range): Element | null {
  const container = range.startContainer;
  if (container.nodeType === Node.ELEMENT_NODE) {
    const selected = container.childNodes[range.startOffset];
    return selected?.nodeType === Node.ELEMENT_NODE
      ? (selected as Element)
      : (container as Element);
  }
  return container.parentElement;
}

/** The nearest ancestor between the node and the plan root that scrolls its own
 * content (a wide `<Table>`, `<Diff>` or `<Code>`), or `null`. A highlight inside
 * one must be clipped to it, or scrolling carries the highlight over the page. */
function scrollportOf(node: Node, root: Element): Element | null {
  let el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  while (el && el !== root) {
    if (el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight) return el;
    el = el.parentElement;
  }
  return null;
}

/** A rect measured inside an HtmlBlock frame (relative to the frame's viewport),
 * moved into host-document viewport coordinates. Identity for a host rect. */
function toHostRect(rect: DOMRect, frame: HTMLIFrameElement | null): DOMRect {
  if (!frame) return rect;
  const origin = frame.getBoundingClientRect();
  return new DOMRect(
    rect.x + origin.x + frame.clientLeft,
    rect.y + origin.y + frame.clientTop,
    rect.width,
    rect.height,
  );
}

function fileNameOf(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || filePath;
}

function isMdxAnchorComment(
  comment: ReviewCommentContext,
  filePath: string,
): comment is MdxAnchorReviewCommentContext {
  return comment.kind === "mdx-anchor" && comment.filePath === filePath;
}

function newCommentId(): string {
  return `mdx-anchor:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Collapsed annotations grouped by the surface they badge onto, so several
 * hidden comments behind one closed <details>/tab collapse to one counted
 * badge (the enclosing surface stays discoverable).
 */
function groupCollapsedOverlays(overlays: ReadonlyArray<Overlay>) {
  const groups: { key: string; top: number; left: number; overlays: Overlay[] }[] = [];
  for (const overlay of overlays) {
    if (overlay.state !== "collapsed" || !overlay.collapsed) continue;
    const existing = groups.find(
      (group) => group.overlays[0]!.collapsed!.badgeElement === overlay.collapsed!.badgeElement,
    );
    if (existing) existing.overlays.push(overlay);
    else
      groups.push({
        key: overlay.id,
        top: overlay.badge.top,
        left: overlay.badge.left,
        overlays: [overlay],
      });
  }
  return groups;
}

export function MdxPlanAnnotationLayer({
  source,
  filePath,
  composerDraftTarget,
}: MdxPlanAnnotationLayerProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const pendingRangeRef = useRef<Range | null>(null);
  const hoverBlockIdRef = useRef<string | null>(null);
  const [root, setRoot] = useState<Element | null>(null);
  const [overlays, setOverlays] = useState<Overlay[]>([]);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [selectionAffordance, setSelectionAffordance] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const [hoverBlock, setHoverBlock] = useState<{ id: string; top: number; left: number } | null>(
    null,
  );
  const [openCardId, setOpenCardId] = useState<string | null>(null);
  // Measured with the overlays, so an open card clamps without reading the DOM in render.
  const [wrapperWidth, setWrapperWidth] = useState(0);

  const draft = useComposerDraftStore((store) => store.getComposerDraft(composerDraftTarget));
  const addReviewComment = useComposerDraftStore((store) => store.addReviewComment);
  const removeReviewComment = useComposerDraftStore((store) => store.removeReviewComment);
  const getAnnotationDraft = useMdxAnnotationDraftStore((store) => store.getDraft);
  const setAnnotationDraft = useMdxAnnotationDraftStore((store) => store.setDraft);
  const clearAnnotationDraft = useMdxAnnotationDraftStore((store) => store.clearDraft);
  const annotationDrafts = useMdxAnnotationDraftStore((store) => store.drafts);
  const fileComments = (draft?.reviewComments ?? []).filter((c) => isMdxAnchorComment(c, filePath));
  // Decision counter, presentation only. `M` counts <ReviewChoice> tags in the source
  // (stable under lazy mounts inside <Details>); `N` counts persisted review-choice
  // comments, the wire truth for "decided".
  const reviewChoiceTotal = (source.match(/<ReviewChoice[\s/>]/g) ?? []).length;
  const decidedCount = fileComments.filter((c) => isReviewChoiceCommentId(c.id)).length;

  // Question-answer comments are shown by the question blocks themselves (and as
  // composer chips), not as highlight overlays/badges — only freeform annotation
  // comments feed the overlay pipeline below.
  const comments = fileComments.filter(
    (c) => !isQuestionAnswerCommentId(c.id) && !isReviewChoiceCommentId(c.id),
  );

  // Interactive answer surface for `<QuestionForm>`/`<VisualQuestions>` blocks:
  // answers upsert a deterministic-id review comment (the wire truth — removing
  // the composer chip un-answers the question) while the structured option ids
  // persist in the annotation draft store.
  const questionAnswers: PlanQuestionAnswersApi = {
    getAnswer: (questionId) => {
      if (!fileComments.some((c) => c.id === questionAnswerCommentId(filePath, questionId))) {
        return EMPTY_QUESTION_ANSWER;
      }
      return parseQuestionAnswerDraft(
        annotationDrafts[questionAnswerDraftKey(composerDraftTarget, filePath, questionId)] ?? null,
      );
    },
    setAnswer: (question, blockElement, answer) => {
      const draftKey = questionAnswerDraftKey(composerDraftTarget, filePath, question.id);
      const commentId = questionAnswerCommentId(filePath, question.id);
      if (isEmptyQuestionAnswer(answer)) {
        clearAnnotationDraft(draftKey);
        removeReviewComment(composerDraftTarget, commentId);
        return;
      }
      setAnnotationDraft(draftKey, JSON.stringify(answer));
      const anchored = blockElement && root ? anchorForBlockElement(blockElement, root) : undefined;
      const anchor: PlanCommentAnchor = anchored?.anchor ?? {
        anchorKind: "visual",
        targetKind: "control",
        blockType: "question-form",
      };
      addReviewComment(composerDraftTarget, {
        kind: "mdx-anchor",
        id: commentId,
        filePath,
        sectionId: anchor.sectionId ?? `file:${filePath}`,
        sectionTitle: anchor.sectionTitle ?? fileNameOf(filePath),
        rangeLabel: `answer: ${question.id}`,
        text: formatQuestionAnswerText(question, answer),
        anchor,
        quotedText: question.title,
      });
    },
  };

  // Interactive decision surface for `<ReviewChoice>` blocks — mirror of the
  // question-answer channel above: a verdict/note upserts a deterministic-id
  // (`mdx-review:…`) review comment (the wire truth) while the structured
  // verdict/note persist in the annotation draft store.
  const reviewChoices: PlanReviewChoicesApi = {
    getChoice: (itemId) => {
      if (!fileComments.some((c) => c.id === reviewChoiceCommentId(filePath, itemId))) {
        return EMPTY_REVIEW_CHOICE;
      }
      return parseReviewChoiceDraft(
        annotationDrafts[reviewChoiceDraftKey(composerDraftTarget, filePath, itemId)] ?? null,
      );
    },
    setChoice: (item, blockElement, choice) => {
      const draftKey = reviewChoiceDraftKey(composerDraftTarget, filePath, item.itemId);
      const commentId = reviewChoiceCommentId(filePath, item.itemId);
      if (isEmptyReviewChoice(choice)) {
        clearAnnotationDraft(draftKey);
        removeReviewComment(composerDraftTarget, commentId);
        return;
      }
      setAnnotationDraft(draftKey, JSON.stringify(choice));
      const anchored = blockElement && root ? anchorForBlockElement(blockElement, root) : undefined;
      const anchor: PlanCommentAnchor = anchored?.anchor ?? {
        anchorKind: "visual",
        targetKind: "control",
        blockType: "review-choice",
      };
      const label = item.label ?? item.itemId;
      addReviewComment(composerDraftTarget, {
        kind: "mdx-anchor",
        id: commentId,
        filePath,
        sectionId: anchor.sectionId ?? `file:${filePath}`,
        sectionTitle: anchor.sectionTitle ?? fileNameOf(filePath),
        rangeLabel: `review: ${item.itemId}`,
        text: formatReviewChoiceText(label, choice),
        anchor,
        quotedText: label,
      });
    },
  };

  // Track the rendered plan root (a direct child of the wrapper) as it appears
  // after the async MDX compile / on re-render.
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const find = () => setRoot(wrapper.querySelector("[data-plan-root]"));
    find();
    const observer = new MutationObserver(find);
    observer.observe(wrapper, { childList: true });
    return () => observer.disconnect();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A new source recompiles the plan, so its root is looked up again.
  }, [source]);

  const recompute = () => {
    const wrapper = wrapperRef.current;
    if (!wrapper || !root) {
      setOverlays([]);
      return;
    }
    const wrapperRect = wrapper.getBoundingClientRect();
    setWrapperWidth(wrapperRect.width);
    // Badges sit in the gutter outside the widest painted thing: the content column,
    // or a block that bleeds past it (`[data-plan-bleed]`), so a badge never lands
    // on a bled diff. `.plan-mdx`'s bleed inset reserves the room.
    const gutterLeft = Math.min(
      Array.from(root.querySelectorAll(`[${PLAN_BLEED_ATTR}]`)).reduce(
        (right, block) => Math.max(right, block.getBoundingClientRect().right),
        root.getBoundingClientRect().right,
      ) -
        wrapperRect.left +
        6,
      wrapperRect.width - 24,
    );
    const toBox = (rect: DOMRect): Box => ({
      top: rect.top - wrapperRect.top,
      left: rect.left - wrapperRect.left,
      width: rect.width,
      height: rect.height,
    });
    /** `rect` intersected with an optional clipping scrollport; `null` when the
     * rect lies entirely outside it (its text is scrolled out of view). */
    const clipToBox = (rect: DOMRect, port: DOMRect | undefined): Box | null => {
      if (!port) return toBox(rect);
      const top = Math.max(rect.top, port.top);
      const left = Math.max(rect.left, port.left);
      const height = Math.min(rect.bottom, port.bottom) - top;
      const width = Math.min(rect.right, port.right) - left;
      return width > 0 && height > 0
        ? { top: top - wrapperRect.top, left: left - wrapperRect.left, width, height }
        : null;
    };
    // Flatten the document ONCE per pass and share it across every text-quote
    // resolve, turning an O(comments × document) pass into O(document + comments)
    // — this removes the per-toggle recompute cliff on evidence-heavy docs.
    const flattened = flattenDocument(root);
    const detachedOverlay = (comment: MdxAnchorReviewCommentContext): Overlay => ({
      id: comment.id,
      comment,
      boxes: [],
      badge: { top: 0, left: 0 },
      variant: "fill",
      state: "detached",
    });
    setOverlays(
      comments.map((comment) => {
        // Guard per comment: a single malformed anchor degrades to "detached"
        // instead of throwing during render and taking down the whole layer.
        let range: Range | null;
        try {
          range = comment.anchor ? resolveAnchor(comment.anchor, root, flattened) : null;
        } catch {
          return detachedOverlay(comment);
        }
        if (!range) return detachedOverlay(comment);
        // A text-quote range starts in a text node (prose, or a pin inside an
        // HtmlBlock frame); a block/node anchor `selectNode`s an element.
        const isText = range.startContainer.nodeType === Node.TEXT_NODE;
        // Set when the range lives inside an HtmlBlock frame: its rects are
        // frame-relative, and the frame element (not the in-frame node) is what
        // a closed <details> / hidden tab hides.
        const frame = hostFrameOf(range.startContainer, root);
        const element = anchorElement(range);
        // Hidden <details>/tab content still reports live, wrongly placed rects (Chromium
        // uses `content-visibility:hidden`), so test visibility explicitly. A text anchor
        // tests both endpoints: its start can sit on a preceding visible <summary>. A
        // block anchor's end offset points at the next sibling, so only its start counts.
        const visible = (el: Element | null): boolean =>
          !el ||
          el.checkVisibility({
            contentVisibilityAuto: true,
            opacityProperty: true,
            visibilityProperty: true,
          });
        const startEl = frame ?? element;
        const endEl = frame ?? (isText ? range.endContainer.parentElement : element);
        if (!visible(startEl) || !visible(endEl)) {
          const hiddenNode =
            frame ?? (visible(element) ? range.endContainer : range.startContainer);
          const surface = collapsedSurfaceFor(hiddenNode, root);
          if (surface) {
            const rect = surface.badgeElement.getBoundingClientRect();
            return {
              id: comment.id,
              comment,
              boxes: [],
              badge: { top: rect.top - wrapperRect.top, left: rect.right - wrapperRect.left - 8 },
              variant: "ring",
              state: "collapsed",
              collapsed: surface,
            };
          }
          return detachedOverlay(comment);
        }
        // A text anchor paints one rect per line box. A block anchor paints ONE ring from
        // its element: its range's rects include a line box per descendant text node.
        // An in-frame highlight clips to the frame (its text can scroll inside it).
        const port = isText ? (frame ?? scrollportOf(range.startContainer, root)) : null;
        const portRect = port?.getBoundingClientRect();
        const boxes = (
          isText
            ? Array.from(range.getClientRects(), (rect) =>
                clipToBox(toHostRect(rect, frame), portRect),
              )
            : element
              ? [toBox(element.getBoundingClientRect())]
              : []
        ).filter((box): box is Box => box !== null && box.width > 0 && box.height > 0);
        if (boxes.length === 0) {
          // Nothing to paint. Inside a scrollport that means the quoted text is
          // simply scrolled out of view — still resolved, so keep the badge on
          // the block so the comment stays reachable. Anywhere else it is a
          // genuinely geometry-less anchor: detached.
          if (!portRect) return detachedOverlay(comment);
          return {
            id: comment.id,
            comment,
            boxes: [],
            badge: { top: portRect.top - wrapperRect.top, left: gutterLeft },
            variant: "fill",
            state: "resolved",
          };
        }
        return {
          id: comment.id,
          comment,
          boxes,
          badge: { top: boxes[0]!.top, left: gutterLeft },
          variant: isText ? "fill" : "ring",
          state: "resolved",
        };
      }),
    );
  };

  // Recompute overlays on any layout-affecting change to the plan DOM.
  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper || !root) {
      setOverlays([]);
      return;
    }
    let frame = 0;
    let disposed = false;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(recompute);
    };
    // Boxes are wrapper-relative, so observe the wrapper too: `root` is `max-w-4xl`
    // and re-centres on a side-panel toggle without changing its border box.
    const stopResize = observeResize([root, wrapper], schedule);
    const mutationObserver = new MutationObserver(schedule);
    mutationObserver.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    window.addEventListener("resize", schedule);
    // A block's own scroller moves its text with no mutation or resize, so listen
    // for capture-phase scrolls inside the plan. Page scroll cannot move a
    // wrapper-relative box, so it is ignored.
    const onInnerScroll = (event: Event) => {
      if (event.target instanceof Node && root.contains(event.target)) schedule();
    };
    document.addEventListener("scroll", onInnerScroll, true);
    // A web-font swap changes text metrics with neither a mutation nor a resize
    // (line wrapping is width-capped, so `root` never changes size), so no
    // observer fires — re-measure once fonts settle.
    document.fonts?.ready.then(() => {
      if (!disposed) schedule();
    });
    schedule();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      stopResize();
      mutationObserver.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", onInnerScroll, true);
    };
  }, [root, recompute]);

  // Hide the selection affordance when the selection collapses.
  useEffect(() => {
    const onSelectionChange = () => {
      // A selection inside an HtmlBlock frame is tracked by that frame's own
      // listener (see the frame-wiring effect); the host's is irrelevant to it.
      const pendingDoc = pendingRangeRef.current?.startContainer.ownerDocument;
      if (pendingDoc && pendingDoc !== document) return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) setSelectionAffordance(null);
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, []);

  const wrapperRectNow = () => wrapperRef.current?.getBoundingClientRect() ?? new DOMRect();
  const clampLeft = (left: number) => clampCardLeft(left, wrapperRectNow().width);

  /** Close the composer, preserving its in-progress text as a cached draft so a
   * later reopen of the same target restores it (issue 6). Only submit/discard
   * clear the cache, so every dismissal path (Esc, click-away, Cancel) keeps. */
  const dismissComposer = () => setComposer(null);

  /** Offer the floating "Comment" button for the selection in `doc` — the host
   * document, or an HtmlBlock frame's (whose rects are moved into host space).
   * Stable (it reads the wrapper ref, which the compiler will not cache), so
   * the frame-wiring effect below does not re-wire on every render. */
  const handleMouseUp = useStableCallback((doc: Document = document) => {
    requestAnimationFrame(() => {
      const selection = doc.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      const frame = root && hostFrameOf(range.startContainer, root);
      if (!root || !(frame || root.contains(range.commonAncestorContainer))) {
        setSelectionAffordance(null);
        return;
      }
      const rects = range.getClientRects();
      const lastRect = rects[rects.length - 1];
      if (!lastRect) return;
      const last = toHostRect(lastRect, frame);
      const wrapperRect = wrapperRectNow();
      pendingRangeRef.current = range.cloneRange();
      setSelectionAffordance({
        top: last.bottom - wrapperRect.top + 6,
        left: last.right - wrapperRect.left,
      });
    });
  });

  /** Show the per-block comment affordance for the block under `target`. */
  const hoverOver = useStableCallback((target: Element) => {
    const block = target.closest?.("[data-plan-block-id]");
    if (!root || !block || !root.contains(block)) {
      if (hoverBlockIdRef.current !== null) {
        hoverBlockIdRef.current = null;
        setHoverBlock(null);
      }
      return;
    }
    const id = block.getAttribute("data-plan-block-id");
    if (!id || id === hoverBlockIdRef.current) return;
    hoverBlockIdRef.current = id;
    const wrapperRect = wrapperRectNow();
    const rect = block.getBoundingClientRect();
    setHoverBlock({
      id,
      top: rect.top - wrapperRect.top + 4,
      left: rect.right - wrapperRect.left - 30,
    });
  });

  // HtmlBlock frames are separate same-origin documents whose events never reach
  // the wrapper, so listen in each frame once its srcdoc loads (a srcdoc
  // re-render loads a fresh document, which is wired again).
  useEffect(() => {
    if (!root) return;
    const controller = new AbortController();
    const { signal } = controller;
    const wired = new WeakSet<Document>();
    let pending = 0;
    const refresh = () => {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(recompute);
    };
    const wire = () => {
      for (const iframe of root.querySelectorAll<HTMLIFrameElement>(
        '[data-plan-block-type="html"] iframe',
      )) {
        const doc = frameDocument(iframe);
        if (!doc || wired.has(doc)) continue;
        wired.add(doc);
        doc.addEventListener("mouseup", () => handleMouseUp(doc), { signal });
        doc.addEventListener(
          "selectionchange",
          () => {
            const ownsPending = pendingRangeRef.current?.startContainer.ownerDocument === doc;
            if (ownsPending && doc.getSelection()?.isCollapsed) setSelectionAffordance(null);
          },
          { signal },
        );
        // Entering the frame shows the whole-block affordance, as hovering any
        // other block does (the host never sees mouse moves over the frame).
        doc.addEventListener("mouseover", () => hoverOver(iframe), { signal });
        // Leaving it: the wrapper's own mouseleave never fires when the pointer
        // exits the frame straight out of the plan, so let the next host move
        // decide — inside the wrapper (e.g. onto the affordance, which overlaps
        // the frame) its own handler takes over; anywhere else, clear.
        doc.documentElement.addEventListener(
          "mouseleave",
          () =>
            document.addEventListener(
              "mousemove",
              (event) => {
                if (wrapperRef.current?.contains(event.target as Node)) return;
                hoverBlockIdRef.current = null;
                setHoverBlock(null);
              },
              { signal, once: true },
            ),
          { signal },
        );
        // Click-away inside the frame dismisses the composer like it does outside.
        doc.addEventListener("pointerdown", () => setComposer(null), { signal });
        // In-frame highlights are frame-relative: re-measure on in-frame scroll,
        // and on in-frame reflow the host cannot see (a <details> toggle, a
        // data: web font landing) — neither resizes the fixed-height iframe.
        doc.addEventListener("scroll", refresh, { signal, capture: true, passive: true });
        doc.addEventListener("toggle", refresh, { signal, capture: true });
        doc.fonts.addEventListener("loadingdone", refresh, { signal });
        stopReflows.push(observeResize([doc.documentElement], refresh)); // not a raw ResizeObserver: upstream's no-raw-resize-observer
      }
    };
    const stopReflows: Array<() => void> = [];
    // `load` does not bubble, but it does pass through a capturing ancestor.
    root.addEventListener(
      "load",
      (event) => {
        if (!(event.target instanceof HTMLIFrameElement)) return;
        wire();
        refresh(); // anchors in this frame can now resolve past whole-block
      },
      { signal, capture: true },
    );
    wire();
    return () => {
      controller.abort();
      for (const stop of stopReflows) stop();
      cancelAnimationFrame(pending);
    };
  }, [root, recompute, handleMouseUp, hoverOver, hoverBlockIdRef]);

  const openComposerFromSelection = () => {
    const range = pendingRangeRef.current;
    if (!range || !root) return;
    const result = anchorFromRange(range, root);
    if (!result) return;
    const { top, left } = placeBeside(
      toHostRect(range.getBoundingClientRect(), hostFrameOf(range.startContainer, root)),
      wrapperRectNow(),
    );
    const draftKey = annotationDraftKey(composerDraftTarget, { anchor: result.anchor });
    setComposer({
      id: newCommentId(),
      anchor: result.anchor,
      quotedText: result.quotedText,
      initialText: getAnnotationDraft(draftKey) ?? "",
      draftKey,
      ...(result.rangeLabel ? { rangeLabel: result.rangeLabel } : {}),
      top,
      left,
    });
    setSelectionAffordance(null);
    setOpenCardId(null);
    range.startContainer.ownerDocument?.getSelection()?.removeAllRanges();
  };

  const openComposerForBlock = (blockId: string) => {
    if (!root) return;
    const element = root.querySelector(blockSelector(blockId));
    if (!element) return;
    const result = anchorForBlockElement(element, root);
    const { top, left } = placeBeside(element.getBoundingClientRect(), wrapperRectNow());
    const draftKey = annotationDraftKey(composerDraftTarget, { anchor: result.anchor });
    setComposer({
      id: newCommentId(),
      anchor: result.anchor,
      quotedText: result.quotedText,
      initialText: getAnnotationDraft(draftKey) ?? "",
      draftKey,
      top,
      left,
    });
    setHoverBlock(null);
    setOpenCardId(null);
  };

  const openComposerForEdit = (comment: MdxAnchorReviewCommentContext, overlay?: Overlay) => {
    const badge = overlay?.badge;
    const draftKey = annotationDraftKey(composerDraftTarget, { commentId: comment.id });
    setComposer({
      id: comment.id,
      anchor: comment.anchor,
      quotedText: comment.quotedText,
      initialText: getAnnotationDraft(draftKey) ?? comment.text,
      draftKey,
      rangeLabel: comment.rangeLabel,
      top: (badge?.top ?? 16) + 20,
      left: clampLeft(badge?.left ?? 16),
    });
    setOpenCardId(null);
  };

  const submitComposer = (text: string) => {
    if (!composer) return;
    const anchor: PlanCommentAnchor = {
      ...composer.anchor,
      sectionId: composer.anchor.sectionId ?? `file:${filePath}`,
      sectionTitle: composer.anchor.sectionTitle ?? fileNameOf(filePath),
    };
    const comment: MdxAnchorReviewCommentContext = {
      kind: "mdx-anchor",
      id: composer.id,
      filePath,
      sectionId: anchor.sectionId ?? `file:${filePath}`,
      sectionTitle: anchor.sectionTitle ?? fileNameOf(filePath),
      rangeLabel:
        composer.rangeLabel ??
        (anchor.anchorKind === "text"
          ? "annotation"
          : `${anchor.blockType ? `${anchor.blockType} ` : ""}block`),
      text,
      anchor,
      quotedText: composer.quotedText,
    };
    addReviewComment(composerDraftTarget, comment);
    clearAnnotationDraft(composer.draftKey);
    setComposer(null);
  };

  const discardComposer = () => {
    if (composer) clearAnnotationDraft(composer.draftKey);
    setComposer(null);
  };

  const removeComment = (id: string) => {
    removeReviewComment(composerDraftTarget, id);
    setOpenCardId(null);
    if (composer?.id === id) {
      clearAnnotationDraft(composer.draftKey);
      setComposer(null);
    }
  };

  const detached = overlays.filter((overlay) => overlay.state === "detached");

  const collapsedGroups = groupCollapsedOverlays(overlays);

  // Open every enclosing <details> / activate the tab for a collapsed group, then
  // (after the layout settles + observers recompute) scroll the now-visible
  // anchor into view. This is a user navigation action — the ONLY place details
  // `open` is mutated — never overlay recomputation.
  const revealCollapsed = (group: { overlays: Overlay[] }) => {
    for (const overlay of group.overlays) {
      overlay.collapsed?.detailsToOpen.forEach((el) => {
        el.open = true;
      });
      overlay.collapsed?.tabsToActivate.forEach((tab) => tab.click());
    }
    requestAnimationFrame(() => {
      const first = group.overlays[0];
      if (first && root) {
        try {
          const range = first.comment.anchor ? resolveAnchor(first.comment.anchor, root) : null;
          const node = range?.startContainer;
          const el =
            node?.nodeType === Node.ELEMENT_NODE
              ? (node as Element)
              : (node?.parentElement ?? null);
          el?.scrollIntoView({ block: "center", behavior: "smooth" });
        } catch {
          /* best-effort scroll */
        }
      }
      recompute();
    });
  };

  return (
    <div
      ref={wrapperRef}
      // The document's own surface (`.plan-surface`, index.css): its palette
      // re-points the app's semantic tokens for everything inside.
      className="plan-surface relative"
      onMouseUp={() => handleMouseUp()}
      onMouseMove={(event) => {
        const target = event.target as Element;
        // Keep the affordance shown while the pointer is over it — it renders as
        // a wrapper sibling (not inside the block), so the block lookup would
        // otherwise clear the hover the instant the cursor reaches the button
        // and it would vanish out from under the click (flicker, issue 3).
        if (target.closest?.("[data-plan-comment-affordance]")) return;
        hoverOver(target);
      }}
      onMouseLeave={() => {
        hoverBlockIdRef.current = null;
        setHoverBlock(null);
      }}
    >
      <PlanQuestionAnswersContext.Provider value={questionAnswers}>
        <PlanReviewChoicesContext.Provider value={reviewChoices}>
          {/* Force eager <Details> mounting only when annotation comments exist,
              so a comment anchored inside a closed drill-down resolves as
              `collapsed` rather than `detached`. Lazy everywhere else. */}
          <PlanEagerMountContext.Provider value={comments.length > 0}>
            {/* The decided pill rides the renderer's sticky header row, beside
                the section outline rather than on top of it. */}
            <MdxPlanRenderer
              source={source}
              stickyEnd={
                reviewChoiceTotal > 0 ? (
                  <span className="pointer-events-auto shrink-0 rounded-full border border-border bg-background/90 px-2.5 py-1 text-2xs font-medium text-muted-foreground shadow-sm backdrop-blur">
                    {decidedCount} of {reviewChoiceTotal} decided
                  </span>
                ) : null
              }
            />
          </PlanEagerMountContext.Provider>
        </PlanReviewChoicesContext.Provider>
      </PlanQuestionAnswersContext.Provider>

      {/* Highlight overlays for each pending annotation (non-interactive). */}
      <div className="pointer-events-none absolute inset-0 z-10">
        {overlays.flatMap((overlay) =>
          overlay.boxes.map((box) => (
            <div
              key={`${overlay.id}:${box.top}:${box.left}:${box.width}:${box.height}`}
              className={
                overlay.variant === "ring"
                  ? "absolute rounded-md ring-2 ring-warning/70"
                  : "absolute rounded-sm bg-warning/16 ring-1 ring-warning/50"
              }
              style={{ top: box.top, left: box.left, width: box.width, height: box.height }}
            />
          )),
        )}
      </div>

      {/* Numbered badges — click to open a comment card. */}
      {overlays.map((overlay, index) =>
        overlay.state !== "resolved" ? null : (
          <button
            key={overlay.id}
            type="button"
            aria-label={`Comment ${index + 1}`}
            className="absolute z-20 grid size-5 -translate-y-1 place-items-center rounded-full bg-warning text-3xs font-bold text-white shadow ring-2 ring-background"
            style={{ top: overlay.badge.top, left: overlay.badge.left + 2 }}
            onClick={() => setOpenCardId((current) => (current === overlay.id ? null : overlay.id))}
          >
            {index + 1}
          </button>
        ),
      )}

      {/* Collapsed-annotation badges — comments hidden inside a closed <details>
          or tab panel. Click reveals the enclosing surface(s) and scrolls to the
          highlight; a count when several collapse onto one surface. */}
      {collapsedGroups.map((group) => (
        <button
          key={`collapsed-${group.key}`}
          type="button"
          aria-label={`Reveal ${group.overlays.length} hidden comment${group.overlays.length > 1 ? "s" : ""}`}
          className="absolute z-20 flex h-5 -translate-y-1 items-center gap-0.5 rounded-full bg-warning/80 px-1.5 text-3xs font-bold text-white shadow ring-2 ring-background hover:bg-warning"
          style={{ top: group.top, left: group.left }}
          onClick={() => revealCollapsed(group)}
        >
          <Eye className="size-3" />
          {group.overlays.length}
        </button>
      ))}

      {/* Comment card for an opened badge. */}
      {overlays.map((overlay) =>
        openCardId === overlay.id && overlay.state === "resolved" ? (
          <AnnotationCard
            key={`card-${overlay.id}`}
            top={overlay.badge.top + 20}
            left={clampCardLeft(overlay.badge.left, wrapperWidth)}
            quotedText={overlay.comment.quotedText}
            text={overlay.comment.text}
            onEdit={() => openComposerForEdit(overlay.comment, overlay)}
            onDelete={() => removeComment(overlay.id)}
            onClose={() => setOpenCardId(null)}
          />
        ) : null,
      )}

      {/* Floating "Comment" affordance for the current text selection. */}
      {selectionAffordance && !composer ? (
        <button
          type="button"
          className="absolute z-30 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs font-medium shadow-lg hover:text-foreground hover:ring-2 hover:ring-warning/60"
          style={{ top: selectionAffordance.top, left: selectionAffordance.left }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={openComposerFromSelection}
        >
          <MessageCircle className="size-3.5" />
          Comment
        </button>
      ) : null}

      {/* Per-block "comment" affordance (covers non-selectable / non-prose blocks).
          Stable anchored position (only recomputed when the hovered block
          changes) + a generous hit target, and it stays shown while hovered —
          no flicker, trivially clickable (issues 3/4). */}
      {hoverBlock && !composer && !selectionAffordance ? (
        <button
          type="button"
          data-plan-comment-affordance=""
          aria-label="Comment on this block"
          className="absolute z-20 grid size-7 place-items-center rounded-md border border-border bg-background text-muted-foreground shadow-sm hover:text-foreground hover:ring-2 hover:ring-warning/60"
          style={{ top: hoverBlock.top, left: hoverBlock.left }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => openComposerForBlock(hoverBlock.id)}
        >
          <MessageCircle className="size-4" />
        </button>
      ) : null}

      {/* Comment composer (new comment or edit). */}
      {composer ? (
        <AnnotationComposer
          key={composer.id}
          draftKey={composer.draftKey}
          top={composer.top}
          left={composer.left}
          quotedText={composer.quotedText}
          initialText={composer.initialText}
          onCacheDraft={setAnnotationDraft}
          onDismiss={dismissComposer}
          onDiscard={discardComposer}
          onSubmit={submitComposer}
        />
      ) : null}

      {/* Detached annotations — anchors that no longer resolve to the plan. */}
      {detached.length > 0 ? (
        <div className="pointer-events-auto absolute right-3 top-3 z-40 flex w-72 flex-col gap-2">
          {detached.map((overlay) => (
            <div
              key={`detached-${overlay.id}`}
              className="rounded-xl border border-warning/40 bg-card bg-linear-to-b from-warning-surface to-warning-surface p-3 shadow-sm"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <div className="flex items-center gap-2 text-warning-foreground">
                <Unlink className="size-3.5" />
                <span className="text-xs font-medium">Detached comment</span>
                <div className="ml-auto flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Edit detached comment"
                    onClick={() => openComposerForEdit(overlay.comment, overlay)}
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Delete detached comment"
                    onClick={() => removeComment(overlay.id)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
              {overlay.comment.quotedText ? (
                <p className="mt-2 line-clamp-2 border-l-2 border-warning/60 pl-2 text-2xs italic text-muted-foreground">
                  {overlay.comment.quotedText}
                </p>
              ) : null}
              <p className="mt-1.5 whitespace-pre-wrap text-sm text-foreground">
                {overlay.comment.text}
              </p>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface AnnotationCardProps {
  top: number;
  left: number;
  quotedText: string;
  text: string;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
}

function AnnotationCard({
  top,
  left,
  quotedText,
  text,
  onEdit,
  onDelete,
  onClose,
}: AnnotationCardProps) {
  return (
    <div
      className="absolute z-30 rounded-xl border border-border/70 bg-background p-3 shadow-lg"
      style={{ top, left, width: CARD_WIDTH }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-2">
        <MessageCircle className="size-4 text-muted-foreground" />
        <span className="text-xs font-medium">Comment</span>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="icon-xs" aria-label="Edit comment" onClick={onEdit}>
            <Pencil className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon-xs" aria-label="Delete comment" onClick={onDelete}>
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>
      {quotedText ? (
        <p className="mt-2 line-clamp-3 border-l-2 border-warning/60 pl-2 text-2xs italic text-muted-foreground">
          {quotedText}
        </p>
      ) : null}
      <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-foreground">{text}</p>
      <div className="mt-2 flex justify-end">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}

interface AnnotationComposerProps {
  draftKey: string;
  top: number;
  left: number;
  quotedText: string;
  initialText: string;
  onCacheDraft: (key: string, text: string) => void;
  onDismiss: () => void;
  onDiscard: () => void;
  onSubmit: (text: string) => void;
}

function AnnotationComposer({
  draftKey,
  top,
  left,
  quotedText,
  initialText,
  onCacheDraft,
  onDismiss,
  onDiscard,
  onSubmit,
}: AnnotationComposerProps) {
  const [text, setText] = useState(initialText);
  const [pos, setPos] = useState({ top, left });

  // Persist the in-progress draft as it changes so dismiss→reopen and reloads
  // both restore it (issue 6). Submit/discard clear it via the parent.
  useEffect(() => {
    onCacheDraft(draftKey, text);
  }, [draftKey, text, onCacheDraft]);

  // Dismiss on click-away / Esc — no longer Cancel-only (issue 5). Pointerdown
  // inside the composer is stopped below, so this only fires for outside clicks.
  useEffect(() => {
    const onPointerDown = () => onDismiss();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onDismiss]);

  return (
    <div
      className="absolute z-40 rounded-xl border border-border/70 bg-background p-3 shadow-lg"
      style={{ top: pos.top, left: pos.left, width: CARD_WIDTH }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {/* Grab handle — drag the composer off the passage it covers (issue 1). */}
      <div
        className="-m-1 flex cursor-grab touch-none select-none items-center gap-2 rounded-lg p-1 active:cursor-grabbing"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          const drag = { startX: event.clientX, startY: event.clientY, ...pos };
          const onDragMove = (move: PointerEvent) =>
            setPos({
              top: drag.top + (move.clientY - drag.startY),
              left: drag.left + (move.clientX - drag.startX),
            });
          const onDragEnd = () => {
            window.removeEventListener("pointermove", onDragMove);
            window.removeEventListener("pointerup", onDragEnd);
          };
          window.addEventListener("pointermove", onDragMove);
          window.addEventListener("pointerup", onDragEnd);
        }}
      >
        <GripVertical className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">Comment on plan</span>
      </div>
      {quotedText ? (
        <p className="mt-2 line-clamp-3 border-l-2 border-warning/60 pl-2 text-2xs italic text-muted-foreground">
          {quotedText}
        </p>
      ) : null}
      <Textarea
        autoFocus
        className="mt-3"
        size="sm"
        value={text}
        placeholder="Request change"
        aria-label="Comment on plan"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onDismiss();
          }
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && text.trim()) {
            event.preventDefault();
            onSubmit(text.trim());
          }
        }}
      />
      <div className="mt-3 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={!text.trim()} onClick={onDiscard}>
          Discard
        </Button>
        <Button size="sm" disabled={!text.trim()} onClick={() => onSubmit(text.trim())}>
          Comment
        </Button>
      </div>
    </div>
  );
}
