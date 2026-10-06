/**
 * loom: the sub-thread rollup badge on a root's sidebar row (3d-3) — the one
 * place a root's workstream graph shows in the list. Three rollups, never
 * fused (client-runtime `workstreamRollupOf`): plan (settled / total), the
 * live activity count and the attention count with its highest reason. The
 * tooltip lists the flagged sub-threads, highest priority first.
 *
 * One rollup map per environment, rebuilt per shell update; each row selects
 * its root's entry and only re-renders when that entry's content changes.
 */
import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  type WorkstreamRollup,
  workstreamRollupOf,
} from "@t3tools/client-runtime/state/loom/rollup";
import { workstreamIndexOf } from "@t3tools/client-runtime/state/loom/workstream";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { NetworkIcon } from "lucide-react";
import { Atom } from "effect/reactivity";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import { environmentSnapshotAtom } from "../state/shell";
import { attentionLabel } from "./loomAttention";

const EMPTY_ROLLUPS: ReadonlyMap<ThreadId, WorkstreamRollup> = new Map();

const rollupsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const threads = get(environmentSnapshotAtom(environmentId))?.threads;
    if (!threads) return EMPTY_ROLLUPS;
    const byId = workstreamIndexOf(threads);
    const parents = new Set(threads.flatMap((thread) => thread.lineage.parentThreadId ?? []));
    return new Map(
      threads
        .filter((thread) => thread.lineage.parentThreadId === null && parents.has(thread.id))
        .map((root) => [root.id, workstreamRollupOf(root.id, threads, byId)] as const),
    );
  }).pipe(Atom.withLabel(`loom-rollups:${environmentId}`)),
);

const rollupAtom = Atom.family((threadKey: string) => {
  const ref = parseScopedThreadKey(threadKey);
  let previous: WorkstreamRollup | null = null;
  let previousKey = "null";
  return Atom.make((get) => {
    const rollup =
      ref === null ? null : (get(rollupsAtom(ref.environmentId)).get(ref.threadId) ?? null);
    const key = JSON.stringify(rollup);
    if (key !== previousKey) {
      previousKey = key;
      previous = rollup;
    }
    return previous;
  }).pipe(Atom.withLabel(`loom-rollup:${threadKey}`));
});

export function LoomRollupBadge({ threadKey }: { threadKey: string }) {
  const rollup = useAtomValue(rollupAtom(threadKey));
  if (rollup === null || rollup.plan.total === 0) return null;
  const { plan, activity, attention } = rollup;
  const settled = plan.columns.done + plan.columns.cancelled;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 font-mono text-3xs tabular-nums",
              attention.count > 0
                ? attention.highest === "error"
                  ? "border-error/40 text-error"
                  : "border-warning/40 text-warning-foreground"
                : "border-border/70 text-muted-foreground",
            )}
            data-loom-rollup={threadKey}
          />
        }
      >
        <NetworkIcon className="size-3" aria-hidden />
        {settled}/{plan.total}
        {attention.count > 0 ? <span>· {attention.count}!</span> : null}
      </TooltipTrigger>
      <TooltipPopup>
        <div className="space-y-0.5 text-xs">
          <div>
            {plan.total} sub-thread{plan.total === 1 ? "" : "s"} · {settled} settled ·{" "}
            {activity.running} running
            {plan.deadlocked ? " · deadlocked" : ""}
          </div>
          {attention.nodes.map((node) => (
            <div key={node.id}>
              {attentionLabel(node.reason)} — {node.title}
            </div>
          ))}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
