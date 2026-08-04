/**
 * loom: the goal's entry point on the chat header — `◎ <title> · N threads`.
 *
 * A goal is never navigated to directly; it is reached through a thread that
 * carries it. This chip is that reach: it appears only on threads that have a
 * goal, and toggles the Goal panel for that goal. No chip means no goal, which
 * is itself the signal.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { TargetIcon } from "lucide-react";
import { useMemo } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useGoalById } from "../goals/goalState";
import { cn } from "../lib/utils";
import { useThreadShells } from "../state/entities";
import { filterRootThreads } from "./useLoomSidebarGoals";

export function GoalChip({
  goalId,
  environmentId,
  panelOpen,
  onToggle,
}: {
  goalId: string | null;
  environmentId: EnvironmentId;
  panelOpen: boolean;
  onToggle: () => void;
}) {
  const goal = useGoalById(goalId);
  const allShells = useThreadShells();
  // Root threads only: children of a workstream belong to the goal through their
  // root, and counting them would inflate "N threads" past what the panel lists.
  const threadCount = useMemo(
    () =>
      goalId === null
        ? 0
        : filterRootThreads(
            allShells.filter(
              (thread) =>
                thread.environmentId === environmentId &&
                thread.goalId === goalId &&
                thread.archivedAt === null,
            ),
          ).length,
    [allShells, environmentId, goalId],
  );

  if (!goal) return null;
  const title = goal.title || goal.slug;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onToggle}
            aria-pressed={panelOpen}
            className={cn(
              "flex min-w-0 shrink items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs",
              panelOpen
                ? "border-primary/45 bg-primary/10 text-foreground"
                : "border-border/60 text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <TargetIcon className="size-3 shrink-0" />
            <span className="min-w-0 max-w-40 truncate">{title}</span>
            <span aria-hidden className="shrink-0 text-muted-foreground/50">
              &middot;
            </span>
            <span className="shrink-0 tabular-nums">
              {threadCount} thread{threadCount === 1 ? "" : "s"}
            </span>
          </button>
        }
      />
      <TooltipPopup side="bottom">
        {panelOpen ? "Hide the Goal panel" : `Goal \u00b7 ${title}`}
      </TooltipPopup>
    </Tooltip>
  );
}
