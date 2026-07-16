import type { ReactNode } from "react";
import { z } from "zod";

import { cn } from "~/lib/utils";

import type { BlockMdxConfig, PlanBlock, PlanBlockReadProps } from "../blockTypes";

/**
 * The `<Card>` block (§3) — a toned item container for verdict/review batches: a
 * 4px left border in a categorical tone colour, a header row (heading + optional
 * badge pill + optional meta chips) and a `passChildren` body. Give each item an
 * `id` so annotations anchor to the whole card and nested `<Details>` drill-downs
 * live inside it.
 *
 * The tone palette is a CLOSED six-slot CATEGORICAL palette of its own (not
 * shared with `<Callout>`'s status semantics): a Card tone is a category colour,
 * not a status, so meaning always rides the badge/heading text and colour is
 * triage only. `<Card>` is a container like `<Columns>` — it does not participate
 * in the document's heading/section model; headings inside it render normally.
 */

export type CardTone = "neutral" | "info" | "success" | "warning" | "risk" | "accent";

export interface CardData {
  heading: string;
  tone?: CardTone;
  badge?: string;
  meta?: string[];
}

export const cardSchema = z.object({
  heading: z.string().trim().min(1).max(300),
  tone: z.enum(["neutral", "info", "success", "warning", "risk", "accent"]).optional(),
  badge: z.string().trim().max(60).optional(),
  meta: z.array(z.string().trim().min(1).max(120)).max(8).optional(),
}) as unknown as z.ZodType<CardData>;

export const cardMdx: BlockMdxConfig<CardData> = {
  tag: "Card",
  passChildren: true,
  toAttrs: (data) => ({
    heading: data.heading,
    tone: data.tone,
    badge: data.badge,
    meta: data.meta,
  }),
  fromAttrs: (attrs) =>
    ({
      heading: attrs.string("heading") ?? "",
      tone: attrs.string("tone") as CardTone | undefined,
      badge: attrs.string("badge"),
      meta: attrs.array<string>("meta"),
    }) as CardData,
};

const TONE: Record<CardTone, { border: string; badge: string }> = {
  neutral: { border: "border-l-border", badge: "bg-muted text-muted-foreground" },
  info: { border: "border-l-blue-500", badge: "bg-blue-500/15 text-blue-700 dark:text-blue-300" },
  success: {
    border: "border-l-emerald-500",
    badge: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  },
  warning: {
    border: "border-l-amber-500",
    badge: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  },
  risk: { border: "border-l-red-500", badge: "bg-red-500/15 text-red-700 dark:text-red-300" },
  accent: {
    border: "border-l-violet-500",
    badge: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  },
};

export function CardRead({ data, blockId, children }: PlanBlockReadProps<CardData>) {
  const tone = TONE[data.tone ?? "neutral"];
  return (
    <section
      data-plan-block-id={blockId}
      data-plan-block-type="card"
      className={cn(
        "my-4 overflow-hidden rounded-lg border border-l-4 border-border bg-card",
        tone.border,
      )}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-2">
        <span className="font-semibold text-foreground">{data.heading}</span>
        {data.badge && (
          <span
            className={cn(
              "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
              tone.badge,
            )}
          >
            {data.badge}
          </span>
        )}
        {data.meta?.map((chip) => (
          <span
            key={chip}
            className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground"
          >
            {chip}
          </span>
        ))}
      </div>
      <div className="prose-plan px-3 py-2 text-sm">{children as ReactNode}</div>
    </section>
  );
}

export const cardBlock: PlanBlock<CardData> = {
  schema: cardSchema,
  mdx: cardMdx,
  Read: CardRead,
};
