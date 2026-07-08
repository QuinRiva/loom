// loom: fork-added goal-grouped thread rendering, hoisted out of the
// upstream-owned Sidebar.tsx. Rows are opaque render-prop nodes (the ~25-prop
// SidebarThreadRow closure stays upstream-side in SidebarProjectThreadList), so
// upstream row-prop changes never touch this file. Goal context-menu handling is
// owned here via useLoomSidebarGoalActions.
import * as React from "react";
import { useMemo } from "react";
import { ChevronRightIcon, SquarePenIcon } from "lucide-react";
import type { GoalId, ProjectId } from "@t3tools/contracts";
import { SidebarMenuSub, SidebarMenuSubItem } from "../components/ui/sidebar";
import type { GraphRollup } from "../lib/workstreamRollup";
import { SIDEBAR_ICON_ACTION_BUTTON_CLASS } from "../components/Sidebar";
import {
  isCompactSingleThreadGoal,
  type SidebarOrderedEntry,
} from "../components/Sidebar.logic.loom";
import { countGoalTasks } from "../goals/goalState";
import type { GoalShell, SidebarThreadSummary } from "../types";
import type { SidebarProjectGroupMember } from "../sidebarProjectGrouping";
import { useLoomSidebarGoalActions } from "./sidebarGoalActions";

export interface SidebarGoalThreadListProps {
  orderedEntries: readonly SidebarOrderedEntry<SidebarThreadSummary>[];
  projectGoals: readonly GoalShell[];
  /** Environment resolution for the goal context menu / new-session action. */
  memberProjects: readonly SidebarProjectGroupMember[];
  /** UNFILTERED shells (still carry hidden children) for delete-confirm counts. */
  allProjectThreads: readonly SidebarThreadSummary[];
  collapsedGoalIds: ReadonlySet<string>;
  onToggleGoalCollapse: (goalId: string) => void;
  onNewGoalSession: (goalId: GoalId, goalProjectId: ProjectId) => void;
  /** Row rendering stays entirely upstream-side; a row is an opaque node here. */
  renderThreadRow: (
    thread: SidebarThreadSummary,
    options?: { keyOverride?: string; goalNewSessionAction?: React.ReactNode },
  ) => React.ReactNode;
}

/**
 * The single fork prop threaded down each upstream plumbing level
 * (SidebarProjectItem → SidebarProjectThreadList): everything the goal list
 * needs except the row render prop, plus the per-thread graph rollups the
 * upstream-side renderThreadRow closure looks up.
 */
export type SidebarGoalListBundle = Omit<SidebarGoalThreadListProps, "renderThreadRow"> & {
  graphRollupByThreadKey: ReadonlyMap<string, GraphRollup>;
};

export const SidebarGoalThreadList = React.memo(function SidebarGoalThreadList(
  props: SidebarGoalThreadListProps,
) {
  const {
    orderedEntries,
    projectGoals,
    memberProjects,
    allProjectThreads,
    collapsedGoalIds,
    onToggleGoalCollapse,
    onNewGoalSession,
    renderThreadRow,
  } = props;
  const { handleGoalContextMenu } = useLoomSidebarGoalActions({
    memberProjects,
    allProjectThreads,
  });
  const goalById = useMemo(
    () => new Map(projectGoals.map((goal) => [goal.id, goal] as const)),
    [projectGoals],
  );
  const knownGoalIds = useMemo(() => new Set(projectGoals.map((goal) => goal.id)), [projectGoals]);

  const renderGoalNewSessionButton = (goal: {
    id: GoalId;
    projectId: ProjectId;
    title: string;
  }) => (
    <button
      type="button"
      aria-label={`New session under ${goal.title}`}
      title="New session under this goal"
      className={SIDEBAR_ICON_ACTION_BUTTON_CLASS}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onNewGoalSession(goal.id, goal.projectId);
      }}
    >
      <SquarePenIcon className="size-3.5" />
    </button>
  );

  return (
    <>
      {orderedEntries.map((entry) => {
        if (entry.kind === "thread") {
          return renderThreadRow(entry.thread);
        }
        const goalMeta = goalById.get(entry.goalId as GoalShell["id"]);
        const goal = {
          id: entry.goalId as GoalId,
          projectId: goalMeta?.projectId ?? projectGoals[0]?.projectId ?? ("" as ProjectId),
          title: goalMeta ? goalMeta.title || goalMeta.slug : `Missing goal: ${entry.goalId}`,
          progress: goalMeta ? countGoalTasks(goalMeta.tasks) : { done: 0, total: 0 },
          known: goalMeta !== undefined,
        };
        // A known goal with exactly one thread renders compact: the thread row
        // stands in for the goal, keeping the "new session under this goal"
        // affordance so spawning a second thread expands it into the grouped view.
        if (isCompactSingleThreadGoal(entry, knownGoalIds)) {
          return renderThreadRow(entry.threads[0]!, {
            keyOverride: `goal:${goal.id}`,
            goalNewSessionAction: renderGoalNewSessionButton(goal),
          });
        }
        const goalExpanded = !collapsedGoalIds.has(goal.id);
        return (
          <SidebarMenuSubItem key={`goal:${goal.id}`} className="w-full" data-thread-selection-safe>
            <div className="group/goal-header relative flex w-full items-center">
              <button
                type="button"
                data-thread-selection-safe
                className="flex h-6 w-full translate-x-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-left text-[10px] text-muted-foreground/80 hover:bg-accent hover:text-foreground"
                title={goal.title}
                aria-expanded={goalExpanded}
                onClick={() => onToggleGoalCollapse(goal.id)}
                onContextMenu={
                  goal.known
                    ? (event) => {
                        event.preventDefault();
                        void handleGoalContextMenu(
                          { id: goal.id, projectId: goal.projectId, title: goal.title },
                          { x: event.clientX, y: event.clientY },
                        );
                      }
                    : undefined
                }
              >
                <ChevronRightIcon
                  className={`size-3 text-muted-foreground/60 transition-transform ${
                    goalExpanded ? "rotate-90" : ""
                  }`}
                />
                <span className="min-w-0 flex-1 truncate font-medium">{goal.title}</span>
                {goal.progress.total > 0 ? (
                  <span className="shrink-0 tabular-nums text-muted-foreground/55">
                    {goal.progress.done}/{goal.progress.total}
                  </span>
                ) : null}
              </button>
              {goal.known ? (
                <div className="pointer-events-none absolute top-1/2 right-0.5 -translate-y-1/2 opacity-0 transition-opacity duration-150 max-sm:pointer-events-auto max-sm:opacity-100 group-hover/goal-header:pointer-events-auto group-hover/goal-header:opacity-100 group-focus-within/goal-header:pointer-events-auto group-focus-within/goal-header:opacity-100">
                  {renderGoalNewSessionButton(goal)}
                </div>
              ) : null}
            </div>
            {goalExpanded ? (
              <SidebarMenuSub className="mx-0 ml-3 gap-0.5 overflow-hidden px-0 py-0">
                {entry.threads.map((thread) => renderThreadRow(thread))}
              </SidebarMenuSub>
            ) : null}
          </SidebarMenuSubItem>
        );
      })}
    </>
  );
});
