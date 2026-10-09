import type { WorkstreamRollup } from "@t3tools/client-runtime/state/loom/rollup";
import type { ThreadId } from "@t3tools/contracts";
import { useContext } from "react";

import {
  ATTENTION_COLORS,
  ATTENTION_LABELS,
  COLUMN_STYLES,
  formatRelativeAge,
  formatStepAge,
  getActivity,
  getRoleLabel,
  getStep,
  isRunning,
  legibleHue,
  type WorkstreamNode,
} from "../lib/workstreamPresentation";
import { useNowMinute } from "../hooks/useNowMinute";
import { formatCostUsd } from "../loom/costFormat";
import { useThreadSpend } from "../loom/threadSpend";
import { WorkstreamEnvironmentContext } from "../loom/WorkstreamSpendSlot";
import { Badge } from "./ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { WorkstreamModelPill } from "./WorkstreamModelPill";

/**
 * Active-now strip: one chip per descendant that is running (the activity
 * rollup) or flagged (the attention rollup) — the two read separately, never
 * fused into one state. Flagged threads sort first; one click enters the
 * thread. Renders nothing for an idle, unflagged workstream. Each row pairs a
 * sentence (left) with a figure (right): title / age, activity / current step,
 * model / cost and tool count. Ages tick on the shared minute clock.
 */
export function WorkstreamActiveStrip({
  nodes,
  rollup,
  onOpenThread,
}: {
  readonly nodes: ReadonlyArray<WorkstreamNode>;
  readonly rollup: WorkstreamRollup;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const now = Date.parse(`${useNowMinute()}:00Z`);
  const flagged = new Map(rollup.attention.nodes.map((entry) => [entry.id, entry.reason]));
  const inflight = nodes
    .filter((node) => flagged.has(node.id) || isRunning(node))
    .toSorted(
      (left, right) =>
        Number(flagged.has(right.id)) - Number(flagged.has(left.id)) ||
        right.lastActivityAt.localeCompare(left.lastActivityAt),
    );
  if (inflight.length === 0) return null;

  return (
    <div className="mb-3">
      <div className="mb-2 flex items-center gap-2 px-0.5 text-2xs font-semibold uppercase tracking-widest text-muted-foreground">
        Active now
        {rollup.activity.running > 0 ? (
          <Badge size="sm" variant="info">
            {rollup.activity.running} running
          </Badge>
        ) : null}
        {rollup.attention.count > 0 ? (
          <Badge size="sm" variant="warning">
            {rollup.attention.count} flagged
          </Badge>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {inflight.map((node) => {
          const reason = flagged.get(node.id);
          const color = reason ? ATTENTION_COLORS[reason] : COLUMN_STYLES[node.column].color;
          const step = getStep(node, now);
          const stepAge = step && formatStepAge(step.since, now);
          return (
            <Tooltip key={node.id}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={() => onOpenThread(node.id)}
                    className="flex min-w-[236px] max-w-[274px] items-start gap-2.5 rounded-lg border border-border bg-card px-2.5 py-2 text-left hover:bg-accent"
                    style={
                      reason
                        ? { borderColor: `color-mix(in srgb, ${color} 45%, transparent)` }
                        : undefined
                    }
                  />
                }
              >
                <span
                  className="grid size-[26px] shrink-0 place-items-center rounded-lg border font-mono text-4xs font-semibold uppercase"
                  style={{
                    color: legibleHue(color),
                    borderColor: `color-mix(in srgb, ${color} 50%, transparent)`,
                    backgroundColor: `color-mix(in srgb, ${color} 16%, transparent)`,
                  }}
                >
                  {getRoleLabel(node).slice(0, 3)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
                      {node.title}
                    </span>
                    <span className="shrink-0 text-3xs text-muted-foreground">
                      {formatRelativeAge(node.lastActivityAt, now)}
                    </span>
                  </span>
                  <span className="mt-1 flex gap-1.5 text-2xs leading-snug text-muted-foreground">
                    <span
                      className="mt-1 size-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {reason ? `${ATTENTION_LABELS[reason]} · ` : ""}
                      {node.preview ? <i>› {node.preview}</i> : getActivity(node)}
                    </span>
                    {step ? (
                      <span className="shrink-0">
                        {step.label}
                        {stepAge ? (
                          <>
                            {" · "}
                            <span
                              className={
                                step.long ? "font-semibold text-warning-foreground" : undefined
                              }
                            >
                              {stepAge}
                            </span>
                          </>
                        ) : null}
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-1.5 flex items-center gap-1.5 font-mono text-3xs whitespace-nowrap text-muted-foreground">
                    <WorkstreamModelPill selection={node.modelSelection} />
                    <CardStats threadId={node.id} toolCalls={node.toolCalls} />
                  </span>
                </span>
              </TooltipTrigger>
              <TooltipPopup>
                {`Open ${node.title} · ${getRoleLabel(node)}`}
                {step
                  ? ` · ${step.label} since ${new Date(step.since).toLocaleTimeString()}`
                  : null}
              </TooltipPopup>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}

/** The card's right-hand figures: lifetime cost and tool-call count, `$4.10 · ⚒ 212`. */
function CardStats({
  threadId,
  toolCalls,
}: {
  readonly threadId: ThreadId;
  readonly toolCalls: number;
}) {
  const cost = formatCostUsd(
    useThreadSpend(useContext(WorkstreamEnvironmentContext), threadId)?.costUsd,
  );
  const text = [cost, toolCalls > 0 ? `⚒ ${toolCalls}` : null].filter(Boolean).join(" · ");
  return text ? <span className="ml-auto shrink-0 tabular-nums">{text}</span> : null;
}
