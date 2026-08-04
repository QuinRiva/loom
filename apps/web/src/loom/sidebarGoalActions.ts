// loom: fork-added goal actions, hoisted out of the upstream-owned Sidebar.tsx.
// Two consumers share this module and neither duplicates the commands: the v2
// thread context menu (create goal from thread / assign to goal) and the Goal
// panel's overflow menu.
import { useCallback } from "react";
import {
  type ContextMenuItem,
  type EnvironmentId,
  GoalId,
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
import { promptGoalForm, slugifyGoalTitle } from "./goalFormDialogStore";

type UpdateThreadMetadata = (value: {
  environmentId: EnvironmentId;
  input: { threadId: ThreadId; goalId: GoalId | null };
}) => Promise<unknown>;

function reportFailure(title: string, error: unknown): void {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

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
        const form = await promptGoalForm({
          mode: "create",
          initial: {
            title: thread.title,
            slug: slugifyGoalTitle(thread.title),
            description: thread.title,
          },
        });
        if (!form) return true;
        const goalId = newGoalId();
        const createResult = await createGoal({
          environmentId: thread.environmentId,
          input: {
            goalId,
            projectId: thread.projectId,
            slug: form.slug,
            title: form.title,
            description: form.description,
          },
        });
        if (createResult._tag === "Failure" && !isAtomCommandInterrupted(createResult)) {
          reportFailure("Failed to create goal", squashAtomCommandFailure(createResult));
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

export interface GoalCrudActions {
  /** Structured rename dialog + `goal.meta.update`. No-op when cancelled. */
  renameGoal: (
    environmentId: EnvironmentId,
    goal: { id: GoalId; title: string; description: string },
  ) => Promise<void>;
  archiveGoal: (environmentId: EnvironmentId, goalId: GoalId) => Promise<void>;
  /**
   * Blast-radius confirm then `goal.delete`. `attachedThreadCount` must come
   * from the UNFILTERED shells: the decider cascade-deletes every thread on the
   * goal including workstream children that roots-only lists omit, and
   * understating that in a destructive confirm is the failure mode.
   */
  deleteGoal: (
    environmentId: EnvironmentId,
    goal: { id: GoalId; title: string },
    attachedThreadCount: number,
  ) => Promise<void>;
}

export function useGoalCrudActions(): GoalCrudActions {
  const updateGoalMeta = useAtomCommand(goalEnvironment.updateMeta, { reportFailure: false });
  const archive = useAtomCommand(goalEnvironment.archive, { reportFailure: false });
  const remove = useAtomCommand(goalEnvironment.delete, { reportFailure: false });

  const renameGoal = useCallback<GoalCrudActions["renameGoal"]>(
    async (environmentId, goal) => {
      const form = await promptGoalForm({
        mode: "rename",
        initial: { title: goal.title, slug: "", description: goal.description },
      });
      if (!form || (form.title === goal.title && form.description === goal.description)) return;
      await updateGoalMeta({
        environmentId,
        input: { goalId: goal.id, title: form.title, description: form.description },
      });
    },
    [updateGoalMeta],
  );

  const archiveGoal = useCallback<GoalCrudActions["archiveGoal"]>(
    async (environmentId, goalId) => {
      await archive({ environmentId, input: { goalId } });
    },
    [archive],
  );

  const deleteGoal = useCallback<GoalCrudActions["deleteGoal"]>(
    async (environmentId, goal, attachedThreadCount) => {
      const api = readLocalApi();
      if (!api) return;
      const confirmed = await api.dialogs.confirm(
        [
          `Delete goal "${goal.title}"?`,
          attachedThreadCount > 0
            ? `This permanently deletes the goal and its ${attachedThreadCount} thread${
                attachedThreadCount === 1 ? "" : "s"
              }, clearing their conversation history.`
            : "This permanently deletes the goal.",
        ].join("\n"),
      );
      if (!confirmed) return;
      const result = await remove({ environmentId, input: { goalId: goal.id } });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        reportFailure("Failed to delete goal", squashAtomCommandFailure(result));
      }
    },
    [remove],
  );

  return { renameGoal, archiveGoal, deleteGoal };
}
