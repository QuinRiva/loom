import type { LoomGoalShellStreamItem, OrchestrationV2ShellSnapshot } from "@t3tools/contracts";

/**
 * Applies one Loom goal item to the shell snapshot's `goals`, keyed by goal id.
 * Goal items carry no sequence (a goal write advances no thread event), so the
 * caller applies them ungated; a stale `goal.updated` loses to the stored goal
 * by `updatedAt`, and the snapshot's `goals` resynchronises on reconnect.
 */
export function applyLoomGoalItem(
  snapshot: OrchestrationV2ShellSnapshot,
  item: LoomGoalShellStreamItem,
): OrchestrationV2ShellSnapshot {
  const goals = snapshot.goals ?? [];
  if (item.kind === "goal.removed") {
    return { ...snapshot, goals: goals.filter((goal) => goal.id !== item.goalId) };
  }
  const current = goals.find((goal) => goal.id === item.goal.id);
  if (current !== undefined && current.updatedAt > item.goal.updatedAt) return snapshot;
  return {
    ...snapshot,
    goals:
      current === undefined
        ? [...goals, item.goal]
        : goals.map((goal) => (goal.id === item.goal.id ? item.goal : goal)),
  };
}
