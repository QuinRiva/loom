import type { ScopedThreadRef } from "@t3tools/contracts";
import { childrenOf, descendantsOf, subtreeOf } from "@t3tools/shared/workstreamGraph";
import { useMemo } from "react";

import { formatCostUsd } from "./costFormat";
import { useSpendOf } from "./threadSpend";
import { useWorkstreamNodes } from "./workstreamState";

/**
 * The composer context meter's spend block: this thread's lifetime spend and,
 * for a thread with descendants (archived included), the subtree total plus
 * each direct child's branch total — so a root orchestrator shows its whole
 * workstream. Figures are the usage ledger's (`loom/threadSpend`), running
 * turns included. Rendered only inside the open popover, so a closed meter
 * subscribes to neither the shells nor the ledger.
 */
export function LoomContextSpend({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const { nodes } = useWorkstreamNodes(threadRef.environmentId);
  const { subtreeIds, branches } = useMemo(() => {
    const all = [...nodes.values()];
    return {
      subtreeIds: [threadRef.threadId, ...descendantsOf(threadRef.threadId, all).map((n) => n.id)],
      branches: childrenOf(threadRef.threadId, all).map((child) => ({
        id: child.id,
        title: child.title,
        ids: subtreeOf(child.id, all).map((n) => n.id),
      })),
    };
  }, [nodes, threadRef.threadId]);
  const descendantCount = subtreeIds.length - 1;
  const costOf = useSpendOf(threadRef.environmentId, subtreeIds);
  const own = costOf(threadRef.threadId);
  const subtree = subtreeIds.reduce((sum, id) => sum + costOf(id), 0);
  const children = branches
    .map((branch) => ({ ...branch, cost: branch.ids.reduce((sum, id) => sum + costOf(id), 0) }))
    .filter((branch) => branch.cost > 0)
    .toSorted((left, right) => right.cost - left.cost);
  const headline = formatCostUsd(descendantCount > 0 ? subtree : own);
  if (headline === null) return null;
  return (
    <div className="mt-1 flex flex-col gap-1 border-border/60 border-t pt-2">
      <div className="flex items-center justify-between gap-3">
        <div className="font-medium text-muted-foreground text-xs">Spend</div>
        <div className="text-secondary-label text-2xs tabular-nums">{headline}</div>
      </div>
      <SpendRow label="This thread" cost={formatCostUsd(own) ?? "$0.00"} />
      {descendantCount > 0 ? (
        <SpendRow
          label={`Subtree (${descendantCount} descendant${descendantCount === 1 ? "" : "s"})`}
          cost={headline}
        />
      ) : null}
      {children.length > 0 ? (
        // A wide workstream has dozens of branches: scroll them rather than grow
        // the popup past the viewport (clipping the Compact button).
        <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
          {children.map((child) => (
            <div
              key={child.id}
              className="flex items-center justify-between gap-3 text-2xs leading-4"
            >
              <span className="truncate text-secondary-label/70">{child.title}</span>
              <span className="shrink-0 tabular-nums text-secondary-label/70">
                {formatCostUsd(child.cost)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="mt-0.5 text-pretty text-secondary-label/70 text-2xs">
        Metered-equivalent; may not reflect subscription plans.
      </div>
    </div>
  );
}

function SpendRow({ label, cost }: { readonly label: string; readonly cost: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-2xs leading-4">
      <span className="text-secondary-label">{label}</span>
      <span className="font-medium tabular-nums text-secondary-label">{cost}</span>
    </div>
  );
}
