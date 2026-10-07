/**
 * loom: the sub-thread rollup badge on a root's sidebar row (3d-3) — the one
 * place a root's workstream graph shows in the list. Three rollups, never
 * fused (client-runtime `workstreamRollupOf`): plan (settled / total), the
 * live activity count and the attention count with its highest reason. A click
 * opens a popover (S2): the flagged sub-threads, highest priority first, each
 * opening its thread, and "Open Workstream panel" for the whole graph.
 *
 * One rollup map per environment, rebuilt per shell update; each row selects
 * its root's entry and only re-renders when that entry's content changes.
 */
import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type WorkstreamRollup,
  workstreamRollupOf,
} from "@t3tools/client-runtime/state/loom/rollup";
import { workstreamIndexOf } from "@t3tools/client-runtime/state/loom/workstream";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, NetworkIcon } from "lucide-react";
import { Atom } from "effect/reactivity";
import { type SyntheticEvent, useState } from "react";

import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { cn } from "../lib/utils";
import { useRightPanelStore } from "../rightPanelStore";
import { buildThreadRouteParams } from "../threadRoutes";
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
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = parseScopedThreadKey(threadKey);
  if (rollup === null || rollup.plan.total === 0 || ref === null) return null;
  const { plan, activity, attention } = rollup;
  const settled = plan.columns.done + plan.columns.cancelled;
  // Opening a child, or this root with its Workstream panel, closes the popover.
  const go = (threadId: ThreadId, panel = false) => {
    const target = scopeThreadRef(ref.environmentId, threadId);
    if (panel) useRightPanelStore.getState().open(target, "workstream");
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(target) });
    setOpen(false);
  };
  return (
    // The row navigates on click and renames on double-click; nothing in here
    // (trigger or portalled popup, which bubbles through React) may reach it.
    <span className="contents" onClick={stop} onDoubleClick={stop} onContextMenu={stop}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          data-thread-selection-safe
          aria-label={`${plan.total} sub-threads${attention.count > 0 ? `, ${attention.count} need attention` : ""}`}
          render={
            <button
              type="button"
              className={cn(
                "inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-full border px-1.5 font-mono text-3xs tabular-nums hover:bg-accent",
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
        </PopoverTrigger>
        <PopoverPopup
          side="top"
          align="end"
          width="sm"
          padding="compact"
          data-thread-selection-safe
        >
          <div className="pb-1.5 font-medium text-xs">
            {plan.total} sub-thread{plan.total === 1 ? "" : "s"} · {settled} settled ·{" "}
            {activity.running} running
            {plan.deadlocked ? " · deadlocked" : ""}
          </div>
          {attention.nodes.length > 0 ? (
            <ul className="-mx-1.5 max-h-64 overflow-y-auto">
              {attention.nodes.map((node) => (
                <li key={node.id}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-accent"
                    onClick={() => go(node.id)}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-xs text-foreground">
                        {node.title || "Untitled sub-thread"}
                      </span>
                      <span
                        className={cn(
                          "text-3xs",
                          node.reason === "error" ? "text-error" : "text-warning-foreground",
                        )}
                      >
                        {attentionLabel(node.reason)}
                      </span>
                    </span>
                    <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="-mx-1.5 mt-1 border-border/60 border-t pt-1">
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-muted-foreground text-xs hover:bg-accent hover:text-foreground"
              onClick={() => go(ref.threadId, true)}
            >
              <span className="flex-1">Open Workstream panel</span>
              <ChevronRightIcon className="size-3 shrink-0" />
            </button>
          </div>
        </PopoverPopup>
      </Popover>
    </span>
  );
}

const stop = (event: SyntheticEvent) => event.stopPropagation();
