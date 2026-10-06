import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { formatTokens } from "@t3tools/shared/usageFormat";
import { createContext, useContext } from "react";

import { formatContextWindowTokens } from "../lib/contextWindow";
import { useThreadProjection } from "../state/entities";
import { formatCostUsd } from "./costFormat";
import { useThreadSpend } from "./threadSpend";

/** The environment the workstream surfaces render (set once by the board and graph). */
export const WorkstreamEnvironmentContext = createContext<EnvironmentId | null>(null);

/**
 * The per-thread spend on the workstream board card, quick facts (`fact`) and
 * active strip (3d-4): the thread's lifetime cost from seam 11's usage ledger,
 * batched across every mounted slot (`loom/threadSpend.ts`). Renders nothing
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
  if (!spend || cost === null) return null;
  return fact ? (
    <div className="flex items-baseline gap-2 text-xs">
      <dt className="w-[108px] shrink-0 whitespace-nowrap text-muted-foreground">Cost</dt>
      <dd className="min-w-0 flex-1 truncate text-foreground/80 tabular-nums">
        {cost} · {formatTokens(spend.inputTokens)} in · {formatTokens(spend.outputTokens)} out ·{" "}
        {formatTokens(spend.cachedTokens)} cached
      </dd>
    </div>
  ) : (
    <span className="tabular-nums">{cost}</span>
  );
}

/**
 * A thread's context-window chip from its active provider thread's
 * `contextUsage` (tokens used / window). It reads the thread's projection, so
 * it lives only in single-thread views (the timeline drawer), never on every
 * board card — a card per child would open a detail stream per child.
 */
export function LoomContextChip({ threadId }: { readonly threadId: ThreadId }) {
  const environmentId = useContext(WorkstreamEnvironmentContext);
  const projection = useThreadProjection(
    environmentId === null ? null : scopeThreadRef(environmentId, threadId),
  )?.projection;
  const usage = projection?.providerThreads.find(
    (thread) => thread.id === projection.thread.activeProviderThreadId,
  )?.contextUsage;
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
