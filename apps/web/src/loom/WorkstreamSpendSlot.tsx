import type { EnvironmentId, LoomContextUsage, ThreadId } from "@t3tools/contracts";
import { formatTokens } from "@t3tools/shared/usageFormat";
import { createContext, useContext } from "react";

import { Badge } from "../components/ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { formatContextWindowTokens } from "../lib/contextWindow";
import { formatCostUsd } from "./costFormat";
import { useThreadSpend, useTotalSpend } from "./threadSpend";

/** The environment the workstream surface renders (set once by the panel). */
export const WorkstreamEnvironmentContext = createContext<EnvironmentId | null>(null);

/**
 * A thread's lifetime cost from seam 11's usage ledger, batched across every
 * mounted slot (`loom/threadSpend.ts`): a quick-facts row (`fact`), or the
 * inline figure on the active strip and timeline header (3d-4). Includes a
 * running turn's live cost (`LoomUsageLedger.threadSpend`). Renders nothing
 * until answered, and for a thread with no recorded spend.
 */
export function WorkstreamSpendSlot({
  threadId,
  fact = false,
}: {
  readonly threadId: ThreadId;
  readonly fact?: boolean;
}) {
  const spend = useThreadSpend(useContext(WorkstreamEnvironmentContext), threadId);
  const cost = formatCostUsd(spend?.costUsd);
  if (!fact) return cost === null ? null : <span className="tabular-nums">{cost}</span>;
  return spend && cost ? (
    <div className="flex items-baseline gap-2 text-xs">
      <dt className="w-[108px] shrink-0 whitespace-nowrap text-muted-foreground">Cost</dt>
      <dd className="min-w-0 flex-1 truncate text-foreground/80 tabular-nums">
        {cost}
        {/* A running turn's live cost arrives before its tokens are ledgered. */}
        {spend.inputTokens + spend.outputTokens + spend.cachedTokens > 0
          ? ` · ${formatTokens(spend.inputTokens)} in · ${formatTokens(spend.outputTokens)} out · ${formatTokens(spend.cachedTokens)} cached`
          : null}
      </dd>
    </div>
  ) : null;
}

/** The workstream's total spend — its root and every descendant — for the surface headers. */
export function WorkstreamTotalSpend({
  threadIds,
}: {
  readonly threadIds: ReadonlyArray<ThreadId>;
}) {
  const cost = formatCostUsd(useTotalSpend(useContext(WorkstreamEnvironmentContext), threadIds));
  return cost === null ? null : (
    <Tooltip>
      <TooltipTrigger render={<Badge size="sm" variant="outline" />}>
        Workstream {cost}
      </TooltipTrigger>
      <TooltipPopup>Total spend of this workstream: its root and every descendant</TooltipPopup>
    </Tooltip>
  );
}

/** A thread's context window: tokens used of the window, and the share used. */
export function LoomContextChip({ usage }: { readonly usage: LoomContextUsage | null }) {
  if (!usage) return null;
  const max = usage.maxTokens ?? null;
  const percent = max ? Math.min(100, Math.round((usage.usedTokens / max) * 100)) : null;
  return (
    <span
      className={`tabular-nums ${percent !== null && percent > 50 ? "text-destructive-foreground" : ""}`}
    >
      context {formatContextWindowTokens(usage.usedTokens)}
      {max ? ` / ${formatContextWindowTokens(max)}` : ""}
      {percent !== null ? ` · ${percent}%` : ""}
    </span>
  );
}
