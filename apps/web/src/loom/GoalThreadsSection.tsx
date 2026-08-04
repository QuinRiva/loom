/**
 * loom: the Goal panel's Threads section — the goal's root threads in serial
 * handoff order, and the surface that replaces sidebar goal-nesting.
 *
 * Only ROOT threads appear: workstream children belong to the WorkstreamPanel,
 * and showing them here would rebuild the nesting the design retired. State
 * chips derive from the same helpers the sidebar rows use (`resolveSidebarV2Status`,
 * `effectiveSettled`, `isStagedHandoffThread`) rather than a second state model.
 */
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { effectiveSettled } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";

import { resolveSidebarV2Status } from "../components/Sidebar.logic";
import { isStagedHandoffThread } from "../components/Sidebar.logic.loom";
import { useClientSettings } from "../hooks/useSettings";
import { useNowMinute } from "../hooks/useNowMinute";
import { cn } from "../lib/utils";
import { buildGraphRollupByThreadKey } from "../lib/workstreamRollup";
import { formatCompactAge, getLastActivityAt } from "../lib/workstreamPresentation";
import { useThreadShells } from "../state/entities";
import { buildThreadRouteParams } from "../threadRoutes";
import type { SidebarThreadSummary } from "../types";
import { orderGoalThreadsByHandoff } from "./goalThreadChain";
import { filterRootThreads } from "./useLoomSidebarGoals";

interface ChipStyle {
  readonly label: string;
  readonly dot: string;
}

/**
 * One chip per row, in precedence order: what a human must act on outranks what
 * a machine is doing, which outranks where the thread rests.
 */
function resolveChipStyle(thread: SidebarThreadSummary, settled: boolean): ChipStyle {
  switch (resolveSidebarV2Status(thread)) {
    case "attention":
      return { label: "needs you", dot: "bg-amber-400" };
    case "approval":
      return { label: "approval", dot: "bg-amber-400" };
    case "input":
      return { label: "input", dot: "bg-amber-400" };
    case "working":
      return { label: "working", dot: "bg-blue-400" };
    case "failed":
      return { label: "failed", dot: "bg-red-400" };
    case "ready":
      break;
  }
  if (isStagedHandoffThread(thread)) return { label: "staged", dot: "bg-violet-400" };
  if (thread.planLane === "done" || thread.planLane === "cancelled") {
    return { label: thread.planLane, dot: "bg-emerald-400" };
  }
  return settled
    ? { label: "settled", dot: "bg-zinc-500" }
    : { label: "ready", dot: "bg-zinc-500" };
}

export function GoalThreadsSection({
  goalId,
  environmentId,
  activeThreadId,
  onCreateSession,
}: {
  goalId: string;
  environmentId: EnvironmentId;
  activeThreadId: ThreadId | null;
  onCreateSession: () => void;
}) {
  const navigate = useNavigate();
  const allShells = useThreadShells();
  const autoSettleAfterDays = useClientSettings((settings) => settings.sidebarAutoSettleAfterDays);
  // Minute-quantised so settled classification doesn't churn the list on every
  // render; auto-settle thresholds are day-granular anyway.
  const nowMinute = useNowMinute();

  const rows = useMemo(() => {
    const environmentThreads = allShells.filter(
      (thread) => thread.environmentId === environmentId && thread.archivedAt === null,
    );
    const rollups = buildGraphRollupByThreadKey(environmentThreads);
    const now = `${nowMinute}:00.000Z`;
    return orderGoalThreadsByHandoff(
      filterRootThreads(environmentThreads.filter((thread) => thread.goalId === goalId)),
    ).map(({ thread, isContinuation }) => {
      const rollup = rollups.get(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)));
      const settled = effectiveSettled(thread, {
        now,
        autoSettleAfterDays,
        workstream: {
          hasNonTerminalDescendant: rollup !== undefined && rollup.total > rollup.breakdown.done,
        },
      });
      return { thread, isContinuation, settled, chip: resolveChipStyle(thread, settled) };
    });
  }, [allShells, autoSettleAfterDays, environmentId, goalId, nowMinute]);

  return (
    <section className="mt-4">
      <div className="mb-1.5 flex items-baseline gap-2">
        <h3 className="text-[10px] font-medium tracking-wider text-muted-foreground/70 uppercase">
          Threads
        </h3>
        <span className="rounded-full border border-border/60 px-1.5 text-[10px] tabular-nums text-muted-foreground/70">
          {rows.length}
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground/60">handoff order</span>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground/70">No threads under this goal yet.</p>
      ) : (
        <ul className="space-y-0.5">
          {rows.map(({ thread, isContinuation, settled, chip }) => {
            const isCurrent = thread.id === activeThreadId;
            return (
              <li key={thread.id}>
                <button
                  type="button"
                  title={thread.title}
                  onClick={() =>
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: buildThreadRouteParams(
                        scopeThreadRef(thread.environmentId, thread.id),
                      ),
                    })
                  }
                  className={cn(
                    "flex w-full flex-col gap-0.5 rounded-md border border-transparent px-2 py-1.5 text-left hover:bg-accent",
                    isContinuation && "ml-2 w-[calc(100%-0.5rem)] border-l-border/70",
                    isCurrent && "border-primary/40 bg-accent/60",
                    // Settled is not archived: dimmed, never disabled.
                    settled && !isCurrent && "opacity-60 hover:opacity-100",
                  )}
                >
                  <span className="truncate text-xs text-foreground/90">{thread.title}</span>
                  <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground/70">
                    <span className="inline-flex items-center gap-1 rounded-full border border-border/60 px-1.5">
                      <span className={cn("size-1.5 rounded-full", chip.dot)} />
                      {chip.label}
                    </span>
                    <span>{formatCompactAge(getLastActivityAt(thread))}</span>
                    {isCurrent ? <span className="ml-auto text-primary/80">current</span> : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <button
        type="button"
        onClick={onCreateSession}
        className="mt-2 w-full rounded-md border border-border/70 px-2 py-1.5 text-xs text-foreground/80 hover:bg-accent"
      >
        + New session under this goal
      </button>
    </section>
  );
}
