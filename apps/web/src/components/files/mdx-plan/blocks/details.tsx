import { IconChevronRight } from "@tabler/icons-react";
import { type ReactNode, useContext, useEffect, useState } from "react";
import { z } from "zod";

import type { BlockMdxConfig, PlanBlock, PlanBlockReadProps } from "../blockTypes";
import { PlanEagerMountContext } from "../planEagerMount";

/**
 * The `<Details>` block (§2) — a collapsible `passChildren` container for
 * progressive disclosure (bulk evidence, full production records) that used to
 * force a companion HTML file. The body is ordinary MDX: prose and any nested
 * blocks, including another `<Details>`.
 *
 * Uncontrolled-with-default: the open state is local component state seeded from
 * the authored `open`, synced via `onToggle`, so a user's expand/collapse is NOT
 * reset by the annotation layer re-rendering, AND a programmatic open (the
 * collapsed-annotation "open on navigate" affordance sets `details.open = true`)
 * flows back into React state through the native `toggle` event — the layer never
 * has to mutate `open` during overlay recomputation.
 *
 * Children are mounted lazily — not until the disclosure is first opened — then
 * kept mounted (an opened-once flag survives collapse, so re-opening is instant).
 * On an evidence-heavy document this roughly halves the initial DOM/render cost,
 * since 40–60% of nodes live inside drill-downs a reviewer may never open. The
 * {@link PlanEagerMountContext} escape hatch forces eager mounting when the
 * annotation layer has pending comments that may be anchored inside a closed
 * `<Details>` (so they resolve as `collapsed`, not `detached`).
 */

export interface DetailsData {
  summary: string;
  open?: boolean;
}

export const detailsSchema = z.object({
  summary: z.string().trim().min(1).max(300),
  open: z.boolean().optional(),
}) as unknown as z.ZodType<DetailsData>;

export const detailsMdx: BlockMdxConfig<DetailsData> = {
  tag: "Details",
  passChildren: true,
  toAttrs: (data) => ({ summary: data.summary, open: data.open }),
  fromAttrs: (attrs) =>
    ({ summary: attrs.string("summary") ?? "", open: attrs.bool("open") }) as DetailsData,
};

export function DetailsRead({ data, blockId, children }: PlanBlockReadProps<DetailsData>) {
  const eager = useContext(PlanEagerMountContext);
  const initialOpen = data.open ?? false;
  const [open, setOpen] = useState(initialOpen);
  // Once opened (or eager, or authored-open), children stay mounted so a
  // re-open is instant and their state survives a collapse.
  const [mounted, setMounted] = useState(eager || initialOpen);
  // Latch on eager becoming true AFTER first render too: the surrounding
  // FilePreviewPanel is keyed by environment (not thread), so this instance
  // survives a thread switch that flips the eager flag false → true as the
  // active draft's comments change. Mount-and-retain then, so a persisted
  // comment inside a never-opened disclosure resolves as `collapsed`, not
  // `detached`. Retained if eager later flips back to false.
  useEffect(() => {
    if (eager) setMounted(true);
  }, [eager]);
  return (
    <details
      data-plan-block-id={blockId}
      data-plan-block-type="details"
      open={open}
      onToggle={(event) => {
        const isOpen = event.currentTarget.open;
        setOpen(isOpen);
        if (isOpen) setMounted(true);
      }}
      className="plan-details my-4 overflow-hidden rounded-lg border border-border bg-card"
    >
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm font-medium text-foreground select-none hover:bg-muted/40">
        <IconChevronRight className="plan-details-chevron size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0">{data.summary}</span>
      </summary>
      <div className="prose-plan border-t border-border/60 px-3 py-2 text-sm">
        {mounted ? (children as ReactNode) : null}
      </div>
    </details>
  );
}

export const detailsBlock: PlanBlock<DetailsData> = {
  schema: detailsSchema,
  mdx: detailsMdx,
  Read: DetailsRead,
};
