import type { WorkstreamRollup } from "@t3tools/client-runtime/state/loom/rollup";
import { descendantsOf } from "@t3tools/shared/workstreamGraph";
import { forwardRef, useContext, useMemo } from "react";

import {
  ATTENTION_COLORS,
  ATTENTION_SHORT_LABELS,
  COLUMN_SHORT_LABELS,
  COLUMN_STYLES,
  formatCompactAge,
  formatRelativeAge,
  getGateWaitLabel,
  getPurpose,
  getStep,
  getVerdictChip,
  legibleHue,
  type WorkstreamNode,
  type WorkstreamNodeIndex,
} from "../lib/workstreamPresentation";
import { formatCostUsd } from "../loom/costFormat";
import { StepElapsed } from "../loom/StepElapsed";
import { useThreadSpend, useTotalSpend } from "../loom/threadSpend";
import { WorkstreamEnvironmentContext, WorkstreamSpendSlot } from "../loom/WorkstreamSpendSlot";
import { WorkstreamModelPill } from "./WorkstreamModelPill";

/**
 * Quick-facts hover card for a graph node: the glance before a click. Each fact
 * appears once, unlabelled: title and purpose; a status line (attention, plan
 * column or gate leg, age, tool count); the model; cost │ tokens; a parent's
 * subtree rollups. The footer is the current step with live seconds and its
 * command, or — when nothing runs — the last outcome. The graph positions it
 * imperatively via the ref.
 */
export const WorkstreamQuickFacts = forwardRef<
  HTMLDivElement,
  {
    readonly node: WorkstreamNode;
    readonly byId: WorkstreamNodeIndex;
    /** The node's descendant rollups, or null for a leaf. */
    readonly rollup: WorkstreamRollup | null;
  }
>(function WorkstreamQuickFacts({ node, byId, rollup }, ref) {
  const reason = node.reasons[0];
  const step = getStep(node);
  const lastOutcome = node.lastOutcome;
  const status = [
    getGateWaitLabel(node, byId)?.label ?? COLUMN_SHORT_LABELS[node.column].toLowerCase(),
    formatCompactAge(node.lastActivityAt),
    node.toolCalls > 0 ? `⚒ ${node.toolCalls}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div
      ref={ref}
      className="pointer-events-none absolute z-20 max-h-[40vh] w-[300px] overflow-hidden rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-lg"
    >
      <div className="text-sm font-semibold leading-snug text-foreground">{node.title}</div>
      <div className="mt-1 text-2xs leading-snug text-muted-foreground">{getPurpose(node)}</div>

      <div className="mt-2 flex flex-col gap-1">
        <div className="truncate text-xs text-foreground/80">
          <span
            style={{ color: reason ? ATTENTION_COLORS[reason] : COLUMN_STYLES[node.column].color }}
          >
            ●
          </span>{" "}
          {reason ? (
            <>
              <span
                className="font-semibold"
                style={{ color: legibleHue(ATTENTION_COLORS[reason]) }}
              >
                {ATTENTION_SHORT_LABELS[reason]}
              </span>
              {" · "}
            </>
          ) : null}
          {status}
        </div>
        <div className="flex">
          <WorkstreamModelPill selection={node.modelSelection} />
        </div>
        <WorkstreamSpendSlot threadId={node.id} fact />
        {rollup?.plan ? <SubtreeRow node={node} rollup={rollup} byId={byId} /> : null}
      </div>

      {step ? (
        <div className="mt-2.5 border-t border-border pt-2">
          <div className="text-xs font-semibold leading-snug text-foreground">
            {step.label} · <StepElapsed since={step.since} />
          </div>
          {step.detail ? (
            <div className="mt-1 line-clamp-2 break-all font-mono text-2xs leading-snug text-muted-foreground">
              {step.detail}
            </div>
          ) : null}
        </div>
      ) : lastOutcome ? (
        <div className="mt-2.5 border-t border-border pt-2">
          <div className="text-xs font-semibold leading-snug text-foreground">
            {[
              ...new Set([
                node.outcome,
                getVerdictChip(node)?.label ?? lastOutcome.outcome.replaceAll("_", " "),
              ]),
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
          <div className="mt-1 text-2xs text-muted-foreground">
            report submitted {formatRelativeAge(lastOutcome.at)}
          </div>
        </div>
      ) : null}
    </div>
  );
});

/**
 * A parent's subtree in one line under a dashed rule, most-read first: settled
 * of total, running, the subtree's spend (the node's own plus every
 * descendant's, archived included, once a descendant has spent anything), flags,
 * deadlock, blocked.
 */
function SubtreeRow({
  node,
  rollup,
  byId,
}: {
  readonly node: WorkstreamNode;
  readonly rollup: WorkstreamRollup;
  readonly byId: WorkstreamNodeIndex;
}) {
  const environmentId = useContext(WorkstreamEnvironmentContext);
  const descendantIds = useMemo(
    () => descendantsOf(node.id, [...byId.values()]).map((member) => member.id),
    [node.id, byId],
  );
  const own = useThreadSpend(environmentId, node.id)?.costUsd ?? 0;
  const descendants = useTotalSpend(environmentId, descendantIds);
  const { plan, activity, attention } = rollup;
  return (
    <div className="mt-1 truncate border-t border-dashed border-border pt-1.5 text-xs text-foreground/80">
      <span className="text-muted-foreground">sub-threads</span>{" "}
      {[
        `${plan.columns.done + plan.columns.cancelled}/${plan.total} settled`,
        activity.running > 0 ? `${activity.running} running` : null,
        descendants > 0 ? formatCostUsd(own + descendants) : null,
        attention.count > 0 ? `${attention.count} flagged` : null,
        plan.deadlocked ? "deadlocked" : null,
        plan.columns.blocked > 0 ? `${plan.columns.blocked} blocked` : null,
      ]
        .filter(Boolean)
        .join(" · ")}
    </div>
  );
}
