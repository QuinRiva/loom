// loom: fork-added goal context-menu + create/assign-goal handlers, hoisted out
// of the upstream-owned Sidebar.tsx. The thread-context-menu goal actions
// (create goal from thread / assign to goal) are consumed by SidebarProjectItem;
// the goal-header context menu (rename/archive/delete) is consumed by
// SidebarGoalThreadList.
import { useCallback } from "react";
import {
  type ContextMenuItem,
  type EnvironmentId,
  GoalId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useAtomCommand } from "../state/use-atom-command";
import { goalEnvironment } from "../state/threads";
import { readLocalApi } from "../localApi";
import { newGoalId } from "../lib/utils";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import type { GoalShell, SidebarThreadSummary } from "../types";
import type { SidebarProjectGroupMember } from "../sidebarProjectGrouping";

type UpdateThreadMetadata = (value: {
  environmentId: EnvironmentId;
  input: { threadId: ThreadId; goalId: GoalId | null };
}) => Promise<unknown>;

/**
 * Goal-related entries for a thread's context menu: "Create goal from thread"
 * plus the "Assign to goal" submenu (project-scoped goals + a "Clear goal" entry
 * when already attached). Empty submenu ⇒ no "Assign to goal" item.
 */
export function buildGoalMenuItems(
  projectGoals: readonly GoalShell[],
  thread: Pick<SidebarThreadSummary, "projectId" | "goalId">,
): ContextMenuItem<string>[] {
  // Goals are project-scoped: only offer assignment to goals in this thread's
  // project, plus a "Clear goal" entry when the thread is already attached.
  const assignGoalItems: ContextMenuItem<string>[] = projectGoals
    .filter((goal) => goal.projectId === thread.projectId)
    .map((goal) => ({ id: `assign-goal:${goal.id}`, label: goal.title || goal.slug }));
  if (thread.goalId) {
    assignGoalItems.push({ id: "assign-goal:", label: "Clear goal" });
  }
  return [
    { id: "create-goal", label: "Create goal from thread" },
    ...(assignGoalItems.length > 0
      ? [{ id: "assign-goal", label: "Assign to goal", children: assignGoalItems }]
      : []),
  ];
}

export function useLoomThreadGoalActions(): {
  runThreadGoalMenuAction: (
    clicked: string | null | undefined,
    deps: {
      thread: Pick<SidebarThreadSummary, "id" | "environmentId" | "projectId" | "title">;
      updateThreadMetadata: UpdateThreadMetadata;
    },
  ) => Promise<boolean>;
} {
  const createGoal = useAtomCommand(goalEnvironment.create, { reportFailure: false });

  const runThreadGoalMenuAction = useCallback(
    async (
      clicked: string | null | undefined,
      deps: {
        thread: Pick<SidebarThreadSummary, "id" | "environmentId" | "projectId" | "title">;
        updateThreadMetadata: UpdateThreadMetadata;
      },
    ): Promise<boolean> => {
      const { thread, updateThreadMetadata } = deps;
      if (clicked === "create-goal") {
        const title = window.prompt("Goal title", thread.title)?.trim();
        if (!title) return true;
        const slug = window
          .prompt(
            "Goal slug",
            title
              .toLowerCase()
              .replace(/[^a-z0-9._-]+/g, "-")
              .replace(/^-+|-+$/g, ""),
          )
          ?.trim();
        if (!slug) return true;
        const description = window.prompt("Goal paragraph", title)?.trim() || title;
        const goalId = newGoalId();
        const createResult = await createGoal({
          environmentId: thread.environmentId,
          input: { goalId, projectId: thread.projectId, slug, title, description },
        });
        if (createResult._tag === "Failure" && !isAtomCommandInterrupted(createResult)) {
          const error = squashAtomCommandFailure(createResult);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to create goal",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
          return true;
        }
        await updateThreadMetadata({
          environmentId: thread.environmentId,
          input: { threadId: thread.id, goalId },
        });
        return true;
      }
      if (clicked?.startsWith("assign-goal:")) {
        const rawGoalId = clicked.slice("assign-goal:".length);
        await updateThreadMetadata({
          environmentId: thread.environmentId,
          input: { threadId: thread.id, goalId: rawGoalId ? GoalId.make(rawGoalId) : null },
        });
        return true;
      }
      return false;
    },
    [createGoal],
  );

  return { runThreadGoalMenuAction };
}

export function useLoomSidebarGoalActions(deps: {
  memberProjects: readonly SidebarProjectGroupMember[];
  allProjectThreads: readonly SidebarThreadSummary[];
}): {
  handleGoalContextMenu: (
    goal: { id: GoalId; projectId: ProjectId; title: string },
    position: { x: number; y: number },
  ) => Promise<void>;
} {
  const { memberProjects, allProjectThreads } = deps;
  const updateGoalMeta = useAtomCommand(goalEnvironment.updateMeta, { reportFailure: false });
  const archiveGoal = useAtomCommand(goalEnvironment.archive, { reportFailure: false });
  const deleteGoal = useAtomCommand(goalEnvironment.delete, { reportFailure: false });

  const handleGoalContextMenu = useCallback(
    async (
      goal: { id: GoalId; projectId: ProjectId; title: string },
      position: { x: number; y: number },
    ) => {
      const api = readLocalApi();
      if (!api) return;
      const member =
        memberProjects.find((candidate) => candidate.id === goal.projectId) ?? memberProjects[0];
      if (!member) return;
      const environmentId = member.environmentId;
      const clicked = await api.contextMenu.show(
        [
          { id: "rename", label: "Rename goal" },
          { id: "archive", label: "Archive goal" },
          { id: "delete", label: "Delete goal", destructive: true, icon: "trash" },
        ],
        position,
      );
      if (clicked === "rename") {
        const title = window.prompt("Goal title", goal.title)?.trim();
        if (!title || title === goal.title) return;
        await updateGoalMeta({ environmentId, input: { goalId: goal.id, title } });
        return;
      }
      if (clicked === "archive") {
        await archiveGoal({ environmentId, input: { goalId: goal.id } });
        return;
      }
      if (clicked !== "delete") return;
      // The decider cascade-deletes every thread attached to the goal, including
      // workstream child threads (non-null parent) that the roots-only sidebar
      // list omits — so count from the full unfiltered shells to avoid
      // understating the blast radius in this destructive confirm.
      const goalThreadCount = allProjectThreads.filter(
        (thread) => thread.goalId === goal.id,
      ).length;
      const confirmed = await api.dialogs.confirm(
        [
          `Delete goal "${goal.title}"?`,
          goalThreadCount > 0
            ? `This permanently deletes the goal and its ${goalThreadCount} thread${
                goalThreadCount === 1 ? "" : "s"
              }, clearing their conversation history.`
            : "This permanently deletes the goal.",
        ].join("\n"),
      );
      if (!confirmed) return;
      const result = await deleteGoal({ environmentId, input: { goalId: goal.id } });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to delete goal",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    },
    [archiveGoal, deleteGoal, memberProjects, allProjectThreads, updateGoalMeta],
  );

  return { handleGoalContextMenu };
}
