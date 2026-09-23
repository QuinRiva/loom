/**
 * loom: "Top threads by cost" on the Usage page's Cost tab.
 *
 * The retired loom dashboard's one surface upstream never replaced: the Usage
 * page knows what a window cost per model and per hour, but not which piece of
 * work spent it. Rows come from the usage ledger (see `state/threadSpend`), so
 * they answer for turns loom itself drove — the scanner's numbers above include
 * pi runs outside loom and will read higher.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, UsageSummaryInput } from "@t3tools/contracts";
import { formatCount, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import { useNavigate } from "@tanstack/react-router";

import { useThreadSpend } from "~/state/threadSpend";
import { buildThreadRouteParams } from "~/threadRoutes";

export function TopThreadSpend({
  window,
  selectedEnvironmentIds,
}: {
  readonly window: UsageSummaryInput;
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
}) {
  const navigate = useNavigate();
  const { threads, isPending, failed } = useThreadSpend(window, selectedEnvironmentIds);

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
            <th className="py-2 text-right font-normal">Tokens</th>
            <th className="py-2 text-right font-normal">Turns</th>
          </tr>
        </thead>
        <tbody>
          {threads.length === 0 ? (
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
            threads.map((thread) => (
              <tr
                key={`${thread.environmentId}:${thread.threadId}`}
                className="border-b border-border/50 transition-colors hover:bg-muted/50"
              >
                <td className="min-w-0 py-2 text-foreground">
                  {thread.title === null ? (
                    // The thread is gone: its id is all that is left to say.
                    <span className="block truncate font-mono text-xs text-muted-foreground">
                      {thread.threadId}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="block w-full cursor-pointer truncate text-left hover:underline"
                      onClick={() =>
                        void navigate({
                          to: "/$environmentId/$threadId",
                          params: buildThreadRouteParams(
                            scopeThreadRef(thread.environmentId, thread.threadId),
                          ),
                        })
                      }
                    >
                      {thread.title}
                    </button>
                  )}
                </td>
                <td className="py-2 text-right text-foreground tabular-nums">
                  {formatUsd(thread.costUsd)}
                </td>
                <td className="py-2 text-right text-muted-foreground tabular-nums">
                  {formatTokens(thread.totalTokens)}
                </td>
                <td className="py-2 text-right text-muted-foreground tabular-nums">
                  {formatCount(thread.turns)}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </section>
  );
}
