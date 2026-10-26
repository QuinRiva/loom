import {
  IconAlertTriangle,
  IconBulb,
  IconCircleCheck,
  IconInfoCircle,
  IconShieldExclamation,
} from "@tabler/icons-react";
import type { ComponentType, CSSProperties } from "react";
import { z } from "zod";

import type { BlockMdxConfig, PlanBlock, PlanBlockReadProps } from "../blockTypes";
import { InlineMarkdown } from "../inlineMarkdown";
import { type Tone, toneColor } from "../tones";

/**
 * `<Callout>`: a toned note whose body is the MDX prose between its tags. `title`
 * replaces the tone's generic label; `focus` marks the document's one box of emphasis
 * (`.plan-callout--focus`). Colours come from the shared palette (`tones.ts`).
 */

export type CalloutTone = "info" | "decision" | "risk" | "warning" | "success";

export interface CalloutData {
  tone?: CalloutTone;
  title?: string;
  focus?: boolean;
  /** Markdown body, rendered as MDX children. */
  body: string;
}

const calloutSchema = z.object({
  tone: z.enum(["info", "decision", "risk", "warning", "success"]).optional(),
  title: z.string().trim().max(120).optional(),
  focus: z.boolean().optional(),
  // `body` is the MDX prose *children*, not a prop, so it is absent from the
  // props the registry validates (mirrors `<Endpoint>`'s optional description).
  body: z.string().trim().max(10_000).optional(),
}) as unknown as z.ZodType<CalloutData>;

const calloutMdx: BlockMdxConfig<CalloutData> = {
  tag: "Callout",
  childrenField: "body",
  toAttrs: (data) => ({ tone: data.tone, title: data.title, focus: data.focus }),
  fromAttrs: (attrs, children) =>
    ({
      tone: attrs.string("tone") as CalloutTone | undefined,
      title: attrs.string("title"),
      focus: attrs.bool("focus"),
      body: children,
    }) as CalloutData,
};

const TONE: Record<CalloutTone, { icon: ComponentType<{ className?: string }>; label: string }> = {
  info: { icon: IconInfoCircle, label: "Note" },
  decision: { icon: IconBulb, label: "Decision" },
  risk: { icon: IconShieldExclamation, label: "Risk" },
  warning: { icon: IconAlertTriangle, label: "Warning" },
  success: { icon: IconCircleCheck, label: "Success" },
};

/** A focus callout's colour: the status tone's slot in the shared palette. */
const PALETTE: Record<CalloutTone, Tone> = {
  info: "info",
  decision: "accent",
  risk: "risk",
  warning: "warning",
  success: "success",
};

function CalloutRead({ data, blockId, children }: PlanBlockReadProps<CalloutData>) {
  const { icon: Icon, label } = TONE[data.tone ?? "info"];
  const body = children ?? <p>{data.body}</p>;
  const title = data.title ? <InlineMarkdown text={data.title} /> : label;
  const style = { "--plan-callout-tone": toneColor(PALETTE[data.tone ?? "info"]) } as CSSProperties;
  if (data.focus) {
    return (
      <aside
        data-plan-block-id={blockId}
        data-plan-block-type="callout"
        className="plan-callout--focus"
        style={style}
      >
        <div className="plan-callout-title">{title}</div>
        <div className="prose-plan plan-callout-body">{body}</div>
      </aside>
    );
  }
  return (
    <aside
      data-plan-block-id={blockId}
      data-plan-block-type="callout"
      className="plan-callout my-4"
      style={style}
    >
      <Icon className="plan-callout-icon" />
      <div className="min-w-0 flex-1">
        <div className="plan-callout-title">{title}</div>
        <div className="prose-plan plan-callout-body">{body}</div>
      </div>
    </aside>
  );
}

export const calloutBlock: PlanBlock<CalloutData> = {
  schema: calloutSchema,
  mdx: calloutMdx,
  Read: CalloutRead,
};
