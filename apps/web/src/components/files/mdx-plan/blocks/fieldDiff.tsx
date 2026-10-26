import { z } from "zod";

import { cn } from "~/lib/utils";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../../../ui/tooltip";
import type { BlockMdxConfig, PlanBlock, PlanBlockReadProps } from "../blockTypes";

/**
 * `<FieldDiff>`: two labelled panels of the same record fields, so long values wrap
 * instead of scrolling. null vs absent is load-bearing on the wire: `null` renders
 * italic *null* (field exists), absent renders a dash (field does not apply).
 * `kept` fields render dimmed and are excluded from the changed count.
 */

export interface FieldDiffField {
  name: string;
  /** `null` = present with null value; omit = absent on this side. */
  before?: string | null;
  after?: string | null;
  kept?: boolean;
  note?: string;
}

export interface FieldDiffData {
  title?: string;
  beforeLabel?: string;
  afterLabel?: string;
  fields: FieldDiffField[];
}

const fieldDiffFieldSchema = z.object({
  name: z.string().trim().min(1).max(300),
  before: z.string().max(8000).nullable().optional(),
  after: z.string().max(8000).nullable().optional(),
  kept: z.boolean().optional(),
  note: z.string().trim().max(1000).optional(),
}) as z.ZodType<FieldDiffField>;

const fieldDiffSchema = z.object({
  title: z.string().trim().max(400).optional(),
  beforeLabel: z.string().trim().max(80).optional(),
  afterLabel: z.string().trim().max(80).optional(),
  fields: z.array(fieldDiffFieldSchema).min(1).max(40),
}) as unknown as z.ZodType<FieldDiffData>;

const fieldDiffMdx: BlockMdxConfig<FieldDiffData> = {
  tag: "FieldDiff",
  toAttrs: (data) => ({
    title: data.title,
    beforeLabel: data.beforeLabel,
    afterLabel: data.afterLabel,
    fields: data.fields,
  }),
  fromAttrs: (attrs) =>
    ({
      title: attrs.string("title"),
      beforeLabel: attrs.string("beforeLabel"),
      afterLabel: attrs.string("afterLabel"),
      fields: attrs.array<FieldDiffField>("fields") ?? [],
    }) as FieldDiffData,
};

/** Render one side's value: absent → dash, present-null → italic null,
 * else the wrapped string. */
function FieldValue({ value }: { value: string | null | undefined }) {
  if (value === undefined) return <span className="text-muted-foreground">-</span>;
  if (value === null) return <span className="italic text-muted-foreground">null</span>;
  return <span className="whitespace-pre-wrap break-words text-foreground">{value}</span>;
}

function FieldCell({
  field,
  value,
  note,
}: {
  field: FieldDiffField;
  value: string | null | undefined;
  note?: string | undefined;
}) {
  return (
    <>
      <div className="flex items-center gap-1.5 font-mono text-xs uppercase tracking-wide text-muted-foreground">
        <span className="min-w-0 break-words">{field.name}</span>
        {field.kept && (
          <span className="rounded bg-accent px-1 py-px text-2xs font-semibold normal-case text-muted-foreground">
            unchanged
          </span>
        )}
      </div>
      <div className="mt-0.5 text-xs">
        <FieldValue value={value} />
      </div>
      {note && <div className="mt-1 text-2xs italic text-muted-foreground">{note}</div>}
    </>
  );
}

export function FieldDiffRead({ data, blockId }: PlanBlockReadProps<FieldDiffData>) {
  const fields = data.fields ?? [];
  const changed = fields.filter((field) => !field.kept).length;
  const beforeLabel = data.beforeLabel ?? "Before";
  const afterLabel = data.afterLabel ?? "After";

  return (
    <figure
      data-plan-block-id={blockId}
      data-plan-block-type="field-diff"
      className="my-4 overflow-hidden rounded-lg border border-border bg-card"
    >
      <figcaption className="flex flex-wrap items-center gap-2 border-b border-border/60 bg-muted/40 px-3 py-1.5 text-2xs">
        <Tooltip>
          <TooltipTrigger
            render={<span className="min-w-0 flex-1 truncate font-mono text-foreground" />}
          >
            {data.title ?? "field diff"}
          </TooltipTrigger>
          <TooltipPopup>{data.title ?? "field diff"}</TooltipPopup>
        </Tooltip>
        <span className="shrink-0 rounded-full bg-accent px-2 py-0.5 font-medium text-muted-foreground">
          {changed} changed
        </span>
      </figcaption>
      {/* Panel-order DOM so a narrow column stacks two complete panels; at sm+ column
          flow over N+1 explicit rows keeps each field's cells in the same row. The
          per-field note rides the after cell: a full-width row cannot survive column flow. */}
      <div
        className="grid grid-cols-1 sm:grid-flow-col sm:grid-cols-2"
        style={{ gridTemplateRows: `repeat(${fields.length + 1}, auto)` }}
      >
        <div className="border-b border-border/60 bg-destructive/5 px-3 py-1.5 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
          {beforeLabel}
        </div>
        {fields.map((field) => (
          <div
            key={`before-${field.name}`}
            className={cn("bg-destructive/5 px-3 py-2", field.kept && "opacity-60")}
          >
            <FieldCell field={field} value={field.before} />
          </div>
        ))}
        <div className="border-b border-border/60 bg-success/5 px-3 py-1.5 text-2xs font-semibold uppercase tracking-wide text-muted-foreground max-sm:border-t">
          {afterLabel}
        </div>
        {fields.map((field) => (
          <div
            key={`after-${field.name}`}
            className={cn("bg-success/5 px-3 py-2", field.kept && "opacity-60")}
          >
            <FieldCell field={field} value={field.after} note={field.note} />
          </div>
        ))}
      </div>
    </figure>
  );
}

export const fieldDiffBlock: PlanBlock<FieldDiffData> = {
  schema: fieldDiffSchema,
  mdx: fieldDiffMdx,
  Read: FieldDiffRead,
};
