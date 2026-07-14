// loom: fork-added sidebar goal state + shared derivation helpers, hoisted out
// of the upstream-owned Sidebar.tsx. Goal-collapse lives at the sidebar root (one
// source for both the render and the Ctrl+N jump map); goal ids are globally
// unique.
import { useMemo } from "react";
import type { ProjectId } from "@t3tools/contracts";
import { useGoals } from "../goals/goalState";
import { useSidebarUiStore } from "./sidebarUiStore";
import type { GoalShell } from "../types";

/**
 * The list shows only root threads; workstream sub-threads (non-null
 * parentThreadId) stay hidden and surface through the orchestrator row's
 * WorkstreamGraphIndicator badge instead.
 */
/** Single fork bundle threaded through the upstream project-list plumbing levels. */
export interface SidebarLoomGoals {
  goals: ReadonlyArray<GoalShell>;
  collapsedGoalIds: ReadonlySet<string>;
  onToggleGoalCollapse: (goalId: string) => void;
}

export function filterRootThreads<T extends { parentThreadId: string | null }>(
  shells: readonly T[],
): T[] {
  return shells.filter((thread) => thread.parentThreadId === null);
}

/**
 * Non-archived goals whose project belongs to the (possibly grouped) logical
 * project. Duplicated at both the per-project item and the root jump-map, so it
 * lives here as one helper.
 */
export function goalsForProject<TGoal extends Pick<GoalShell, "projectId" | "archivedAt">>(
  goals: readonly TGoal[],
  memberProjects: readonly { id: ProjectId }[],
): TGoal[] {
  const projectIds = new Set(memberProjects.map((member) => member.id));
  return goals.filter((goal) => goal.archivedAt === null && projectIds.has(goal.projectId));
}

export function useLoomSidebarGoals(): {
  goals: ReadonlyArray<GoalShell>;
  collapsedGoalIds: ReadonlySet<string>;
  toggleGoalCollapse: (goalId: string) => void;
} {
  const goals = useGoals();
  const collapsedRecord = useSidebarUiStore((state) => state.collapsedGoalIds);
  const toggleGoalCollapse = useSidebarUiStore((state) => state.toggleGoalCollapse);
  // The consuming seam works with a Set; derive it (stable per record identity,
  // which only changes on toggle) so callers see the same durable choice.
  const collapsedGoalIds = useMemo<ReadonlySet<string>>(
    () => new Set(Object.keys(collapsedRecord)),
    [collapsedRecord],
  );
  return { goals, collapsedGoalIds, toggleGoalCollapse };
}
