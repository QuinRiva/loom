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
import { filterRootThreads } from "./rootThreads";

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
              // Same width rule as the lineage cluster next door, for the same
              // reason: upstream's project/title breadcrumb is `flex-1 basis-0`
              // and only gets what loom's chips leave. See
              // ThreadLineageBreadcrumb for the full note.
              "hidden min-w-0 max-w-[calc(50%-15rem)] shrink items-center gap-1.5 overflow-clip rounded-md border px-2 py-0.5 text-xs @2xl/header-actions:flex",
              panelOpen
                ? "border-primary/45 bg-primary/10 text-foreground"
                : "border-border/60 text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <TargetIcon className="size-3 shrink-0" />
            <span className="min-w-0 max-w-40 truncate">{title}</span>
            {/* The count is decoration and the title is the information, but
                the count is `shrink-0` and would otherwise squeeze the title to
                nothing. It drops out below the header width at which the cap
                above stops squeezing this chip at all (~64rem). */}
            <span
              aria-hidden
              className="hidden shrink-0 text-muted-foreground/50 @5xl/header-actions:block"
            >
              &middot;
            </span>
            <span className="hidden shrink-0 tabular-nums @5xl/header-actions:block">
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
