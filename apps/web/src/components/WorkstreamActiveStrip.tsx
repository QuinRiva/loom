import type { WorkstreamRollup } from "@t3tools/client-runtime/state/loom/rollup";
import type { ThreadId } from "@t3tools/contracts";

import {
  ATTENTION_COLORS,
  ATTENTION_LABELS,
  COLUMN_STYLES,
  formatRelativeAge,
  getActivity,
  getRoleLabel,
  isRunning,
  legibleHue,
  type WorkstreamNode,
} from "../lib/workstreamPresentation";
import { WorkstreamSpendSlot } from "../loom/WorkstreamSpendSlot";
import { Badge } from "./ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { WorkstreamModelPill } from "./WorkstreamModelPill";

/**
 * Active-now strip: one chip per descendant that is running (the activity
 * rollup) or flagged (the attention rollup) — the two read separately, never
 * fused into one state. Flagged threads sort first; one click enters the
 * thread. Renders nothing for an idle, unflagged workstream.
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
                      {formatRelativeAge(node.lastActivityAt)}
                    </span>
                  </span>
                  <span className="mt-1 flex gap-1.5 text-2xs leading-snug text-muted-foreground">
                    <span
                      className="mt-1 size-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                    <span className="line-clamp-2 min-w-0">
                      {reason ? `${ATTENTION_LABELS[reason]} · ` : ""}
                      {node.preview ? <i>› {node.preview}</i> : getActivity(node)}
                    </span>
                  </span>
                  <span className="mt-1.5 flex flex-wrap items-center gap-1.5 font-mono text-3xs text-muted-foreground">
                    <WorkstreamModelPill selection={node.modelSelection} />
                    <WorkstreamSpendSlot threadId={node.id} />
                    {node.toolCalls > 0 ? <span>⚒ {node.toolCalls}</span> : null}
                  </span>
                </span>
              </TooltipTrigger>
              <TooltipPopup>{`Open ${node.title} · ${getRoleLabel(node)}`}</TooltipPopup>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}
