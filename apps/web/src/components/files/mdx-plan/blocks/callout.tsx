import {
  IconAlertTriangle,
  IconBulb,
  IconCircleCheck,
  IconInfoCircle,
  IconShieldExclamation,
} from "@tabler/icons-react";
import type { ComponentType } from "react";
import { z } from "zod";

import { cn } from "~/lib/utils";

import type { BlockMdxConfig, PlanBlock, PlanBlockReadProps } from "../blockTypes";

/**
 * The `<Callout>` block — an emphasised note with a tone (info/decision/risk/
 * warning/success) and a markdown body rendered as MDX *children* (the prose
 * between the tags). Schema + MDX round-trip ported verbatim from
 * `@agent-native/core` `callout.config.ts` (`tone` is an attribute; `body` is
 * `childrenField` prose, not an attribute).
 */

export type CalloutTone = "info" | "decision" | "risk" | "warning" | "success";

export interface CalloutData {
  tone?: CalloutTone;
  /** Markdown body, rendered as MDX children. */
  body: string;
}

export const calloutSchema = z.object({
  tone: z.enum(["info", "decision", "risk", "warning", "success"]).optional(),
  // `body` is the MDX prose *children*, not a prop, so it is absent from the
  // props the registry validates (mirrors `<Endpoint>`'s optional description).
  body: z.string().trim().max(10_000).optional(),
}) as unknown as z.ZodType<CalloutData>;

export const calloutMdx: BlockMdxConfig<CalloutData> = {
  tag: "Callout",
  childrenField: "body",
  toAttrs: (data) => ({ tone: data.tone }),
  fromAttrs: (attrs, children) =>
    ({
      tone: attrs.string("tone") as CalloutTone | undefined,
      body: children,
    }) as CalloutData,
};

const TONE: Record<
  CalloutTone,
  { icon: ComponentType<{ className?: string }>; label: string; frame: string; accent: string }
> = {
  info: {
    icon: IconInfoCircle,
    label: "Note",
    frame: "border-blue-300/60 bg-blue-50/60 dark:border-blue-500/25 dark:bg-blue-500/10",
    accent: "text-blue-600 dark:text-blue-300",
  },
  decision: {
    icon: IconBulb,
    label: "Decision",
    frame: "border-violet-300/60 bg-violet-50/60 dark:border-violet-500/25 dark:bg-violet-500/10",
    accent: "text-violet-600 dark:text-violet-300",
  },
  risk: {
    icon: IconShieldExclamation,
    label: "Risk",
    frame: "border-red-300/60 bg-red-50/60 dark:border-red-500/25 dark:bg-red-500/10",
    accent: "text-red-600 dark:text-red-300",
  },
  warning: {
    icon: IconAlertTriangle,
    label: "Warning",
    frame: "border-amber-300/60 bg-amber-50/60 dark:border-amber-500/25 dark:bg-amber-500/10",
    accent: "text-amber-600 dark:text-amber-300",
  },
  success: {
    icon: IconCircleCheck,
    label: "Success",
    frame:
      "border-emerald-300/60 bg-emerald-50/60 dark:border-emerald-500/25 dark:bg-emerald-500/10",
    accent: "text-emerald-600 dark:text-emerald-300",
  },
};

export function CalloutRead({ data, blockId, children }: PlanBlockReadProps<CalloutData>) {
  const tone = TONE[data.tone ?? "info"];
  const Icon = tone.icon;
  return (
    <aside
      data-plan-block-id={blockId}
      data-plan-block-type="callout"
      className={cn("my-4 flex gap-3 rounded-xl border p-4", tone.frame)}
    >
      <Icon className={cn("mt-0.5 size-5 shrink-0", tone.accent)} />
      <div className="min-w-0 flex-1">
        <div className={cn("text-xs font-semibold uppercase tracking-wide", tone.accent)}>
          {tone.label}
        </div>
        <div className="prose-plan mt-1 text-sm text-foreground">
          {children ?? <p>{data.body}</p>}
        </div>
      </div>
    </aside>
  );
}

export const calloutBlock: PlanBlock<CalloutData> = {
  schema: calloutSchema,
  mdx: calloutMdx,
  Read: CalloutRead,
};
