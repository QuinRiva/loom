/**
 * loom: the web's instances of the Loom goal atoms and ws-method commands
 * (3d-3). A thread's Loom goal is `workstream.goalId` — never the
 * provider-native `goal` on the shell (Codex/Claude's own `/goal`).
 */
import { useAtomValue } from "@effect/atom-react";
import { createLoomCommandAtoms } from "@t3tools/client-runtime/state/loom/goalCommands";
import { createLoomGoalAtoms, goalById } from "@t3tools/client-runtime/state/loom/goals";
import type { EnvironmentId, GoalId, LoomGoalShell } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSnapshotAtom } from "../state/shell";

export const loomGoalAtoms = createLoomGoalAtoms({ snapshotAtom: environmentSnapshotAtom });
export const loomCommands = createLoomCommandAtoms(connectionAtomRuntime);

const EMPTY_GOALS_ATOM = Atom.make<ReadonlyArray<LoomGoalShell>>(Object.freeze([])).pipe(
  Atom.withLabel("loom-goals:empty"),
);

export function useLoomGoals(environmentId: EnvironmentId | null): ReadonlyArray<LoomGoalShell> {
  return useAtomValue(
    environmentId === null ? EMPTY_GOALS_ATOM : loomGoalAtoms.goalsAtom(environmentId),
  );
}

export function useLoomGoal(
  environmentId: EnvironmentId | null,
  goalId: GoalId | null | undefined,
): LoomGoalShell | null {
  const goals = useLoomGoals(environmentId);
  return goalId == null ? null : goalById(goals, goalId);
}

/** The Loom goal a thread carries, read at call time (menus, not render). */
export function readLoomGoal(
  environmentId: EnvironmentId,
  goalId: GoalId | null | undefined,
): LoomGoalShell | null {
  return goalId == null ? null : goalById(appAtomRegistry.get(loomGoalAtoms.goalsAtom(environmentId)), goalId);
}

/** Done/total over a nested task tree. */
export function countGoalTasks(
  tasks: LoomGoalShell["tasks"],
): { readonly done: number; readonly total: number } {
  return tasks.reduce(
    (acc, task) => {
      const child = countGoalTasks(task.children);
      return {
        done: acc.done + (task.done ? 1 : 0) + child.done,
        total: acc.total + 1 + child.total,
      };
    },
    { done: 0, total: 0 },
  );
}
