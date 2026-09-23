import { IconChevronRight, IconX } from "@tabler/icons-react";
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "~/lib/utils";

import { escapeId } from "../annotation/anchoring";
import { PLAN_PEEK_ATTR, sectionSource } from "../headingAnchors";
import type { PlanMdxComponent } from "../mdxCompileOptions";
import { compileInWorker } from "../planCompileClient";

/**
 * "Peek at the section this question depends on".
 *
 * A question in the bottom `<QuestionForm>` can carry `refs`, each naming a
 * heading slug from the plan body (see {@link ../headingAnchors}). The refs
 * render as chips under the question; opening one shows that section — heading
 * to the next heading of the same or higher level — in a popover over the form,
 * so the reader never loses their place mid-answer.
 *
 * The peek is a REAL render, not a copy of the rendered DOM: the section's
 * source slice is compiled through the same worker + closed block registry as
 * the document, so tabs, disclosures, canvases and sandboxed frames inside a
 * peeked section behave exactly as they do in the body. Three things keep that
 * second render invisible to the annotation layer: the popover is portalled to
 * `<body>` (outside `[data-plan-root]`, which every annotation query and every
 * block-id lookup is scoped to), and — for belt and braces — `assignBlockIds`
 * and `flattenDocument` both reject any {@link PLAN_PEEK_ATTR} subtree.
 */

export interface QuestionRef {
  /** Reader-facing chip text, e.g. "Delivery order". */
  label: string;
  /** Heading slug in the same document (`## Delivery order` → `delivery-order`). */
  anchor: string;
}

/**
 * What a peek needs from the document hosting it: the plan source to slice a
 * section out of, and the block registry to render that slice with. Provided by
 * {@link ../MdxPlanRenderer}, which owns both — taking the registry through
 * context rather than importing it keeps this block out of an import cycle with
 * the registry that lists it.
 */
export interface PlanPeekDocument {
  source: string;
  components: Record<string, unknown>;
}

export const PlanPeekContext = createContext<PlanPeekDocument | null>(null);

const HEADING_LEVEL = /^H([1-6])$/;

/** Share of the viewport a peek may grow to before it scrolls. */
const MAX_HEIGHT_RATIO = 0.7;
const GAP_PX = 6;

/** Compiled section slices, keyed by the slice itself — reopening a chip (the
 * common motion while answering) must not re-compile or flash an empty box. */
const compiledSections = new Map<string, Promise<PlanMdxComponent>>();

function compileSection(slice: string): Promise<PlanMdxComponent> {
  const existing = compiledSections.get(slice);
  if (existing) return existing;
  // Editing a plan changes every slice it touches; drop the lot rather than
  // grow a cache of sections nobody can reach any more.
  if (compiledSections.size > 32) compiledSections.clear();
  const compiled = compileInWorker(slice);
  compiledSections.set(slice, compiled);
  return compiled;
}

/** The live heading element for `anchor` in the rendered plan. */
function findHeading(root: Element | null, anchor: string): HTMLElement | null {
  const heading = root?.querySelector<HTMLElement>(`#${escapeId(anchor)}`) ?? null;
  return heading && HEADING_LEVEL.test(heading.tagName) ? heading : null;
}

/** The revealed section: its heading text, a live render of its body, and the
 * escape hatch that scrolls the real document to it. */
function PeekSection({
  anchor,
  doc,
  getPlanRoot,
  titleId,
  onClose,
}: {
  anchor: string;
  doc: PlanPeekDocument;
  /** Resolved on demand, never during render — the popover is portalled out of
   * the document, so only the chip row knows where the plan root is. */
  getPlanRoot: () => Element | null;
  titleId: string;
  onClose: () => void;
}) {
  const [title, setTitle] = useState<string | null>(null);
  const [content, setContent] = useState<{ Section: PlanMdxComponent } | { error: string } | null>(
    null,
  );

  useEffect(() => {
    let active = true;
    setContent(null);
    setTitle(findHeading(getPlanRoot(), anchor)?.textContent ?? null);
    const slice = sectionSource(doc.source, anchor);
    if (slice === null) {
      setContent({ error: `No section in this plan is anchored at "${anchor}".` });
      return;
    }
    void compileSection(slice).then(
      (Section) => {
        if (active) setContent({ Section });
      },
      (cause: unknown) => {
        if (active) setContent({ error: cause instanceof Error ? cause.message : String(cause) });
      },
    );
    return () => {
      active = false;
    };
  }, [anchor, doc.source, getPlanRoot]);

  const goToSection = () => {
    const heading = findHeading(getPlanRoot(), anchor);
    onClose();
    if (!heading) return;
    heading.scrollIntoView({ block: "start", behavior: "smooth" });
    // One-shot tint so the landing spot is obvious after the scroll settles.
    heading.style.backgroundColor = "color-mix(in oklab, var(--primary) 18%, transparent)";
    setTimeout(() => heading.style.removeProperty("background-color"), 1400);
  };

  return (
    <>
      <div className="flex shrink-0 items-baseline gap-2 border-b border-border/60 px-4 py-1.5">
        <span id={titleId} className="truncate text-xs font-semibold text-foreground">
          {title ?? `Unknown section "${anchor}"`}
        </span>
        <button
          type="button"
          onClick={goToSection}
          className="ml-auto shrink-0 text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          Go to section
        </button>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <IconX className="size-3.5" />
        </button>
      </div>
      <div className="plan-mdx min-h-0 overflow-y-auto px-4 py-1 text-sm">
        {content === null ? null : "error" in content ? (
          <p className="py-2 text-xs text-muted-foreground">{content.error}</p>
        ) : (
          <content.Section components={doc.components} />
        )}
      </div>
    </>
  );
}

/** The ref chips for one question, plus the peek popover when one is open. */
export function QuestionRefChips({ refs }: { refs: QuestionRef[] }) {
  const doc = useContext(PlanPeekContext);
  const [open, setOpen] = useState<string | null>(null);
  // Viewport coordinates for the popover. It is portalled to <body> because the
  // question form (and the file panel above it) clip their overflow — anchored
  // inside the form, a popover on the last question would be cut in half. It
  // spans the question's own column and hugs its content up to 70% of the
  // viewport; chips sit near the BOTTOM of a plan, so it flips above the chip
  // when the room below is worse.
  const [box, setBox] = useState({
    left: 0,
    width: 0,
    top: 0,
    bottom: 0,
    maxHeight: 0,
    above: false,
  });
  const rowRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const chipRefs = useRef(new Map<string, HTMLButtonElement>());
  const popoverId = useId();
  const getPlanRoot = useCallback(() => rowRef.current?.closest("[data-plan-root]") ?? null, []);

  const close = useCallback(() => {
    // Only pull focus back when it is ours to move (Escape, the close button) —
    // a click elsewhere on the page must keep the focus it just took.
    if (open !== null && popoverRef.current?.contains(document.activeElement)) {
      chipRefs.current.get(open)?.focus();
    }
    setOpen(null);
  }, [open]);

  useEffect(() => {
    if (open === null) return;
    popoverRef.current?.focus();
    const dismiss = (event: Event) => {
      if (event.type === "keydown") {
        if ((event as KeyboardEvent).key === "Escape") close();
        return;
      }
      const target = event.target instanceof Node ? event.target : null;
      // Reading the peek must not dismiss it: a scroll or a click INSIDE the
      // popover is use, not dismissal. A chip click is handled by the chip.
      if (target && popoverRef.current?.contains(target)) return;
      if (event.type === "mousedown" && target && rowRef.current?.contains(target)) return;
      // Fixed coordinates do not follow a scrolling panel or a resize; close
      // rather than drift away from the chip that opened it.
      close();
    };
    document.addEventListener("keydown", dismiss);
    document.addEventListener("mousedown", dismiss);
    document.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("keydown", dismiss);
      document.removeEventListener("mousedown", dismiss);
      document.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [open, close]);

  if (!doc) return null;

  const toggle = (anchor: string, chip: HTMLButtonElement) => {
    if (open === anchor) {
      close();
      return;
    }
    const row = rowRef.current!.getBoundingClientRect();
    const rect = chip.getBoundingClientRect();
    const cap = window.innerHeight * MAX_HEIGHT_RATIO;
    const below = window.innerHeight - rect.bottom - GAP_PX - 8;
    const above = rect.top - GAP_PX - 8;
    const flip = below < Math.min(cap, above);
    setBox({
      left: row.left,
      width: row.width,
      top: rect.bottom + GAP_PX,
      bottom: window.innerHeight - rect.top + GAP_PX,
      maxHeight: Math.min(cap, flip ? above : below),
      above: flip,
    });
    setOpen(anchor);
  };

  return (
    <div ref={rowRef} className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-7">
      {refs.map((ref) => (
        <button
          key={ref.anchor}
          type="button"
          ref={(chip) => {
            if (chip) chipRefs.current.set(ref.anchor, chip);
            else chipRefs.current.delete(ref.anchor);
          }}
          aria-expanded={open === ref.anchor}
          aria-controls={open === ref.anchor ? popoverId : undefined}
          onClick={(event) => toggle(ref.anchor, event.currentTarget)}
          className={cn(
            "inline-flex items-center gap-0.5 rounded-full border px-2 py-0.5 text-[11px] transition-colors",
            open === ref.anchor
              ? "border-primary bg-primary/10 text-foreground"
              : "border-border bg-muted/40 text-muted-foreground hover:border-primary/60 hover:text-foreground",
          )}
        >
          {ref.label}
          <IconChevronRight className="size-3" />
        </button>
      ))}
      {open !== null &&
        createPortal(
          <div
            ref={popoverRef}
            id={popoverId}
            role="dialog"
            aria-labelledby={`${popoverId}-title`}
            tabIndex={-1}
            {...{ [PLAN_PEEK_ATTR]: "" }}
            style={{
              left: box.left,
              width: box.width,
              maxHeight: box.maxHeight,
              ...(box.above ? { bottom: box.bottom } : { top: box.top }),
            }}
            className="fixed z-50 flex flex-col overflow-hidden rounded-lg border border-border bg-card shadow-lg outline-none"
          >
            <PeekSection
              anchor={open}
              doc={doc}
              getPlanRoot={getPlanRoot}
              titleId={`${popoverId}-title`}
              onClose={close}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}
