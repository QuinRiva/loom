// loom: Loom goal actions (3d-3) for the sidebar thread context menu. Every
// write goes through a `loom.goal.*` ws method; the result arrives on the shell's goal stream, so nothing here
// patches local state. Vocabulary: "goal" here is Loom's goal, never the
// provider-native `/goal` status chip upstream renders.
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type {
  ContextMenuItem,
  EnvironmentId,
  LocalApi,
  LoomGoalShell,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useCallback } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useRightPanelStore } from "../rightPanelStore";
import { useAtomCommand } from "../state/use-atom-command";
import { promptGoalForm } from "./goalFormDialogStore";
import { loomCommands } from "./loomGoalState";

const reportFailure = (title: string) => (result: AtomCommandResult<unknown, unknown>) => {
  if (result._tag !== "Failure") return;
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
};

type LoomGoalMenuId = "loom-goal" | "loom-goal:tasks" | "loom-goal:rename";

/**
 * `api.contextMenu.show` with a "Goal ▸" submenu first, set off from upstream's
 * thread items by a separator — one row, so the thread items (Archive thread
 * among them) stay within reach. Unchanged for a thread with no Loom goal.
 */
export const showWithLoomGoalMenu =
  (api: LocalApi, goal: LoomGoalShell | null) =>
  <Id extends string>(items: readonly ContextMenuItem<Id>[], position?: { x: number; y: number }) =>
    api.contextMenu.show<Id | LoomGoalMenuId>(
      goal === null
        ? items
        : [
            {
              id: "loom-goal",
              label: "Goal",
              icon: "target",
              children: [
                { id: "loom-goal:tasks", label: "Open goal tasks" },
                { id: "loom-goal:rename", label: "Rename goal\u2026" },
              ],
            },
            ...items.map((item, index) =>
              index === 0 ? { ...item, separatorBefore: true } : item,
            ),
          ],
      position,
    );

export function useLoomGoalActions() {
  const update = useAtomCommand(loomCommands.goalUpdate, { reportFailure: false });

  const renameGoal = useCallback(
    async (environmentId: EnvironmentId, goal: LoomGoalShell) => {
      const form = await promptGoalForm({ title: goal.title, description: goal.description });
      if (!form || (form.title === goal.title && form.description === goal.description)) return;
      reportFailure("Could not rename the goal")(
        await update({
          environmentId,
          input: { goalId: goal.id, title: form.title, description: form.description },
        }),
      );
    },
    [update],
  );

  /** Runs a "Goal ▸" submenu entry; false when `clicked` is not one of them. */
  const runGoalMenuAction = useCallback(
    (
      clicked: string | null | undefined,
      goal: LoomGoalShell | null,
      threadRef: ScopedThreadRef,
    ) => {
      if (goal === null || !clicked?.startsWith("loom-goal:")) return false;
      const { environmentId } = threadRef;
      if (clicked === "loom-goal:tasks") useRightPanelStore.getState().open(threadRef, "tasks");
      if (clicked === "loom-goal:rename") void renameGoal(environmentId, goal);
      return true;
    },
    [renameGoal],
  );

  return { runGoalMenuAction };
}
