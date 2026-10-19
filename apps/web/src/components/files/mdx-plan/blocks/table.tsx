import { ChevronDown, ChevronsUpDown, ChevronUp, Search } from "lucide-react";
import { useState } from "react";
import { z } from "zod";

import { cn } from "~/lib/utils";

import type { BlockMdxConfig, PlanBlock, PlanBlockReadProps } from "../blockTypes";
import { InlineMarkdown } from "../inlineMarkdown";
import { badgeSpecSchema, resolveBadge, toneSchema, type Tone } from "../tones";
import { PlanBadge } from "./badge";

/**
 * The `<Table>` block — a grid of header columns + rows for comparisons,
 * parameters, statuses or structured lists. `columns`/`rows`/`align` are JSON
 * attributes; `density` is dropped when "normal".
 *
 * A cell is inline markdown, or `{ md?, badge?, tone? }` to carry a pill (before
 * the text; a bare-string badge takes the cell's tone) and/or a tint. A row is a
 * cell array, or `{ tone?, cells }` to tint the whole row. Filter and sort read
 * {@link cellText}: the badge label then the markdown source.
 */

const TABLE_DENSITIES = ["compact", "normal", "relaxed"] as const;
export type TableDensity = (typeof TABLE_DENSITIES)[number];
const TABLE_ALIGNS = ["left", "center", "right"] as const;

const cellSchema = z.union([
  z.string(),
  z.object({
    md: z.string().optional(),
    badge: badgeSpecSchema.optional(),
    tone: toneSchema.optional(),
  }),
]);
const rowSchema = z.union([
  z.array(cellSchema),
  z.object({ tone: toneSchema.optional(), cells: z.array(cellSchema) }),
]);
const tableSchema = z.object({
  columns: z.array(z.string()),
  rows: z.array(rowSchema),
  align: z.array(z.enum(TABLE_ALIGNS)).optional(),
  density: z.enum(TABLE_DENSITIES).optional(),
  filterable: z.boolean().optional(),
});

export type TableCell = z.infer<typeof cellSchema>;
export type TableRow = z.infer<typeof rowSchema>;
export type TableData = z.infer<typeof tableSchema>;

export const tableMdx: BlockMdxConfig<TableData> = {
  tag: "Table",
  toAttrs: (data) => ({
    columns: data.columns,
    rows: data.rows,
    align: data.align,
    density: data.density && data.density !== "normal" ? data.density : undefined,
    filterable: data.filterable ? true : undefined,
  }),
  fromAttrs: (attrs) =>
    ({
      columns: attrs.array<string>("columns") ?? [],
      rows: attrs.array<TableRow>("rows") ?? [],
      align: attrs.array<(typeof TABLE_ALIGNS)[number]>("align"),
      density: parseDensity(attrs.string("density")),
      filterable: attrs.bool("filterable"),
    }) as TableData,
};

/** A row's cells and tint, whichever shape it was authored in. */
export const rowParts = (row: TableRow): { cells: TableCell[]; tone?: Tone | undefined } =>
  Array.isArray(row) ? { cells: row } : row;

/** The searchable/sortable text of a cell: badge label, then markdown source. */
export const cellText = (cell: TableCell): string =>
  typeof cell === "string"
    ? cell
    : [cell.badge && resolveBadge(cell.badge).label, cell.md].filter(Boolean).join(" ");

const softTone = (tone: Tone | undefined) =>
  tone ? { background: `var(--plan-tone-${tone}-soft)` } : undefined;

function CellContent({ cell }: { cell: TableCell }) {
  if (typeof cell === "string") return <InlineMarkdown text={cell} />;
  return (
    <>
      {cell.badge && <PlanBadge spec={cell.badge} hostTone={cell.tone ?? "neutral"} />}
      {cell.badge && cell.md ? " " : null}
      {cell.md && <InlineMarkdown text={cell.md} />}
    </>
  );
}

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

const JUSTIFY = { left: "", center: "justify-center", right: "justify-end" } as const;

const CELL_PAD: Record<TableDensity, string> = {
  compact: "px-3 py-1.5",
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

  const align = (index: number) => data.align?.[index];

  const parts = rows.map(rowParts);
  const needle = filterable ? query.trim().toLowerCase() : "";
  const filtered = needle
    ? parts.filter((row) => row.cells.some((cell) => cellText(cell).toLowerCase().includes(needle)))
    : parts;
  const sortText = (row: (typeof filtered)[number], col: number) => {
    const cell = row.cells[col];
    return cell === undefined ? "" : cellText(cell);
  };
  const visibleRows =
    filterable && sort
      ? filtered.toSorted(
          (a, b) =>
            (sort.dir === "asc" ? 1 : -1) *
            compareCells(sortText(a, sort.col), sortText(b, sort.col)),
        )
      : filtered;

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
          <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
            {visibleRows.length} of {rows.length}
          </span>
        </div>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          {columns.length > 0 && (
            <thead>
              <tr className="border-b border-border bg-muted text-left">
                {withKeys(columns, (column) => column).map(({ key, item: column }, index) => {
                  const active = sort?.col === index;
                  const headerClass = cn(
                    "font-mono font-semibold uppercase tracking-widest text-3xs text-muted-foreground",
                    pad,
                  );
                  if (!filterable) {
                    return (
                      <th key={key} className={headerClass} style={{ textAlign: align(index) }}>
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
                          JUSTIFY[align(index) ?? "left"],
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
            {withKeys(visibleRows, (row) => row.cells.map(cellText).join("\u241F")).map(
              ({ key: rowKey, item: row }) => (
                <tr
                  key={rowKey}
                  className="border-t border-border/60 align-top"
                  style={softTone(row.tone)}
                >
                  {withKeys(row.cells, cellText).map(({ key: cellKey, item: cell }, index) => (
                    <td
                      key={`${rowKey}\u241F${cellKey}`}
                      className={cn(
                        "text-foreground",
                        pad,
                        typeof cell === "object" && cell.badge && "whitespace-nowrap",
                      )}
                      style={{
                        textAlign: align(index),
                        ...softTone(typeof cell === "object" ? cell.tone : undefined),
                      }}
                    >
                      <CellContent cell={cell} />
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
