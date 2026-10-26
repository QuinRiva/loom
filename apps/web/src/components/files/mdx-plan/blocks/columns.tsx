import { Children, type CSSProperties, isValidElement, type ReactNode } from "react";
import { z } from "zod";

import { cn } from "~/lib/utils";

import type { PlanBlock, PlanBlockReadProps } from "../blockTypes";

/**
 * `<Columns>`/`<Column>`: each column's blocks are MDX children (`passChildren`).
 * `<Columns>` is annotatable as one block while nested blocks keep their own ids. The
 * `<Column>` slot has no block type and must render in the container's subtree (never
 * portalled) so selections resolve to the nested block.
 */

export interface ColumnData {
  /** Optional column heading (BuilderIO's per-column `label`). */
  label?: string;
}

const columnSchema = z.object({
  label: z.string().max(200).optional(),
}) as unknown as z.ZodType<ColumnData>;

export function ColumnRead({ data, children }: PlanBlockReadProps<ColumnData>) {
  return (
    <div className="plan-column">
      {data.label ? <div className="plan-column-label">{data.label}</div> : null}
      <div className="prose-plan plan-column-body">{children as ReactNode}</div>
    </div>
  );
}

export const columnBlock: PlanBlock<ColumnData> = {
  schema: columnSchema,
  Read: ColumnRead,
  mdx: {
    tag: "Column",
    passChildren: true,
    toAttrs: (data) => ({ label: data.label }),
    fromAttrs: (attrs) => ({ label: attrs.string("label") }) as ColumnData,
  },
};

/** Children are `<Column>` slots or bare blocks; `columns` caps how many sit across.
 * Uncapped, the row balances: all across when they fit, else `ceil(n/2)` (four cards are
 * 2×2, never 3 + 1), else one; three go straight to one to avoid a 2 + 1 orphan. */
export interface ColumnsData {
  columns?: number;
}

const columnsSchema = z.object({
  columns: z.number().int().min(2).max(6).optional(),
}) as unknown as z.ZodType<ColumnsData>;

export function ColumnsRead({ data, blockId, children }: PlanBlockReadProps<ColumnsData>) {
  const count = Children.toArray(children as ReactNode).filter(isValidElement).length;
  return (
    <div
      data-plan-block-id={blockId}
      data-plan-block-type="columns"
      className={cn("plan-columns my-4", data.columns && "plan-columns--capped")}
      style={
        (data.columns
          ? { "--plan-columns": data.columns }
          : {
              "--plan-columns-n": count,
              "--plan-columns-half": count === 3 ? 1 : Math.ceil(count / 2),
            }) as unknown as CSSProperties
      }
    >
      {children as ReactNode}
    </div>
  );
}

export const columnsBlock: PlanBlock<ColumnsData> = {
  schema: columnsSchema,
  Read: ColumnsRead,
  mdx: {
    tag: "Columns",
    passChildren: true,
    toAttrs: (data) => ({ columns: data.columns }),
    fromAttrs: (attrs) => ({ columns: attrs.number("columns") }) as ColumnsData,
  },
};
