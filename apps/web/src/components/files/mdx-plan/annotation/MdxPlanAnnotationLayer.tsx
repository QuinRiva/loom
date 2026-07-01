import type { PlanCommentAnchor } from "@t3tools/contracts";
import { MessageCircle, Pencil, Trash2, Unlink } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  type MdxAnchorReviewCommentContext,
  type ReviewCommentContext,
} from "~/reviewCommentContext";

import { MdxPlanRenderer } from "../MdxPlanRenderer";
import { anchorForBlockElement, anchorFromRange, resolveAnchor } from "./anchoring";

/**
 * Annotation layer over a rendered MDX plan. Adds the reviewer experience the
 * `.md` path never had: select prose (or a whole non-prose block) → capture a
 * portable {@link PlanCommentAnchor} → compose a comment → it flows through the
 * existing composer review-comment plumbing (`addReviewComment` →
 * `appendReviewCommentsToPrompt`) as the injected user turn on send.
 *
 * Pending comments are re-resolved against the live DOM every layout change so
 * highlights track the text; when an anchor no longer resolves (the plan text
 * moved/changed) the comment degrades to a clean "detached" card rather than
 * being dropped. Highlight/affordance positions are stored relative to the
 * wrapper, so they are scroll-invariant and only recomputed on layout changes.
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
  detached: boolean;
}

interface ComposerState {
  id: string;
  anchor: PlanCommentAnchor;
  quotedText: string;
  initialText: string;
  top: number;
  left: number;
}

const CARD_WIDTH = 320;

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

  const draft = useComposerDraftStore((store) => store.getComposerDraft(composerDraftTarget));
  const addReviewComment = useComposerDraftStore((store) => store.addReviewComment);
  const removeReviewComment = useComposerDraftStore((store) => store.removeReviewComment);
  const comments = useMemo(
    () => (draft?.reviewComments ?? []).filter((c) => isMdxAnchorComment(c, filePath)),
    [draft?.reviewComments, filePath],
  );

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
  }, [source]);

  const recompute = useCallback(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper || !root) {
      setOverlays([]);
      return;
    }
    const wrapperRect = wrapper.getBoundingClientRect();
    setOverlays(
      comments.map((comment) => {
        const range = comment.anchor ? resolveAnchor(comment.anchor, root) : null;
        if (!range) {
          return { id: comment.id, comment, boxes: [], badge: { top: 0, left: 0 }, detached: true };
        }
        const boxes = Array.from(range.getClientRects(), (rect) => ({
          top: rect.top - wrapperRect.top,
          left: rect.left - wrapperRect.left,
          width: rect.width,
          height: rect.height,
        })).filter((box) => box.width > 0 && box.height > 0);
        const last = boxes[boxes.length - 1];
        return {
          id: comment.id,
          comment,
          boxes,
          badge: last ? { top: last.top, left: last.left + last.width } : { top: 0, left: 0 },
          detached: boxes.length === 0,
        };
      }),
    );
  }, [comments, root]);

  // Recompute overlays on any layout-affecting change to the plan DOM.
  useLayoutEffect(() => {
    if (!root) {
      setOverlays([]);
      return;
    }
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(recompute);
    };
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(root);
    const mutationObserver = new MutationObserver(schedule);
    mutationObserver.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [root, recompute]);

  // Hide the selection affordance when the selection collapses.
  useEffect(() => {
    const onSelectionChange = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) setSelectionAffordance(null);
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, []);

  const wrapperRectNow = () => wrapperRef.current?.getBoundingClientRect() ?? new DOMRect();
  const clampLeft = (left: number) =>
    Math.max(8, Math.min(left, wrapperRectNow().width - CARD_WIDTH - 8));

  const handleMouseUp = useCallback(() => {
    requestAnimationFrame(() => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      if (!root || !root.contains(range.commonAncestorContainer)) {
        setSelectionAffordance(null);
        return;
      }
      const rects = range.getClientRects();
      const last = rects[rects.length - 1];
      if (!last) return;
      const wrapperRect = wrapperRectNow();
      pendingRangeRef.current = range.cloneRange();
      setSelectionAffordance({
        top: last.bottom - wrapperRect.top + 6,
        left: last.right - wrapperRect.left,
      });
    });
  }, [root]);

  const openComposerFromSelection = () => {
    const range = pendingRangeRef.current;
    if (!range || !root) return;
    const result = anchorFromRange(range, root);
    if (!result) return;
    const wrapperRect = wrapperRectNow();
    const rect = range.getBoundingClientRect();
    setComposer({
      id: newCommentId(),
      anchor: result.anchor,
      quotedText: result.quotedText,
      initialText: "",
      top: rect.bottom - wrapperRect.top + 8,
      left: clampLeft(rect.left - wrapperRect.left),
    });
    setSelectionAffordance(null);
    setOpenCardId(null);
    window.getSelection()?.removeAllRanges();
  };

  const openComposerForBlock = (blockId: string) => {
    if (!root) return;
    const element = root.querySelector(`[data-plan-block-id="${blockId}"]`);
    if (!element) return;
    const result = anchorForBlockElement(element, root);
    const wrapperRect = wrapperRectNow();
    const rect = element.getBoundingClientRect();
    setComposer({
      id: newCommentId(),
      anchor: result.anchor,
      quotedText: result.quotedText,
      initialText: "",
      top: rect.bottom - wrapperRect.top + 8,
      left: clampLeft(rect.left - wrapperRect.left),
    });
    setHoverBlock(null);
    setOpenCardId(null);
  };

  const openComposerForEdit = (comment: MdxAnchorReviewCommentContext, overlay?: Overlay) => {
    const badge = overlay?.badge;
    setComposer({
      id: comment.id,
      anchor: comment.anchor,
      quotedText: comment.quotedText,
      initialText: comment.text,
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
        anchor.anchorKind === "text" ? "annotation" : `${anchor.blockType ?? "block"} block`,
      text,
      anchor,
      quotedText: composer.quotedText,
    };
    addReviewComment(composerDraftTarget, comment);
    setComposer(null);
  };

  const removeComment = (id: string) => {
    removeReviewComment(composerDraftTarget, id);
    setOpenCardId(null);
    if (composer?.id === id) setComposer(null);
  };

  const detached = overlays.filter((overlay) => overlay.detached);

  return (
    <div
      ref={wrapperRef}
      className="relative"
      onMouseUp={handleMouseUp}
      onMouseMove={(event) => {
        if (!root) return;
        const target = event.target as Element;
        const block = target.closest?.("[data-plan-block-id]");
        if (!block || !root.contains(block)) {
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
      }}
      onMouseLeave={() => {
        hoverBlockIdRef.current = null;
        setHoverBlock(null);
      }}
    >
      <MdxPlanRenderer source={source} />

      {/* Highlight overlays for each pending annotation (non-interactive). */}
      <div className="pointer-events-none absolute inset-0 z-10">
        {overlays.flatMap((overlay) =>
          overlay.boxes.map((box) => (
            <div
              key={`${overlay.id}:${box.top}:${box.left}`}
              className="absolute rounded-sm bg-amber-300/25 ring-1 ring-amber-400/50"
              style={{ top: box.top, left: box.left, width: box.width, height: box.height }}
            />
          )),
        )}
      </div>

      {/* Numbered badges — click to open a comment card. */}
      {overlays.map((overlay, index) =>
        overlay.detached ? null : (
          <button
            key={overlay.id}
            type="button"
            aria-label={`Comment ${index + 1}`}
            className="absolute z-20 grid size-5 -translate-y-1 place-items-center rounded-full bg-amber-500 text-[10px] font-bold text-white shadow ring-2 ring-background"
            style={{ top: overlay.badge.top, left: overlay.badge.left + 2 }}
            onClick={() => setOpenCardId((current) => (current === overlay.id ? null : overlay.id))}
          >
            {index + 1}
          </button>
        ),
      )}

      {/* Comment card for an opened badge. */}
      {overlays.map((overlay) =>
        openCardId === overlay.id && !overlay.detached ? (
          <AnnotationCard
            key={`card-${overlay.id}`}
            top={overlay.badge.top + 20}
            left={clampLeft(overlay.badge.left)}
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
          className="absolute z-30 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs font-medium shadow-lg hover:bg-accent"
          style={{ top: selectionAffordance.top, left: selectionAffordance.left }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={openComposerFromSelection}
        >
          <MessageCircle className="size-3.5" />
          Comment
        </button>
      ) : null}

      {/* Per-block "comment" affordance (covers non-selectable / non-prose blocks). */}
      {hoverBlock && !composer && !selectionAffordance ? (
        <button
          type="button"
          aria-label="Comment on this block"
          className="absolute z-20 grid size-6 place-items-center rounded-md border border-border bg-background/90 text-muted-foreground shadow-sm hover:bg-accent hover:text-foreground"
          style={{ top: hoverBlock.top, left: hoverBlock.left }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => openComposerForBlock(hoverBlock.id)}
        >
          <MessageCircle className="size-3.5" />
        </button>
      ) : null}

      {/* Comment composer (new comment or edit). */}
      {composer ? (
        <AnnotationComposer
          key={composer.id}
          top={composer.top}
          left={composer.left}
          quotedText={composer.quotedText}
          initialText={composer.initialText}
          onCancel={() => setComposer(null)}
          onSubmit={submitComposer}
        />
      ) : null}

      {/* Detached annotations — anchors that no longer resolve to the plan. */}
      {detached.length > 0 ? (
        <div className="pointer-events-auto absolute right-3 top-3 z-30 flex w-72 flex-col gap-2">
          {detached.map((overlay) => (
            <div
              key={`detached-${overlay.id}`}
              className="rounded-xl border border-amber-500/40 bg-amber-50/90 p-3 shadow-sm dark:bg-amber-500/10"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300">
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
                <p className="mt-2 line-clamp-2 border-l-2 border-amber-400/60 pl-2 text-[11px] italic text-muted-foreground">
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
        <p className="mt-2 line-clamp-3 border-l-2 border-amber-400/60 pl-2 text-[11px] italic text-muted-foreground">
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
  top: number;
  left: number;
  quotedText: string;
  initialText: string;
  onCancel: () => void;
  onSubmit: (text: string) => void;
}

function AnnotationComposer({
  top,
  left,
  quotedText,
  initialText,
  onCancel,
  onSubmit,
}: AnnotationComposerProps) {
  const [text, setText] = useState(initialText);

  return (
    <div
      className="absolute z-40 rounded-xl border border-border/70 bg-background p-3 shadow-lg"
      style={{ top, left, width: CARD_WIDTH }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-2">
        <MessageCircle className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">Comment on plan</span>
      </div>
      {quotedText ? (
        <p className="mt-2 line-clamp-3 border-l-2 border-amber-400/60 pl-2 text-[11px] italic text-muted-foreground">
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
            onCancel();
          }
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && text.trim()) {
            event.preventDefault();
            onSubmit(text.trim());
          }
        }}
      />
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={!text.trim()} onClick={() => onSubmit(text.trim())}>
          Comment
        </Button>
      </div>
    </div>
  );
}
