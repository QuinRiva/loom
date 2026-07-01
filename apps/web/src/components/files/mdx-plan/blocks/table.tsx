import { z } from "zod";

import { cn } from "~/lib/utils";

import type { BlockMdxConfig, PlanBlock, PlanBlockReadProps } from "../blockTypes";

/**
 * The `<Table>` block — a simple grid of header columns + string rows for
 * comparisons, parameters, or structured lists. Schema + MDX round-trip ported
 * verbatim from `@agent-native/core` `table.config.ts` (`columns`/`rows` are
 * JSON attributes; `density` is dropped when "normal").
 */

export const TABLE_DENSITIES = ["compact", "normal", "relaxed"] as const;
export type TableDensity = (typeof TABLE_DENSITIES)[number];

export interface TableData {
  columns: string[];
  rows: string[][];
  density?: TableDensity;
}

export const tableSchema = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.array(z.string())),
  density: z.enum(TABLE_DENSITIES).optional(),
}) as unknown as z.ZodType<TableData>;

export const tableMdx: BlockMdxConfig<TableData> = {
  tag: "Table",
  toAttrs: (data) => ({
    columns: data.columns,
    rows: data.rows,
    density: data.density && data.density !== "normal" ? data.density : undefined,
  }),
  fromAttrs: (attrs) =>
    ({
      columns: attrs.array<string>("columns") ?? [],
      rows: attrs.array<string[]>("rows") ?? [],
      density: parseDensity(attrs.string("density")),
    }) as TableData,
};

function parseDensity(value: string | undefined): TableDensity | undefined {
  return value && TABLE_DENSITIES.includes(value as TableDensity)
    ? (value as TableDensity)
    : undefined;
}

/** Stable, collision-free React keys from content (rows/cells carry no id): the
 * value itself, with an occurrence suffix for duplicates — never the array index. */
function withKeys<T>(items: T[], keyOf: (item: T) => string): { key: string; item: T }[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = keyOf(item);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { key: n === 0 ? base : `${base}#${n}`, item };
  });
}

const CELL_PAD: Record<TableDensity, string> = {
  compact: "px-2.5 py-1",
  normal: "px-3 py-2",
  relaxed: "px-4 py-3",
};

export function TableRead({ data, blockId }: PlanBlockReadProps<TableData>) {
  const columns = data.columns ?? [];
  const rows = data.rows ?? [];
  const pad = CELL_PAD[data.density ?? "normal"];
  return (
    <div
      data-plan-block-id={blockId}
      data-plan-block-type="table"
      className="my-4 overflow-x-auto rounded-xl border border-border bg-card"
    >
      <table className="w-full border-collapse text-sm">
        {columns.length > 0 && (
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left">
              {withKeys(columns, (column) => column).map(({ key, item: column }) => (
                <th
                  key={key}
                  className={cn(
                    "font-semibold uppercase tracking-wide text-[11px] text-muted-foreground",
                    pad,
                  )}
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {withKeys(rows, (row) => row.join("\u241F")).map(({ key: rowKey, item: row }) => (
            <tr key={rowKey} className="border-t border-border/60 align-top">
              {withKeys(row, (cell) => cell).map(({ key: cellKey, item: cell }) => (
                <td key={`${rowKey}\u241F${cellKey}`} className={cn("text-foreground", pad)}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const tableBlock: PlanBlock<TableData> = {
  schema: tableSchema,
  mdx: tableMdx,
  Read: TableRead,
};
