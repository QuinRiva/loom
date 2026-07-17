import { ChevronDown, ChevronsUpDown, ChevronUp, Search } from "lucide-react";
import { useMemo, useState } from "react";
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
  filterable?: boolean;
}

export const tableSchema = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.array(z.string())),
  density: z.enum(TABLE_DENSITIES).optional(),
  filterable: z.boolean().optional(),
}) as unknown as z.ZodType<TableData>;

export const tableMdx: BlockMdxConfig<TableData> = {
  tag: "Table",
  toAttrs: (data) => ({
    columns: data.columns,
    rows: data.rows,
    density: data.density && data.density !== "normal" ? data.density : undefined,
    filterable: data.filterable ? true : undefined,
  }),
  fromAttrs: (attrs) =>
    ({
      columns: attrs.array<string>("columns") ?? [],
      rows: attrs.array<string[]>("rows") ?? [],
      density: parseDensity(attrs.string("density")),
      filterable: attrs.bool("filterable"),
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

type SortDir = "asc" | "desc";
interface SortState {
  col: number;
  dir: SortDir;
}

/** Compare two cells with a numeric-aware fallback: when both parse cleanly as
 * numbers, compare numerically; otherwise a locale compare with `numeric` so
 * embedded numbers still sort naturally ("row 2" before "row 10"). */
function compareCells(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (a.trim() !== "" && b.trim() !== "" && !Number.isNaN(na) && !Number.isNaN(nb)) {
    return na - nb;
  }
  return a.localeCompare(b, undefined, { numeric: true });
}

export function TableRead({ data, blockId }: PlanBlockReadProps<TableData>) {
  const columns = data.columns ?? [];
  const rows = data.rows ?? [];
  const pad = CELL_PAD[data.density ?? "normal"];
  const filterable = data.filterable ?? false;
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState | null>(null);

  const filtered = useMemo(() => {
    if (!filterable) return rows;
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => row.some((cell) => cell.toLowerCase().includes(needle)));
  }, [rows, query, filterable]);

  const visibleRows = useMemo(() => {
    if (!filterable || !sort) return filtered;
    const factor = sort.dir === "asc" ? 1 : -1;
    return [...filtered].sort(
      (a, b) => factor * compareCells(a[sort.col] ?? "", b[sort.col] ?? ""),
    );
  }, [filtered, sort, filterable]);

  // Header-click sort cycles asc → desc → unsorted for the clicked column.
  const toggleSort = (col: number) =>
    setSort((current) =>
      current?.col !== col
        ? { col, dir: "asc" }
        : current.dir === "asc"
          ? { col, dir: "desc" }
          : null,
    );

  return (
    <div
      data-plan-block-id={blockId}
      data-plan-block-type="table"
      className="my-4 overflow-hidden rounded-xl border border-border bg-card"
    >
      {filterable ? (
        <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter rows…"
            aria-label="Filter table rows"
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:italic placeholder:text-muted-foreground focus:outline-none"
          />
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {visibleRows.length} of {rows.length}
          </span>
        </div>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          {columns.length > 0 && (
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left">
                {withKeys(columns, (column) => column).map(({ key, item: column }, index) => {
                  const active = sort?.col === index;
                  const headerClass = cn(
                    "font-semibold uppercase tracking-wide text-[11px] text-muted-foreground",
                    pad,
                  );
                  if (!filterable) {
                    return (
                      <th key={key} className={headerClass}>
                        {column}
                      </th>
                    );
                  }
                  return (
                    <th key={key} className={cn(headerClass, "p-0")}>
                      <button
                        type="button"
                        aria-label={`Sort by ${column}`}
                        onClick={() => toggleSort(index)}
                        className={cn(
                          "flex w-full items-center gap-1 text-left uppercase",
                          pad,
                          active ? "text-foreground" : "hover:text-foreground",
                        )}
                      >
                        <span className="min-w-0">{column}</span>
                        {active ? (
                          sort?.dir === "asc" ? (
                            <ChevronUp className="size-3 shrink-0" />
                          ) : (
                            <ChevronDown className="size-3 shrink-0" />
                          )
                        ) : (
                          <ChevronsUpDown className="size-3 shrink-0 opacity-40" />
                        )}
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
          )}
          <tbody>
            {withKeys(visibleRows, (row) => row.join("\u241F")).map(
              ({ key: rowKey, item: row }) => (
                <tr key={rowKey} className="border-t border-border/60 align-top">
                  {withKeys(row, (cell) => cell).map(({ key: cellKey, item: cell }) => (
                    <td key={`${rowKey}\u241F${cellKey}`} className={cn("text-foreground", pad)}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export const tableBlock: PlanBlock<TableData> = {
  schema: tableSchema,
  mdx: tableMdx,
  Read: TableRead,
};
