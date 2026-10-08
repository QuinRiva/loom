/**
 * loom: the sub-thread rollup badge on a root's sidebar row (3d-3) — the one
 * place a root's workstream graph shows in the list. The count is the plan
 * (settled / total); the colour is one summary tone (`workstreamBadgeTone`):
 * red failed or stuck, amber needs you, blue working, grey otherwise, and only
 * red and amber carry `· N!`. A click opens a popover (S2): the counts in words,
 * the flagged sub-threads, highest priority first, each opening its thread, and
 * "Open Workstream panel" for the whole graph.
 *
 * One rollup map per environment, rebuilt per shell update; each row selects
 * its root's entry and only re-renders when that entry's content changes.
 */
import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type WorkstreamBadgeTone,
  type WorkstreamRollup,
  workstreamBadgeTone,
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

/**
 * Whether a root has live sub-threads still unsettled — its row then reads
 * Waiting rather than an unread Done (the agent stopped with background work
 * that will wake it). A boolean atom, so a row re-renders only when it flips.
 */
const unsettledAtom = Atom.family((threadKey: string) =>
  Atom.make((get) => {
    const plan = get(rollupAtom(threadKey))?.plan;
    return plan !== undefined && plan.total > 0 && !plan.settled;
  }).pipe(Atom.withLabel(`loom-unsettled:${threadKey}`)),
);

export const useLoomSubThreadsUnsettled = (threadKey: string) =>
  useAtomValue(unsettledAtom(threadKey));

export function LoomRollupBadge({ threadKey }: { threadKey: string }) {
  const rollup = useAtomValue(rollupAtom(threadKey));
  const navigate = useNavigate();
  const ref = parseScopedThreadKey(threadKey);
  if (rollup === null || rollup.plan.total === 0 || ref === null) return null;
  // Opening a child, or this root with its Workstream panel.
  const go = (threadId: ThreadId, panel = false) => {
    const target = scopeThreadRef(ref.environmentId, threadId);
    if (panel) useRightPanelStore.getState().open(target, "workstream");
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(target) });
  };
  return (
    <LoomRollupPill
      rollup={rollup}
      dataKey={threadKey}
      onOpenThread={go}
      onOpenPanel={() => go(ref.threadId, true)}
    />
  );
}

const TONE_CLASS: Record<WorkstreamBadgeTone, string> = {
  failed: "border-error/40 text-error",
  needs_you: "border-warning/40 text-warning-foreground",
  working: "border-info/40 text-info",
  done: "border-border/70 text-muted-foreground",
  waiting: "border-border/70 text-muted-foreground",
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** The pill and its popover for one rollup; `LoomRollupBadge` wires it to a row. */
export function LoomRollupPill({
  rollup,
  dataKey,
  onOpenThread,
  onOpenPanel,
}: {
  rollup: WorkstreamRollup;
  dataKey: string;
  onOpenThread: (threadId: ThreadId) => void;
  onOpenPanel: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { plan, activity, attention } = rollup;
  const tone = workstreamBadgeTone(rollup);
  const settled = plan.columns.done + plan.columns.cancelled;
  // `!` means a human must act: non-zero exactly when the tone is red or amber.
  const flagged = attention.nodes.filter((node) => !node.withAgents).length;
  const summary = [
    plural(plan.total, "sub-thread"),
    `${settled} settled`,
    `${activity.active} running`,
    ...(plan.columns.blocked > 0 ? [`${plan.columns.blocked} blocked`] : []),
    ...(flagged > 0 ? [`${flagged} need${flagged === 1 ? "s" : ""} you`] : []),
    ...(plan.deadlocked ? ["deadlocked"] : []),
  ];
  const close = (action: () => void) => () => {
    action();
    setOpen(false);
  };
  return (
    // The row navigates on click and renames on double-click; nothing in here
    // (trigger or portalled popup, which bubbles through React) may reach it.
    <span className="contents" onClick={stop} onDoubleClick={stop} onContextMenu={stop}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          data-thread-selection-safe
          aria-label={summary.join(", ")}
          render={
            <button
              type="button"
              className={cn(
                "inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-full border px-1.5 font-mono text-3xs tabular-nums hover:bg-accent",
                TONE_CLASS[tone],
              )}
              data-loom-rollup={dataKey}
              data-loom-rollup-tone={tone}
            />
          }
        >
          <NetworkIcon className="size-3" aria-hidden />
          {settled}/{plan.total}
          {flagged > 0 ? <span>· {flagged}!</span> : null}
        </PopoverTrigger>
        <PopoverPopup
          side="top"
          align="end"
          width="sm"
          padding="compact"
          data-thread-selection-safe
        >
          <div className="pb-1.5 font-medium text-xs">{summary.join(" · ")}</div>
          {flagged === 0 && tone !== "failed" ? (
            <div className="pb-1.5 text-3xs text-muted-foreground">Nothing needs you.</div>
          ) : null}
          {attention.nodes.length > 0 ? (
            <ul className="-mx-1.5 max-h-64 overflow-y-auto">
              {attention.nodes.map((node) => (
                <li key={node.id}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-accent"
                    onClick={close(() => onOpenThread(node.id))}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-xs text-foreground">
                        {node.title || "Untitled sub-thread"}
                      </span>
                      <span
                        className={cn(
                          "text-3xs",
                          node.reason === "error"
                            ? "text-error"
                            : node.withAgents
                              ? "text-muted-foreground"
                              : "text-warning-foreground",
                        )}
                      >
                        {attentionLabel(node.reason)}
                        {node.withAgents ? " · its orchestrator is on it" : ""}
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
              onClick={close(onOpenPanel)}
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
