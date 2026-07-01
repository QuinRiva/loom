import { IconCheck, IconSquare } from "@tabler/icons-react";
import { z } from "zod";

import { cn } from "~/lib/utils";

import type { BlockMdxConfig, PlanBlock, PlanBlockReadProps } from "../blockTypes";

/**
 * The `<Checklist>` block — a static list of toggleable items, each a label and
 * an optional note, rendered READ-ONLY (the checkbox reflects the authored
 * `checked` state; it is not interactive in the plan render). Schema + MDX
 * round-trip ported verbatim from `@agent-native/core` `checklist.config.ts`.
 */

export interface ChecklistItem {
  id: string;
  label: string;
  checked?: boolean;
  note?: string;
}

export interface ChecklistData {
  items: ChecklistItem[];
}

const checklistItemSchema = z.object({
  id: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(400),
  checked: z.boolean().optional(),
  note: z.string().trim().max(800).optional(),
}) as z.ZodType<ChecklistItem>;

export const checklistSchema = z.object({
  items: z.array(checklistItemSchema).max(200),
}) as unknown as z.ZodType<ChecklistData>;

export const checklistMdx: BlockMdxConfig<ChecklistData> = {
  tag: "Checklist",
  toAttrs: (data) => ({ items: data.items }),
  fromAttrs: (attrs) => ({
    items: (attrs.array<ChecklistItem>("items") ?? []) as ChecklistItem[],
  }),
};

export function ChecklistRead({ data, blockId }: PlanBlockReadProps<ChecklistData>) {
  const items = data.items ?? [];
  return (
    <ul
      data-plan-block-id={blockId}
      data-plan-block-type="checklist"
      className="my-4 flex flex-col gap-1.5 rounded-xl border border-border bg-card p-3"
    >
      {items.map((item) => (
        <li key={item.id} className="flex items-start gap-2.5">
          <span
            className={cn(
              "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border",
              item.checked
                ? "border-emerald-500 bg-emerald-500 text-white dark:bg-emerald-500/80"
                : "border-muted-foreground/40 text-transparent",
            )}
          >
            {item.checked ? <IconCheck className="size-3" /> : <IconSquare className="size-0" />}
          </span>
          <span className="min-w-0 text-sm">
            <span
              className={cn(
                "text-foreground",
                item.checked && "text-muted-foreground line-through",
              )}
            >
              {item.label}
            </span>
            {item.note && (
              <span className="mt-0.5 block text-[11px] text-muted-foreground">{item.note}</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

export const checklistBlock: PlanBlock<ChecklistData> = {
  schema: checklistSchema,
  mdx: checklistMdx,
  Read: ChecklistRead,
};
