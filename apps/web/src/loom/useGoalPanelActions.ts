/**
 * loom: the Goal panel's overflow menu — rename / archive / delete / new session.
 *
 * CRUD reuses `useGoalCrudActions` (shared with the v1 goal-header menu). The
 * new-session path is the load-bearing one: it goes through
 * `resolveGoalWorktreeSeed` → `resolveSidebarNewThreadSeedContext`, whose top
 * precedence is what makes a thread created under a goal join that goal's living
 * worktree (regression-tested in Sidebar.logic.test.ts). Never seed a goal
 * session by any other route.
 */
import { useCallback } from "react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { DEFAULT_SERVER_SETTINGS, type EnvironmentId, type GoalId } from "@t3tools/contracts";

import {
  resolveSidebarNewThreadEnvMode,
  resolveSidebarNewThreadSeedContext,
} from "../components/Sidebar.logic";
import { resolveGoalWorktreeSeed } from "../components/Sidebar.logic.loom";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { readLocalApi } from "../localApi";
import { useServerConfigs, useThreadShells } from "../state/entities";
import type { GoalShell, SidebarThreadSummary } from "../types";
import { useGoalCrudActions } from "./sidebarGoalActions";

export function useGoalPanelActions(input: {
  goal: GoalShell;
  environmentId: EnvironmentId;
  /** The thread the panel is anchored to — the local-mode seed fallback. */
  activeThread: Pick<SidebarThreadSummary, "projectId" | "branch" | "worktreePath"> | null;
}): {
  createGoalSession: () => Promise<void>;
  openOverflowMenu: (position: { x: number; y: number }) => Promise<void>;
} {
  const { goal, environmentId, activeThread } = input;
  const handleNewThread = useNewThreadHandler();
  const serverConfigs = useServerConfigs();
  const allShells = useThreadShells();
  const { renameGoal, archiveGoal, deleteGoal } = useGoalCrudActions();

  const createGoalSession = useCallback(async () => {
    const settings = serverConfigs.get(environmentId)?.settings ?? DEFAULT_SERVER_SETTINGS;
    const seed = resolveSidebarNewThreadSeedContext({
      projectId: goal.projectId,
      defaultEnvMode: resolveSidebarNewThreadEnvMode({
        defaultEnvMode: settings.defaultThreadEnvMode,
      }),
      newWorktreesStartFromOrigin: settings.newWorktreesStartFromOrigin,
      goalWorktree: resolveGoalWorktreeSeed({ goalId: goal.id, threads: allShells }),
      activeThread,
    });
    const result = await settlePromise(() =>
      handleNewThread(scopeProjectRef(environmentId, goal.projectId), {
        ...seed,
        goalId: goal.id as GoalId,
        // Re-clicking the entry point resumes the goal's draft bucket; the seed
        // only initialises a fresh one (same contract as the sidebar's button).
        contextMode: "seed",
      }),
    );
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not create thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  }, [
    activeThread,
    allShells,
    environmentId,
    goal.id,
    goal.projectId,
    handleNewThread,
    serverConfigs,
  ]);

  const openOverflowMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        [
          { id: "new-session", label: "New session under this goal" },
          { id: "rename", label: "Rename goal\u2026" },
          { id: "archive", label: "Archive goal" },
          { id: "delete", label: "Delete goal", destructive: true, icon: "trash" },
        ],
        position,
      );
      if (clicked === "new-session") return createGoalSession();
      if (clicked === "rename") return renameGoal(environmentId, goal);
      if (clicked === "archive") return archiveGoal(environmentId, goal.id as GoalId);
      if (clicked !== "delete") return;
      // Count from the UNFILTERED shells: the cascade takes workstream children
      // too, and this panel lists only roots.
      return deleteGoal(
        environmentId,
        { id: goal.id as GoalId, title: goal.title || goal.slug },
        allShells.filter((thread) => thread.goalId === goal.id).length,
      );
    },
    [allShells, archiveGoal, createGoalSession, deleteGoal, environmentId, goal, renameGoal],
  );

  return { createGoalSession, openOverflowMenu };
}
