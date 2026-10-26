/**
 * loom: the web's instances of the Loom goal atoms and ws-method commands
 * (3d-3). A thread's Loom goal is `workstream.goalId` — never the
 * provider-native `goal` on the shell (Codex/Claude's own `/goal`).
 */
import { useAtomValue } from "@effect/atom-react";
import { createLoomCommandAtoms } from "@t3tools/client-runtime/state/loom/goalCommands";
import { createLoomGoalAtoms } from "@t3tools/client-runtime/state/loom/goals";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, GoalId, LoomGoalShell } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSnapshotAtom } from "../state/shell";

const loomGoalAtoms = createLoomGoalAtoms({
  runtime: connectionAtomRuntime,
  snapshotAtom: environmentSnapshotAtom,
});
export const loomCommands = createLoomCommandAtoms(connectionAtomRuntime);

const NO_GOAL_ATOM = Atom.make<LoomGoalShell | null>(null).pipe(Atom.withLabel("loom-goal:none"));

/** The goal, `null` when there is none, `undefined` while it loads off the snapshot. */
export function useLoomGoal(
  environmentId: EnvironmentId | null,
  goalId: GoalId | null | undefined,
): LoomGoalShell | null | undefined {
  return useAtomValue(
    environmentId === null || goalId == null
      ? NO_GOAL_ATOM
      : loomGoalAtoms.goalAtom(environmentId, goalId),
  );
}

/** The Loom goal a thread carries, read at call time (menus, not render). */
export async function readLoomGoal(
  environmentId: EnvironmentId,
  goalId: GoalId | null | undefined,
): Promise<LoomGoalShell | null> {
  if (goalId == null) return null;
  const held = loomGoalAtoms.heldGoal(
    appAtomRegistry.get(environmentSnapshotAtom(environmentId)),
    goalId,
  );
  if (held !== null) return held;
  const result = await executeAtomQuery(
    appAtomRegistry,
    loomGoalAtoms.goalQuery({ environmentId, input: { goalId } }),
    { reportFailure: false },
  );
  return result._tag === "Success" ? result.value.goal : null;
}

/** Done/total over a nested task tree. */
export function countGoalTasks(tasks: LoomGoalShell["tasks"]): {
  readonly done: number;
  readonly total: number;
} {
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
