import type { CSSProperties, ReactNode } from "react";
import { z } from "zod";

import { cn } from "~/lib/utils";

import type { BlockMdxConfig, PlanBlock, PlanBlockReadProps } from "../blockTypes";
import { InlineMarkdown } from "../inlineMarkdown";
import { type BadgeSpec, badgeSpecSchema, type Tone, toneColor, toneSchema } from "../tones";
import { PlanBadge } from "./badge";

/**
 * The `<Card>` block (§3) — a toned item container for verdict/review batches: a
 * top edge in a categorical tone colour (none for neutral), a header row
 * (heading left, badge pills right), a line of meta chips under it, and a
 * `passChildren` body (`.plan-card*` in `index.css`). Give each item an
 * `id` so annotations anchor to the whole card and nested `<Details>` drill-downs
 * live inside it.
 *
 * The tone is the shared six-slot CATEGORICAL palette (`tones.ts`; not
 * `<Callout>`'s status semantics): a Card tone is a category colour, not a
 * status, so meaning always rides the badge/heading text and colour is triage
 * only. `eyebrow` is the small line above the heading (`RULE 1`, `OPTION B`);
 * `badges` are extra pills with their own tones after `badge`. The heading is
 * inline markdown, so `code` and *emphasis* in it render. `<Card>` is a container like `<Columns>` — it does not participate
 * in the document's heading/section model; headings inside it render normally.
 */

export interface CardData {
  heading: string;
  tone?: Tone;
  badge?: string;
  meta?: string[];
  eyebrow?: string;
  badges?: BadgeSpec[];
}

const cardSchema = z.object({
  heading: z.string().trim().min(1).max(300),
  tone: toneSchema.optional(),
  badge: z.string().trim().max(60).optional(),
  meta: z.array(z.string().trim().min(1).max(120)).max(8).optional(),
  eyebrow: z.string().trim().max(40).optional(),
  badges: z.array(badgeSpecSchema).max(6).optional(),
}) as unknown as z.ZodType<CardData>;

const cardMdx: BlockMdxConfig<CardData> = {
  tag: "Card",
  passChildren: true,
  toAttrs: (data) => ({
    heading: data.heading,
    tone: data.tone,
    badge: data.badge,
    meta: data.meta,
    eyebrow: data.eyebrow,
    badges: data.badges,
  }),
  fromAttrs: (attrs) =>
    ({
      heading: attrs.string("heading") ?? "",
      tone: attrs.string("tone") as Tone | undefined,
      badge: attrs.string("badge"),
      meta: attrs.array<string>("meta"),
      eyebrow: attrs.string("eyebrow"),
      badges: attrs.array<BadgeSpec>("badges"),
    }) as CardData,
};

function CardRead({ data, blockId, children }: PlanBlockReadProps<CardData>) {
  const tone = data.tone ?? "neutral";
  const badges = [...(data.badge ? [data.badge] : []), ...(data.badges ?? [])];
  return (
    <section
      data-plan-block-id={blockId}
      data-plan-block-type="card"
      className={cn("plan-card my-4", tone !== "neutral" && "plan-card--toned")}
      style={{ "--plan-card-tone": toneColor(tone) } as CSSProperties}
    >
      {data.eyebrow && (
        <div
          className="plan-card-eyebrow"
          style={{ color: toneColor(tone === "neutral" ? "warning" : tone) }}
        >
          {data.eyebrow}
        </div>
      )}
      <div className="plan-card-head">
        <span className="plan-card-heading">
          <InlineMarkdown text={data.heading} />
        </span>
        {badges.length > 0 && (
          <span className="plan-card-badges">
            {badges.map((spec, index) => (
              <PlanBadge key={index} spec={spec} hostTone={tone} />
            ))}
          </span>
        )}
      </div>
      {data.meta && data.meta.length > 0 && (
        <div className="plan-card-meta">
          {data.meta.map((chip) => (
            <span key={chip}>{chip}</span>
          ))}
        </div>
      )}
      <div className="prose-plan plan-card-body">{children as ReactNode}</div>
    </section>
  );
}

export const cardBlock: PlanBlock<CardData> = {
  schema: cardSchema,
  mdx: cardMdx,
  Read: CardRead,
};
