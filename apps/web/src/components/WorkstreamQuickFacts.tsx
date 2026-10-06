import type { WorkstreamRollup } from "@t3tools/client-runtime/state/loom/rollup";
import type { ThreadId } from "@t3tools/contracts";
import { forwardRef, type ReactNode } from "react";

import {
  ATTENTION_BADGE_VARIANTS,
  ATTENTION_LABELS,
  COLUMN_SHORT_LABELS,
  COLUMN_STYLES,
  formatRelativeAge,
  getActivity,
  getGateLoopCap,
  getGateWaitLabel,
  getPurpose,
  getRoleLabel,
  getVerdictChip,
  isGateSource,
  TONE_BADGE_VARIANTS,
  type WorkstreamNode,
  type WorkstreamNodeIndex,
} from "../lib/workstreamPresentation";
import { WorkstreamSpendSlot } from "../loom/WorkstreamSpendSlot";
import { Badge } from "./ui/badge";
import { WorkstreamModelPill } from "./WorkstreamModelPill";

/**
 * Quick-facts hover card for a graph node: the cheap glance before a click
 * (enter) or right-click (actions). The plan column, activity and attention
 * are separate rows; a node with descendants adds its three rollups, each its
 * own row — never fused. The graph positions it imperatively via the ref.
 */
export const WorkstreamQuickFacts = forwardRef<
  HTMLDivElement,
  {
    readonly node: WorkstreamNode;
    readonly byId: WorkstreamNodeIndex;
    /** The node's descendant rollups, or null for a leaf. */
    readonly rollup: WorkstreamRollup | null;
    readonly titleOf: (threadId: ThreadId) => string;
  }
>(function WorkstreamQuickFacts({ node, byId, rollup, titleOf }, ref) {
  const verdict = getVerdictChip(node);
  const gateWait = getGateWaitLabel(node, byId);
  const plan = rollup?.plan;
  return (
    <div
      ref={ref}
      className="pointer-events-none absolute z-20 max-h-[40vh] w-[300px] overflow-hidden rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-lg"
    >
      <div className="text-3xs uppercase tracking-widest text-muted-foreground">
        {getRoleLabel(node)}
      </div>
      <div className="mt-0.5 line-clamp-2 text-sm font-semibold leading-snug text-foreground">
        {node.title}
      </div>
      <div className="mt-1 text-2xs leading-snug text-muted-foreground">{getPurpose(node)}</div>

      <dl className="mt-2 flex flex-col gap-1">
        <FactRow label="Plan">
          <span className={COLUMN_STYLES[node.column].textClass}>
            ● {COLUMN_SHORT_LABELS[node.column]}
          </span>
        </FactRow>
        <FactRow label="Activity">{node.activity ?? "idle"}</FactRow>
        <FactRow label="Model">
          <WorkstreamModelPill selection={node.modelSelection} />
        </FactRow>
        <WorkstreamSpendSlot threadId={node.id} />
        {isGateSource(node) || node.gateRounds > 0 ? (
          <FactRow label="Gate rounds">
            ⟲ {node.gateRounds}/{getGateLoopCap(node)}
          </FactRow>
        ) : null}
        {node.forkFromThreadId ? (
          <FactRow label="Forked from">{titleOf(node.forkFromThreadId)}</FactRow>
        ) : null}
        {plan ? (
          <>
            <FactRow label="Subtree plan">
              {[
                `${plan.columns.done + plan.columns.cancelled}/${plan.total} settled`,
                plan.columns.blocked > 0 ? `${plan.columns.blocked} blocked` : null,
                plan.deadlocked ? "deadlocked" : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </FactRow>
            <FactRow label="Subtree activity">
              {rollup.activity.running} running · {rollup.activity.active} active
            </FactRow>
            <FactRow label="Subtree attention">
              {rollup.attention.highest
                ? `${rollup.attention.count} · ${ATTENTION_LABELS[rollup.attention.highest]}`
                : "none"}
            </FactRow>
          </>
        ) : null}
      </dl>

      <div className="mt-2 flex gap-1.5 border-t border-border pt-2 text-2xs leading-snug text-foreground/70">
        <span aria-hidden className="shrink-0 text-muted-foreground">
          ›
        </span>
        <span className="min-w-0">
          {node.preview ? <i>{node.preview}</i> : getActivity(node)}
          <span className="ml-1 text-muted-foreground">
            · {formatRelativeAge(node.lastActivityAt)}
          </span>
        </span>
      </div>

      {verdict || gateWait || node.reasons.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {verdict ? (
            <Badge size="sm" variant={TONE_BADGE_VARIANTS[verdict.tone]}>
              {verdict.label}
            </Badge>
          ) : null}
          {node.reasons.map((reason) => (
            <Badge key={reason} size="sm" variant={ATTENTION_BADGE_VARIANTS[reason]}>
              {ATTENTION_LABELS[reason]}
            </Badge>
          ))}
          {gateWait ? (
            <Badge size="sm" variant={gateWait.active ? "info" : "secondary"}>
              {gateWait.label}
            </Badge>
          ) : null}
        </div>
      ) : null}

      <div className="mt-2 text-2xs text-muted-foreground">
        click to enter · right-click for actions
      </div>
    </div>
  );
});

function FactRow({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 text-xs">
      <dt className="w-[108px] shrink-0 whitespace-nowrap text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 truncate text-foreground/80">{children}</dd>
    </div>
  );
}
