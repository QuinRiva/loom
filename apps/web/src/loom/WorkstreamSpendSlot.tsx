import type { EnvironmentId, LoomContextUsage, ThreadId } from "@t3tools/contracts";
import { formatTokens } from "@t3tools/shared/usageFormat";
import { createContext, useContext } from "react";

import { Badge } from "../components/ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { formatContextWindowTokens } from "../lib/contextWindow";
import { formatCostUsd } from "./costFormat";
import { useThreadSpend, useTotalSpend } from "./threadSpend";

/** The environment the workstream surfaces render (set once by the board and graph). */
export const WorkstreamEnvironmentContext = createContext<EnvironmentId | null>(null);

const NO_THREADS: ReadonlyArray<ThreadId> = [];

/**
 * The per-thread spend on the workstream board card, quick facts (`fact`) and
 * active strip (3d-4): the thread's lifetime cost from seam 11's usage ledger,
 * batched across every mounted slot (`loom/threadSpend.ts`). Given its
 * `subtree` (the thread and every descendant), a parent whose descendants spent
 * shows `own · subtree` as V1's card did. Renders nothing until answered, and
 * for a thread with no recorded spend.
 */
export function WorkstreamSpendSlot({
  threadId,
  subtree = NO_THREADS,
  fact = false,
}: {
  readonly threadId: ThreadId;
  readonly subtree?: ReadonlyArray<ThreadId>;
  readonly fact?: boolean;
}) {
  const environmentId = useContext(WorkstreamEnvironmentContext);
  const spend = useThreadSpend(environmentId, threadId);
  const subtreeTotal = useTotalSpend(environmentId, subtree);
  const cost = formatCostUsd(spend?.costUsd);
  const subtreeCost = subtreeTotal > (spend?.costUsd ?? 0) ? formatCostUsd(subtreeTotal) : null;
  if (fact)
    return spend && cost ? (
      <div className="flex items-baseline gap-2 text-xs">
        <dt className="w-[108px] shrink-0 whitespace-nowrap text-muted-foreground">Cost</dt>
        <dd className="min-w-0 flex-1 truncate text-foreground/80 tabular-nums">
          {cost} · {formatTokens(spend.inputTokens)} in · {formatTokens(spend.outputTokens)} out ·{" "}
          {formatTokens(spend.cachedTokens)} cached
        </dd>
      </div>
    ) : null;
  if (subtreeCost === null)
    return cost === null ? null : <span className="tabular-nums">{cost}</span>;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="tabular-nums" />}>
        own {cost ?? "—"} · subtree {subtreeCost}
      </TooltipTrigger>
      <TooltipPopup>This thread&rsquo;s own spend and its whole descendant subtree</TooltipPopup>
    </Tooltip>
  );
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
