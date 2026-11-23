/**
 * loom: a root row's goal task count (done/total over the whole nested tree), beside the sub-thread
 * rollup; a click opens the thread on its Tasks panel. Counts come only from the shell snapshot's
 * goals, one map per environment, so a row never fetches; a goal missing from it shows no pill.
 */
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, GoalId, LoomGoalShell } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ListChecksIcon } from "lucide-react";
import { Atom } from "effect/reactivity";
import type { SyntheticEvent } from "react";

import { cn } from "../lib/utils";
import { useRightPanelStore } from "../rightPanelStore";
import { environmentSnapshotAtom } from "../state/shell";
import { buildThreadRouteParams } from "../threadRoutes";
import type { SidebarThreadSummary } from "../types";
import { countGoalTasks } from "@t3tools/client-runtime/state/loom/goalTasks";

type GoalTaskCount = ReturnType<typeof countGoalTasks>;

const goalCountsAtom = Atom.family((environmentId: EnvironmentId) => {
  let goals: ReadonlyArray<LoomGoalShell> | undefined;
  let counts: ReadonlyMap<GoalId, GoalTaskCount> = new Map();
  return Atom.make((get) => {
    const next = get(environmentSnapshotAtom(environmentId))?.goals;
    if (next !== goals) {
      goals = next;
      counts = new Map((next ?? []).map((goal) => [goal.id, countGoalTasks(goal.tasks)]));
    }
    return counts;
  }).pipe(Atom.withLabel(`loom-goal-counts:${environmentId}`));
});

/** Key: `[environmentId, goalId]` JSON. Holds its value until the goal's two numbers change. */
const goalCountAtom = Atom.family((key: string) => {
  const [environmentId, goalId] = JSON.parse(key) as [EnvironmentId, GoalId];
  let previous: GoalTaskCount | null = null;
  return Atom.make((get) => {
    const count = get(goalCountsAtom(environmentId)).get(goalId);
    if (count === undefined || count.total === 0) previous = null;
    else if (count.done !== previous?.done || count.total !== previous.total) previous = count;
    return previous;
  }).pipe(Atom.withLabel(`loom-goal-count:${key}`));
});

const NO_COUNT_ATOM = Atom.make<GoalTaskCount | null>(null).pipe(
  Atom.withLabel("loom-goal-count:none"),
);

export function LoomGoalCountBadge({ thread }: { thread: SidebarThreadSummary }) {
  const goalId =
    thread.lineage.parentThreadId === null ? thread.source.workstream?.goalId : undefined;
  const count = useAtomValue(
    goalId == null ? NO_COUNT_ATOM : goalCountAtom(JSON.stringify([thread.environmentId, goalId])),
  );
  const navigate = useNavigate();
  if (count === null) return null;
  const complete = count.done === count.total;
  const open = (event: SyntheticEvent) => {
    event.stopPropagation();
    const target = scopeThreadRef(thread.environmentId, thread.id);
    useRightPanelStore.getState().open(target, "tasks");
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(target) });
  };
  return (
    // The row navigates on click and renames on double-click; neither may fire from here.
    <button
      type="button"
      data-thread-selection-safe
      data-loom-goal-count={complete ? "complete" : "open"}
      aria-label={`Open tasks, ${count.done} of ${count.total} done`}
      className={cn(
        "inline-flex h-4 shrink-0 cursor-pointer items-center gap-0.5 rounded-full border px-1 font-mono text-xs tabular-nums hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring",
        complete
          ? "border-success/50 text-success-foreground"
          : "border-muted-foreground/40 text-secondary-label",
      )}
      onClick={open}
      onDoubleClick={stop}
      onContextMenu={stop}
    >
      <ListChecksIcon className="size-3" aria-hidden />
      {count.done}/{count.total}
    </button>
  );
}

const stop = (event: SyntheticEvent) => event.stopPropagation();
