import { z } from "zod";

import type { PlanBlock, PlanBlockReadProps } from "../blockTypes";
import { InlineMarkdown } from "../inlineMarkdown";
import { type BadgeSpec, badgeSpecSchema, type Tone, toneColor, toneSchema } from "../tones";
import { PlanBadge } from "./badge";

/**
 * The `<Stats items>` block — the number strip under the lede: one tile per
 * number the answer rests on (`43 min`, `3 of 4`), each a large `value` in its
 * tone colour (neutral → foreground), a mono `label` naming it, and a one-line
 * `detail` (inline markdown) with an optional pill. Bled `stretch` at top level
 * (`MdxPlanRenderer`), so four tiles share one line in the panel.
 */

export interface StatItem {
  value: string;
  label: string;
  detail?: string;
  tone?: Tone;
  badge?: BadgeSpec;
}

export interface StatsData {
  items: StatItem[];
}

const statSchema = z.object({
  value: z.string().trim().min(1).max(24),
  label: z.string().trim().min(1).max(80),
  detail: z.string().trim().max(300).optional(),
  tone: toneSchema.optional(),
  badge: badgeSpecSchema.optional(),
});

const statsSchema = z.object({
  items: z.array(statSchema).min(1).max(8),
}) as unknown as z.ZodType<StatsData>;

function StatsRead({ data, blockId }: PlanBlockReadProps<StatsData>) {
  return (
    <div data-plan-block-id={blockId} data-plan-block-type="stats" className="plan-stats">
      {data.items.map(({ value, label, detail, tone = "neutral", badge }, index) => (
        <div key={index} className="plan-stat">
          <div
            className="plan-stat-value"
            style={tone === "neutral" ? undefined : { color: toneColor(tone) }}
          >
            {value}
          </div>
          <div className="plan-stat-label">{label}</div>
          {(detail || badge) && (
            <div className="plan-stat-detail">
              {detail && <InlineMarkdown text={detail} />}{" "}
              {badge && <PlanBadge spec={badge} hostTone={tone} />}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export const statsBlock: PlanBlock<StatsData> = {
  schema: statsSchema,
  Read: StatsRead,
  mdx: {
    tag: "Stats",
    toAttrs: (data) => ({ items: data.items }),
    fromAttrs: (attrs) => ({ items: attrs.array<StatItem>("items") ?? [] }) as StatsData,
  },
};
