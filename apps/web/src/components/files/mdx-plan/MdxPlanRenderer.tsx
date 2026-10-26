import {
  Component,
  type ErrorInfo,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { LoaderCircle } from "lucide-react";

import { cn } from "~/lib/utils";
import { useReferenceLinkRules } from "~/loom/referenceLinks";

import { PlanPeekContext } from "./blocks/questionRefs";
import type { PlanSections } from "./headingAnchors";
import type { PlanMdxComponent } from "./mdxCompileOptions";
import { loadPlanDocument } from "./planCompileClient";
import { PLAN_BLOCK_COMPONENTS } from "./registry";

/**
 * Runtime renderer for `.mdx` plans: compiles in a Web Worker so multi-MB documents
 * keep the tab interactive, then runs the module on the main thread through the
 * closed block registry. `run(...)` needs `unsafe-eval`; the guards in
 * {@link ./mdxCompileOptions} bound that eval surface to our own components.
 */

export { compilePlanMdx } from "./mdxCompileOptions";

/**
 * Catches render-time failures (e.g. MDX's `_missingMdxReference` for an unknown
 * tag, or a block throwing). The parent remounts this boundary via `key={source}`
 * so a corrected plan renders fresh — no `componentDidUpdate` reset needed.
 */
class PlanRenderErrorBoundary extends Component<
  { children: ReactNode; onError: (error: Error) => void },
  { errored: boolean }
> {
  override state = { errored: false };
  static getDerivedStateFromError() {
    return { errored: true };
  }
  override componentDidCatch(error: Error, _info: ErrorInfo) {
    this.props.onError(error);
  }
  override render() {
    return this.state.errored ? null : this.props.children;
  }
}

/** Stamp a unique `data-plan-block-id` on every unstamped top-level child and nested
 * `data-plan-block-type` block, from one document-wide counter so ids never collide
 * across nesting depth. Authored ids are kept, and the walk is deterministic (same
 * DOM, same ids), so anchors persist across re-renders. */
export function assignBlockIds(root: HTMLElement): void {
  let counter = 0;
  const stamp = (el: HTMLElement) => {
    if (!el.hasAttribute("data-plan-block-id")) {
      el.setAttribute("data-plan-block-id", `plan-block-${counter}`);
    }
    counter += 1;
  };
  const descend = (parent: HTMLElement, topLevel: boolean) => {
    for (const child of Array.from(parent.children)) {
      if (!(child instanceof HTMLElement)) continue;
      if (topLevel || child.hasAttribute("data-plan-block-type")) stamp(child);
      descend(child, false);
    }
  };
  descend(root, true);
}

/**
 * Non-prose blocks that may escape the prose measure; `.plan-mdx [data-plan-bleed]` in
 * `index.css` and the annotation gutter both key off the stamp. `hug`: content width,
 * capped at the bleed budget. `stretch`: absolutely positioned or `w-full` contents
 * report ~no max-content, so take the budget. Prose blocks and device-sized artboards are absent.
 */
const BLEED_MODE_BY_BLOCK_TYPE: Record<string, "hug" | "stretch"> = {
  "annotated-code": "hug",
  code: "hug",
  columns: "hug",
  "data-model": "hug",
  diff: "hug",
  "field-diff": "hug",
  "file-tree": "hug",
  "json-explorer": "hug",
  mermaid: "hug",
  "openapi-spec": "hug",
  table: "hug",
  canvas: "stretch",
  html: "stretch",
  prototype: "stretch",
  // vocabulary v2: stats — a strip of short tiles has no useful max-content;
  // it takes the budget and the tiles share it, so four sit on one line.
  stats: "stretch",
};

/** The attribute {@link stampBleedingBlocks} writes; also the annotation
 * layer's query for "content that escapes the prose column". */
export const PLAN_BLEED_ATTR = "data-plan-bleed";

/** Mark the TOP-LEVEL non-prose blocks that may bleed past the prose measure, so a
 * nested block never breaks out of its container. Exported for `lint-plan.mjs --out`,
 * whose static page must bleed the same blocks the panel does.
 * @public */
export function stampBleedingBlocks(root: HTMLElement): void {
  for (const child of Array.from(root.children)) {
    // vocabulary v2: table — a GFM table in prose hugs like the `<Table>` block.
    // A prose-language `<Code>` (a quoted message, a markdown excerpt) stays at
    // the measure: its max-content is one long line and would take the budget.
    if (child.hasAttribute("data-plan-code-prose")) continue;
    const mode =
      child.tagName === "TABLE"
        ? "hug"
        : BLEED_MODE_BY_BLOCK_TYPE[child.getAttribute("data-plan-block-type") ?? ""];
    if (mode) child.setAttribute(PLAN_BLEED_ATTR, mode);
  }
}

interface MdxPlanRendererProps {
  source: string;
  className?: string;
  /** Rendered at the end of the sticky header row the outline lives in (the
   * annotation layer's "n of m decided" pill), so the two never overlap. */
  stickyEnd?: ReactNode;
}

/** A document with at least this many top-level sections gets an outline. */
const OUTLINE_MIN_SECTIONS = 4;

type OutlineHeading = { id: string; text: string };
type OutlineItem = OutlineHeading & { subsections: OutlineHeading[] };

/** The document's top-level sections, read once per render from the H2s
 * `headingAnchors` stamped ids on, each with the H3s under it. Headings nested
 * in blocks are not sections. */
const readOutline = (root: HTMLElement): OutlineItem[] => {
  const outline: OutlineItem[] = [];
  for (const heading of root.querySelectorAll<HTMLElement>(":scope > :is(h2, h3)[id]")) {
    const entry = { id: heading.id, text: heading.textContent?.trim() ?? "" };
    if (heading.tagName === "H2") outline.push({ ...entry, subsections: [] });
    else outline.at(-1)?.subsections.push(entry);
  }
  return outline;
};

const OUTLINE_CHIP =
  "shrink-0 truncate rounded-full px-2.5 py-1 hover:bg-accent hover:text-foreground";

/**
 * Sticky section outline (a chip per H2, then the chosen section's H3s) plus the host's
 * `stickyEnd` slot. It sits OUTSIDE `[data-plan-root]` so it takes no block id (which
 * would shift every persisted `plan-block-N` anchor) and stays out of quote search.
 */
function PlanStickyHeader({
  outline,
  rootRef,
  stickyEnd,
}: {
  outline: OutlineItem[];
  rootRef: RefObject<HTMLDivElement | null>;
  stickyEnd: ReactNode;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (outline.length < OUTLINE_MIN_SECTIONS) {
    return stickyEnd ? (
      <div className="pointer-events-none sticky top-2 z-30 flex justify-end pr-2">{stickyEnd}</div>
    ) : null;
  }
  const jumpTo = (id: string) =>
    rootRef.current
      // Slug ids are [a-z0-9-] but may start with a digit, which `#id` rejects.
      ?.querySelector(`[id="${id}"]`)
      ?.scrollIntoView({ block: "start", behavior: "smooth" });
  const subsections = outline.find((item) => item.id === openId)?.subsections ?? [];
  return (
    <div
      className="sticky top-0 z-30 flex items-start border-b border-border bg-background pr-2"
      data-plan-outline-nested={subsections.length > 0 || undefined}
    >
      <nav aria-label="Sections" className="mx-auto min-w-0 max-w-4xl flex-1 px-6 py-1.5">
        <div className="flex gap-1 overflow-x-auto text-xs text-muted-foreground">
          {outline.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={item.id === openId || undefined}
              className={cn(
                OUTLINE_CHIP,
                "max-w-64 aria-[current]:bg-accent aria-[current]:text-foreground",
              )}
              onClick={() => {
                // Commit the sub-row first, so the jump lands clear of the taller header.
                flushSync(() => setOpenId(item.id));
                jumpTo(item.id);
              }}
            >
              {item.text}
            </button>
          ))}
        </div>
        {subsections.length > 0 && (
          <div className="flex gap-0.5 overflow-x-auto pt-0.5 text-2xs text-muted-foreground/80">
            {subsections.map((sub) => (
              <button
                key={sub.id}
                type="button"
                className={cn(OUTLINE_CHIP, "max-w-56 py-0.5")}
                onClick={() => jumpTo(sub.id)}
              >
                {sub.text}
              </button>
            ))}
          </div>
        )}
      </nav>
      {stickyEnd && <div className="py-1.5">{stickyEnd}</div>}
    </div>
  );
}

function PlanCompilingNotice() {
  return (
    <div
      className="mx-auto flex max-w-4xl items-center gap-2 px-6 py-5 text-sm text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      <LoaderCircle className="size-4 animate-spin" />
      Compiling plan…
    </div>
  );
}

function PlanErrorNotice({ message }: { message: string }) {
  return (
    <div className="mx-auto max-w-4xl px-6 py-5">
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
        <div className="font-medium">This plan could not be rendered.</div>
        <div className="mt-1 whitespace-pre-wrap font-mono text-xs opacity-80">{message}</div>
      </div>
    </div>
  );
}

export function MdxPlanRenderer({ source, className, stickyEnd }: MdxPlanRendererProps) {
  const [content, setContent] = useState<{
    Component: PlanMdxComponent;
    sections: PlanSections;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [compiling, setCompiling] = useState(true);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const referenceLinks = useReferenceLinkRules();
  const peekDocument = {
    source,
    sections: content?.sections ?? {},
    components: PLAN_BLOCK_COMPONENTS,
  };

  useEffect(() => {
    let active = true;
    // oxlint-disable-next-line react/set-state-in-effect -- A new source starts a compile, which shows as compiling until it settles.
    setError(null);
    setCompiling(true);
    void loadPlanDocument(source, referenceLinks)
      .then((compiled) => {
        if (active) {
          setContent(compiled);
          setCompiling(false);
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setContent(null);
          setCompiling(false);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => {
      active = false;
    };
  }, [source, referenceLinks]);

  useEffect(() => {
    if (!containerRef.current) return;
    assignBlockIds(containerRef.current);
    stampBleedingBlocks(containerRef.current);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- New content is a freshly rendered document to stamp.
  }, [content]);

  // Before paint, so the outline row never pops in above an already-painted page.
  useLayoutEffect(() => {
    if (containerRef.current) setOutline(readOutline(containerRef.current));
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- The outline is read from the DOM the new content rendered.
  }, [content]);

  if (error !== null) {
    return <PlanErrorNotice message={error} />;
  }
  if (content === null) {
    return compiling ? <PlanCompilingNotice /> : null;
  }

  const { Component: MdxContent } = content;
  return (
    <>
      <PlanStickyHeader outline={outline} rootRef={containerRef} stickyEnd={stickyEnd} />
      <div
        ref={containerRef}
        data-plan-root
        className={cn("plan-mdx mx-auto max-w-4xl px-6 py-5", className)}
      >
        <PlanRenderErrorBoundary key={source} onError={(cause) => setError(cause.message)}>
          {/* The source + registry a question's "peek" re-renders one section with. */}
          <PlanPeekContext.Provider value={peekDocument}>
            <MdxContent components={PLAN_BLOCK_COMPONENTS} />
          </PlanPeekContext.Provider>
        </PlanRenderErrorBoundary>
      </div>
    </>
  );
}
