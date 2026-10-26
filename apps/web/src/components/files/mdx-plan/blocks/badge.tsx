import type { ReactNode } from "react";
import { z } from "zod";

import type { PlanBlock, PlanBlockReadProps } from "../blockTypes";
import { badgeClass, resolveBadge, type BadgeSpec, type Tone, toneSchema } from "../tones";

/**
 * `<Badge tone>`: an inline pill inside prose. It is text, not a block (no block type
 * or id), so the annotation layer treats a selection through it as prose.
 * {@link PlanBadge} is the same pill for blocks with a `BadgeSpec` prop.
 */

export interface BadgeData {
  tone?: Tone;
}

const badgeSchema = z.object({ tone: toneSchema.optional() }) as unknown as z.ZodType<BadgeData>;

export function PlanBadge({ spec, hostTone }: { spec: BadgeSpec; hostTone?: Tone }) {
  const { label, tone } = resolveBadge(spec, hostTone);
  return <span className={badgeClass(tone)}>{label}</span>;
}

function BadgeRead({ data, children }: PlanBlockReadProps<BadgeData>) {
  return <span className={badgeClass(data.tone)}>{children as ReactNode}</span>;
}

export const badgeBlock: PlanBlock<BadgeData> = {
  schema: badgeSchema,
  Read: BadgeRead,
  mdx: {
    tag: "Badge",
    passChildren: true,
    inline: true,
    toAttrs: (data) => ({ tone: data.tone }),
    fromAttrs: (attrs) => ({ tone: attrs.string("tone") as Tone | undefined }) as BadgeData,
  },
};
