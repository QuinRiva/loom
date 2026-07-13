import type { ServerUsageBreakdownGauge, ServerUsageBreakdownModel } from "@t3tools/contracts";
import {
  formatCostShare,
  formatTokenCount,
  formatUsd,
  isMeterlessProvider,
  sortUsageRows,
  toggleUsageSort,
  type UsageSort,
  usageProviderDisplayName,
  usageWindowTotals,
} from "@t3tools/client-runtime/usageDashboard";
import { useMemo, useState } from "react";

import { Badge } from "../ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";
import { SortableColumnHead } from "./SortableColumnHead";

type ModelColumn =
  | "model"
  | "inputTokens"
  | "cacheReadTokens"
  | "cacheWriteTokens"
  | "outputTokens"
  | "costUsd"
  | "costShare";

const COLUMN_VALUES: Record<ModelColumn, (row: ServerUsageBreakdownModel) => number | string> = {
  model: (row) => row.model,
  inputTokens: (row) => row.inputTokens,
  cacheReadTokens: (row) => row.cacheReadTokens,
  cacheWriteTokens: (row) => row.cacheWriteTokens,
  outputTokens: (row) => row.outputTokens,
  costUsd: (row) => row.costUsd,
  costShare: (row) => row.costShare,
};

const NUMERIC_COLUMNS: ReadonlyArray<{ column: ModelColumn; label: string }> = [
  { column: "inputTokens", label: "Input" },
  { column: "cacheReadTokens", label: "Cache read" },
  { column: "cacheWriteTokens", label: "Cache write" },
  { column: "outputTokens", label: "Output" },
  { column: "costUsd", label: "Cost" },
  { column: "costShare", label: "% of cost" },
];

/** Per-model token buckets × API-equivalent cost for the selected window (§1.3). */
export function ModelBreakdownTable({
  models,
  scope,
  gauges,
  emptyLabel,
}: {
  models: ReadonlyArray<ServerUsageBreakdownModel>;
  scope: string;
  gauges: ReadonlyArray<ServerUsageBreakdownGauge>;
  emptyLabel: string;
}) {
  const [sort, setSort] = useState<UsageSort<ModelColumn>>({
    column: "costUsd",
    direction: "desc",
  });
  const rows = useMemo(
    () => sortUsageRows(models, COLUMN_VALUES[sort.column], sort.direction),
    [models, sort],
  );
  const totals = useMemo(() => usageWindowTotals(models), [models]);
  const onSort = (column: ModelColumn) =>
    setSort((current) => toggleUsageSort(current, column, column === "model" ? "asc" : "desc"));

  if (models.length === 0) {
    return <div className="px-4 py-6 text-center text-xs text-muted-foreground">{emptyLabel}</div>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortableColumnHead label="Model" column="model" sort={sort} onSort={onSort} />
          {NUMERIC_COLUMNS.map(({ column, label }) => (
            <SortableColumnHead
              key={column}
              label={label}
              column={column}
              sort={sort}
              onSort={onSort}
              align="right"
            />
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={`${row.providerId}:${row.model}`}>
            <TableCell>
              <div className="flex items-center gap-1.5">
                <span className="font-medium">{row.model}</span>
                {scope === "all" && isMeterlessProvider(row.providerId, gauges) ? (
                  <Badge size="sm" variant="outline" className="text-muted-foreground">
                    not counted in any meter
                  </Badge>
                ) : null}
              </div>
              <div className="text-[11px] text-muted-foreground/70">
                {usageProviderDisplayName(row.providerId)}
              </div>
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatTokenCount(row.inputTokens)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatTokenCount(row.cacheReadTokens)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatTokenCount(row.cacheWriteTokens)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatTokenCount(row.outputTokens)}
            </TableCell>
            <TableCell className="text-right tabular-nums">{formatUsd(row.costUsd)}</TableCell>
            <TableCell className="text-right tabular-nums">
              {formatCostShare(row.costShare)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableHead className="h-9">Total</TableHead>
          <TableCell className="text-right tabular-nums">
            {formatTokenCount(totals.inputTokens)}
          </TableCell>
          <TableCell className="text-right tabular-nums">
            {formatTokenCount(totals.cacheReadTokens)}
          </TableCell>
          <TableCell className="text-right tabular-nums">
            {formatTokenCount(totals.cacheWriteTokens)}
          </TableCell>
          <TableCell className="text-right tabular-nums">
            {formatTokenCount(totals.outputTokens)}
          </TableCell>
          <TableCell className="text-right tabular-nums">{formatUsd(totals.costUsd)}</TableCell>
          <TableCell className="text-right tabular-nums">
            {totals.costUsd > 0 ? "100%" : "—"}
          </TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  );
}
