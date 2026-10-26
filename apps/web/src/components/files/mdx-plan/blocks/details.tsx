import { IconChevronRight } from "@tabler/icons-react";
import { type ReactNode, useContext, useState } from "react";
import { z } from "zod";

import type { BlockMdxConfig, PlanBlock, PlanBlockReadProps } from "../blockTypes";
import { PlanEagerMountContext } from "../planEagerMount";

/**
 * `<Details>`: a collapsible container. Open state is local, seeded from `open` and synced
 * via `onToggle`, so re-renders do not reset it and a programmatic open flows back in.
 * Children mount on first open and stay mounted, unless {@link PlanEagerMountContext}
 * forces eager mounting so pending comments inside resolve as `collapsed`.
 */

export interface DetailsData {
  summary: string;
  open?: boolean;
}

const detailsSchema = z.object({
  summary: z.string().trim().min(1).max(300),
  open: z.boolean().optional(),
}) as unknown as z.ZodType<DetailsData>;

const detailsMdx: BlockMdxConfig<DetailsData> = {
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
  // Latch eager after first render too: FilePreviewPanel is keyed by environment, so a
  // thread switch can flip eager false → true on this instance. Retained if it flips back.
  if (eager && !mounted) setMounted(true);
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
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm font-semibold text-foreground select-none hover:bg-muted/40">
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
