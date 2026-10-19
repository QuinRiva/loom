import { Children, type CSSProperties, isValidElement, type ReactNode } from "react";
import { z } from "zod";

import { cn } from "~/lib/utils";

import type { PlanBlock, PlanBlockReadProps } from "../blockTypes";

/**
 * The `<Columns>` / `<Column>` container blocks (Wave B6) — a side-by-side layout
 * (the common case is a Before/After or current/target pair). Ported from
 * BuilderIO's `columns` schema (`columns: [{ id, label?, blocks: [] }]`), but
 * expressed MDX-natively: instead of a `blocks` data array dispatched through a
 * block renderer, each column's blocks are ordinary MDX *children* already
 * resolved to React nodes by the evaluate path. So a container just renders its
 * `children` (`passChildren`) — no custom dispatcher.
 *
 * ANNOTATION. `<Columns>` is one block (own `data-plan-block-id`), annotatable as
 * a unit. Its nested blocks keep their own `data-plan-block-type`, so
 * `assignBlockIds` (which recurses, Wave A2) stamps each a distinct id and
 * `enclosingBlock`/`sectionFor` resolve a selection to the *nested* block plus
 * the document-level section — never the container, never the first match. The
 * `<Column>` slot is a structural wrapper (no block type), so children render
 * inside the container's own subtree (A2's constraint: never portal them out).
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

/** Direct children are `<Column>` slots or bare blocks (a row of `<Card>`s needs
 * no wrappers); `columns` caps how many sit across — the grid still collapses
 * on a narrow panel. Uncapped, the row balances: all `n` across when they fit,
 * else `ceil(n/2)` across (four cards are 2×2, never 3 + 1), else one — and
 * three go straight to one, since 2 + 1 is the orphan this avoids. */
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
