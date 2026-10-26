/**
 * loom: "Top threads by cost" on the Usage page's Cost tab, from Loom's usage ledger
 * (`loom.topSpend`), so it covers only turns Loom drove; the transcript scan above also counts pi
 * runs outside Loom and reads higher. Titles come with the rows: most costly threads are settled and
 * absent from the cold shell, and the route opens them by id.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, UsageSummaryInput } from "@t3tools/contracts";
import { formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import { useNavigate } from "@tanstack/react-router";

import { buildThreadRouteParams } from "../threadRoutes";
import { TOP_THREAD_COUNT, useTopSpend } from "./threadSpend";

/** The window's first instant: the hourly window's own, else local midnight of its first day. */
function windowSince(window: UsageSummaryInput): string {
  if (window.sinceTime !== undefined) return window.sinceTime;
  const [year = 0, month = 1, day = 1] = window.sinceDay.split("-").map(Number);
  return new Date(year, month - 1, day).toISOString();
}

export function TopThreadSpend({
  window,
  selectedEnvironmentIds,
}: {
  readonly window: UsageSummaryInput;
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
}) {
  const navigate = useNavigate();
  const { threads, isPending, failed } = useTopSpend(windowSince(window));
  // Selection narrows before the top-N cut.
  const rows = threads
    .filter(
      (row) => selectedEnvironmentIds === null || selectedEnvironmentIds.has(row.environmentId),
    )
    .slice(0, TOP_THREAD_COUNT);

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-foreground">Top threads by cost</h2>
      <table className="w-full table-fixed text-sm">
        <colgroup>
          <col className="w-2/5" />
          <col className="w-1/5" />
          <col className="w-1/5" />
          <col className="w-1/5" />
        </colgroup>
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="py-2 font-normal">Thread</th>
            <th className="py-2 text-right font-normal">Cost</th>
            <th className="py-2 text-right font-normal">Input · output</th>
            <th className="py-2 text-right font-normal">Cached</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={4} className="py-6 text-center text-muted-foreground">
                {failed
                  ? "The usage ledger could not be read."
                  : isPending
                    ? "Reading the usage ledger…"
                    : "No spend recorded in this window."}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr
                key={`${row.environmentId}:${row.threadId}`}
                className="border-b border-border/50 transition-colors hover:bg-muted/50"
              >
                <td className="min-w-0 py-2 text-foreground">
                  <button
                    type="button"
                    className="block w-full cursor-pointer truncate text-left hover:underline"
                    onClick={() =>
                      void navigate({
                        to: "/$environmentId/$threadId",
                        params: buildThreadRouteParams(
                          scopeThreadRef(row.environmentId, row.threadId),
                        ),
                      })
                    }
                  >
                    {row.title ?? row.threadId}
                  </button>
                </td>
                <td className="py-2 text-right text-foreground tabular-nums">
                  {formatUsd(row.costUsd)}
                </td>
                <td className="py-2 text-right text-muted-foreground tabular-nums">
                  {formatTokens(row.inputTokens)} · {formatTokens(row.outputTokens)}
                </td>
                <td className="py-2 text-right text-muted-foreground tabular-nums">
                  {formatTokens(row.cachedTokens)}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </section>
  );
}
