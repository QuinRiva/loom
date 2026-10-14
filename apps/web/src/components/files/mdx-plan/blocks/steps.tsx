import type { CSSProperties, ReactNode } from "react";
import { z } from "zod";

import { cn } from "~/lib/utils";

import type { PlanBlock, PlanBlockReadProps } from "../blockTypes";
import { InlineMarkdown } from "../inlineMarkdown";
import { type BadgeSpec, badgeSpecSchema, type Tone, toneColor, toneSchema } from "../tones";
import { PlanBadge } from "./badge";

/**
 * The `<Steps>` / `<Step>` rail (vocabulary v2) — moments or stages in order:
 * a timeline when `at` is a time, a ladder when it is a stage, numbered when
 * every step omits it. Same container/slot pattern as `<Columns>`/`<Column>`:
 * each step's body is MDX children (inline `<Badge>`, code, lists all work),
 * the chrome is props.
 *
 * LAYOUT. The rail is one grid and every `<Step>` is `display: contents`, so the
 * `at` column lines up down the whole rail (a step cannot size its siblings).
 * The optional aside track appears via `:has(.plan-step-aside)` — the container
 * never sees its children's props. All of that lives in `index.css`
 * (`MDX vocabulary v2: steps`).
 *
 * ANNOTATION. `<Steps>` is one block; `<Step>` is a structural slot (no block
 * type), so blocks nested in a step body keep their own ids.
 */

export interface StepData {
  at?: string;
  title?: string;
  tone?: Tone;
  dashed?: boolean;
  badge?: BadgeSpec;
  aside?: string;
}

const stepSchema = z.object({
  at: z.string().trim().max(40).optional(),
  title: z.string().trim().max(200).optional(),
  tone: toneSchema.optional(),
  dashed: z.boolean().optional(),
  badge: badgeSpecSchema.optional(),
  aside: z.string().trim().max(400).optional(),
}) as unknown as z.ZodType<StepData>;

export function StepRead({ data, children }: PlanBlockReadProps<StepData>) {
  const tone = data.tone ?? "info";
  return (
    <div
      className={cn(
        "plan-step",
        data.dashed
          ? "plan-step--dashed"
          : (tone === "risk" || tone === "warning") && "plan-step--filled",
      )}
      style={{ "--plan-step-tone": toneColor(tone) } as CSSProperties}
    >
      <div className="plan-step-at">{data.at}</div>
      <div className="plan-step-body prose-plan">
        {data.title && (
          <strong className="plan-step-title">
            <InlineMarkdown text={data.title} />
          </strong>
        )}
        {children as ReactNode}
      </div>
      {(data.badge || data.aside) && (
        <div className="plan-step-aside">
          {data.badge && <PlanBadge spec={data.badge} hostTone={tone} />}
          {data.aside && (
            <div>
              <InlineMarkdown text={data.aside} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export const stepBlock: PlanBlock<StepData> = {
  schema: stepSchema,
  Read: StepRead,
  mdx: {
    tag: "Step",
    passChildren: true,
    toAttrs: (data) => ({
      at: data.at,
      title: data.title,
      tone: data.tone,
      dashed: data.dashed,
      badge: data.badge,
      aside: data.aside,
    }),
    fromAttrs: (attrs) =>
      ({
        at: attrs.string("at"),
        title: attrs.string("title"),
        tone: attrs.string("tone") as Tone | undefined,
        dashed: attrs.bool("dashed"),
        badge: attrs.raw("badge") as BadgeSpec | undefined,
        aside: attrs.string("aside"),
      }) as StepData,
  },
};

/* -------------------------------------------------------------------------- */

const stepsSchema = z.object({}) as unknown as z.ZodType<Record<string, never>>;

export function StepsRead({ blockId, children }: PlanBlockReadProps<Record<string, never>>) {
  return (
    <section data-plan-block-id={blockId} data-plan-block-type="steps" className="plan-steps my-4">
      <div className="plan-steps-rail">{children as ReactNode}</div>
    </section>
  );
}

export const stepsBlock: PlanBlock<Record<string, never>> = {
  schema: stepsSchema,
  Read: StepsRead,
  mdx: { tag: "Steps", passChildren: true, toAttrs: () => ({}), fromAttrs: () => ({}) },
};
