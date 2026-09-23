// LOOM-ONLY. Task-tree branch scoping (plans/task-tree-branch-scoping/plan.mdx
// §1): pure resolution of a thread's ANCHOR — the one goal task whose subtree is
// the branch that thread owns. Every surface that scopes to a branch (injection,
// the goal_task_* tools, workstream_list, the panel chip) resolves the anchor
// through here, against the LIVE tree: an anchor whose task was deleted by a
// root rewrite simply resolves to null, degrading the thread to unbound.

import type { GoalTaskId, OrchestrationGoalTask } from "@t3tools/contracts";

/** The live task with this id anywhere in the goal's tree, or null. */
export const findGoalTask = (
  tasks: ReadonlyArray<OrchestrationGoalTask>,
  taskId: GoalTaskId,
): OrchestrationGoalTask | null => {
  for (const task of tasks) {
    if (task.id === taskId) return task;
    const found = findGoalTask(task.children, taskId);
    if (found !== null) return found;
  }
  return null;
};

/**
 * Resolve a thread's stored `anchorTaskId` to its live task. Null means
 * UNBOUND — never bound, or bound to a task that has since been deleted.
 */
export const resolveThreadAnchor = (
  tasks: ReadonlyArray<OrchestrationGoalTask>,
  anchorTaskId: GoalTaskId | null,
): OrchestrationGoalTask | null =>
  anchorTaskId === null ? null : findGoalTask(tasks, anchorTaskId);

/** Every task id in a subtree, the anchor itself included. */
export const goalTaskBranchIds = (anchor: OrchestrationGoalTask): Set<string> => {
  const ids = new Set<string>();
  const walk = (task: OrchestrationGoalTask) => {
    ids.add(task.id);
    for (const child of task.children) walk(child);
  };
  walk(anchor);
  return ids;
};

/**
 * Is `taskId` inside the branch rooted at `anchor`? The branch is the anchor
 * plus its descendants — the scope a bound thread may read, mutate, and
 * delegate within.
 */
export const isWithinGoalTaskBranch = (
  anchor: OrchestrationGoalTask,
  taskId: GoalTaskId,
): boolean => goalTaskBranchIds(anchor).has(taskId);
