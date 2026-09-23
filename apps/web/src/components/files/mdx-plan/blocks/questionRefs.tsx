import { IconChevronRight, IconX } from "@tabler/icons-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "~/lib/utils";

import { escapeId } from "../annotation/anchoring";
import { PLAN_PEEK_ATTR } from "../headingAnchors";

/**
 * PROTOTYPE — "peek at the section this question depends on".
 *
 * A question in the bottom `<QuestionForm>` can carry `refs`, each naming a
 * heading slug from the plan body (see {@link ../headingAnchors}). The refs
 * render as chips under the question; opening one reveals that section — heading
 * to the next heading of the same or higher level — WITHOUT moving the reader
 * out of the form. Two variants are built so the feel can be compared:
 * a floating `popover` and an `inline` expansion, chosen by
 * {@link PlanPeekVariantContext}.
 *
 * The revealed section is a DOM *clone* of the already-rendered section, which
 * is what makes the prototype ~100 lines instead of a second render pass. The
 * clone is inert: nested block interactivity (tabs, details toggles, canvases,
 * sandboxed frames) is dead in the peek, and it carries no plan ids
 * ({@link PLAN_PEEK_ATTR} keeps it out of block-id assignment and annotation
 * anchoring entirely). A promoted feature would render the section through MDX
 * instead — see the thread report.
 */

export interface QuestionRef {
  /** Reader-facing chip text, e.g. "Delivery order". */
  label: string;
  /** Heading slug in the same document (`## Delivery order` → `delivery-order`). */
  anchor: string;
}

export type PlanPeekVariant = "popover" | "inline";

/** Which peek surface the document renders. Prototype-only knob. */
export const PlanPeekVariantContext = createContext<PlanPeekVariant>("popover");

const HEADING_LEVEL = /^H([1-6])$/;

/** `max-h-80` plus its margin — the room a dropped-down popover needs. */
const PEEK_MAX_PX = 336;
const PEEK_WIDTH_PX = 520;

/** The live heading element for `anchor` in the rendered plan. */
function findHeading(root: Element | null, anchor: string): HTMLElement | null {
  const heading = root?.querySelector<HTMLElement>(`#${escapeId(anchor)}`) ?? null;
  return heading && HEADING_LEVEL.test(heading.tagName) ? heading : null;
}

/** The section body: every sibling after the heading, up to the next heading of
 * the same or higher level. */
function sectionBody(heading: HTMLElement): HTMLElement[] {
  const level = Number(HEADING_LEVEL.exec(heading.tagName)![1]);
  const body: HTMLElement[] = [];
  for (let el = heading.nextElementSibling; el instanceof HTMLElement; el = el.nextElementSibling) {
    const next = HEADING_LEVEL.exec(el.tagName);
    if (next && Number(next[1]) <= level) break;
    body.push(el);
  }
  return body;
}

/** A display-only copy, stripped of every id the renderer/annotation layer keys on. */
function cloneForPeek(el: HTMLElement): HTMLElement {
  const clone = el.cloneNode(true) as HTMLElement;
  for (const node of [
    clone,
    ...clone.querySelectorAll<HTMLElement>("[id], [data-plan-block-id]"),
  ]) {
    node.removeAttribute("id");
    node.removeAttribute("data-plan-block-id");
  }
  return clone;
}

/** The revealed section: its heading text, a clone of its body, and the escape
 * hatch that scrolls the real document to it. */
function PeekSection({
  anchor,
  planRoot,
  onClose,
}: {
  anchor: string;
  planRoot: Element | null;
  onClose: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [title, setTitle] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const heading = findHeading(planRoot, anchor);
    setTitle(heading?.textContent ?? null);
    host.replaceChildren(...(heading ? sectionBody(heading).map(cloneForPeek) : []));
  }, [anchor, planRoot]);

  const goToSection = () => {
    const heading = findHeading(planRoot, anchor);
    onClose();
    if (!heading) return;
    heading.scrollIntoView({ block: "start", behavior: "smooth" });
    // One-shot tint so the landing spot is obvious after the scroll settles.
    heading.style.backgroundColor = "color-mix(in oklab, var(--primary) 18%, transparent)";
    setTimeout(() => heading.style.removeProperty("background-color"), 1400);
  };

  return (
    <>
      <div className="flex items-baseline gap-2 border-b border-border/60 px-3 py-1.5">
        <span className="truncate text-xs font-semibold text-foreground">
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
      {/* `select-none`: the body is a CLONE, so a selection here would anchor a
       * comment onto text the annotation layer deliberately cannot see. Comment
       * on the real section instead. */}
      <div ref={hostRef} className="plan-mdx select-none px-3 py-1 text-sm" />
    </>
  );
}

/** The ref chips for one question, plus whichever peek surface is open. */
export function QuestionRefChips({ refs }: { refs: QuestionRef[] }) {
  const variant = useContext(PlanPeekVariantContext);
  const [open, setOpen] = useState<string | null>(null);
  // Viewport coordinates for the popover. It is portalled to <body> because the
  // question form (and the file panel above it) clip their overflow — anchored
  // inside the form, a popover on the last question would be cut in half. Chips
  // sit at the BOTTOM of a plan, so it opens upward when there is no room below.
  const [box, setBox] = useState({ left: 0, top: 0, bottom: 0, above: false });
  const rowRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const planRoot = rowRef.current?.closest("[data-plan-root]") ?? null;

  useEffect(() => {
    if (open === null || variant !== "popover") return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      const target = event.target as Node;
      if (
        event.type === "mousedown" &&
        (rowRef.current?.contains(target) || popoverRef.current?.contains(target))
      )
        return;
      setOpen(null);
    };
    document.addEventListener("keydown", close);
    document.addEventListener("mousedown", close);
    // Fixed coordinates do not follow a scrolling panel; close instead of drifting.
    document.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("keydown", close);
      document.removeEventListener("mousedown", close);
      document.removeEventListener("scroll", close, true);
    };
  }, [open, variant]);

  const surfaceClass = "overflow-hidden rounded-lg border border-border bg-card shadow-sm";
  return (
    <div ref={rowRef} className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-7">
      {refs.map((ref) => (
        <span key={ref.anchor} className="relative inline-block">
          <button
            type="button"
            aria-expanded={open === ref.anchor}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setBox({
                left: Math.max(8, Math.min(rect.left, window.innerWidth - PEEK_WIDTH_PX - 8)),
                top: rect.bottom + 4,
                bottom: window.innerHeight - rect.top + 4,
                above: rect.bottom + PEEK_MAX_PX > window.innerHeight && rect.top > PEEK_MAX_PX,
              });
              setOpen(open === ref.anchor ? null : ref.anchor);
            }}
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
          {variant === "popover" &&
            open === ref.anchor &&
            createPortal(
              <div
                ref={popoverRef}
                {...{ [PLAN_PEEK_ATTR]: "popover" }}
                style={{
                  left: box.left,
                  width: PEEK_WIDTH_PX,
                  ...(box.above ? { bottom: box.bottom } : { top: box.top }),
                }}
                className={cn(surfaceClass, "fixed z-50 max-h-80 overflow-y-auto")}
              >
                <PeekSection
                  anchor={ref.anchor}
                  planRoot={planRoot}
                  onClose={() => setOpen(null)}
                />
              </div>,
              document.body,
            )}
        </span>
      ))}
      {variant === "inline" && open !== null && (
        <div {...{ [PLAN_PEEK_ATTR]: "inline" }} className={cn(surfaceClass, "mt-1 w-full")}>
          <PeekSection anchor={open} planRoot={planRoot} onClose={() => setOpen(null)} />
        </div>
      )}
    </div>
  );
}
