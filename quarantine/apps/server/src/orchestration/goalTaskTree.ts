import type { GoalId, GoalTaskId, OrchestrationGoalTask } from "@t3tools/contracts";

/**
 * Flat representation of a goal task used while applying task events. The
 * read-model / wire shape (`OrchestrationGoalTask`) is the assembled nested
 * tree; mutations are simplest over a flat array, so projectors flatten the
 * current tree, mutate, then rebuild. Deleted tasks are never retained — reads
 * exclude them, so a deleted subtree simply disappears from the tree.
 */
export interface FlatGoalTask {
  readonly id: GoalTaskId;
  readonly goalId: GoalId;
  readonly parentTaskId: GoalTaskId | null;
  readonly text: string;
  readonly done: boolean;
  readonly position: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function flattenGoalTasks(tasks: ReadonlyArray<OrchestrationGoalTask>): FlatGoalTask[] {
  const flat: FlatGoalTask[] = [];
  const walk = (nodes: ReadonlyArray<OrchestrationGoalTask>) => {
    for (const node of nodes) {
      flat.push({
        id: node.id,
        goalId: node.goalId,
        parentTaskId: node.parentTaskId,
        text: node.text,
        done: node.done,
        position: node.position,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
      });
      walk(node.children);
    }
  };
  walk(tasks);
  return flat;
}

export function buildGoalTaskTree(flat: ReadonlyArray<FlatGoalTask>): OrchestrationGoalTask[] {
  const childrenByParent = new Map<string, FlatGoalTask[]>();
  for (const task of flat) {
    const key = task.parentTaskId ?? "";
    const bucket = childrenByParent.get(key);
    if (bucket) bucket.push(task);
    else childrenByParent.set(key, [task]);
  }
  const build = (parentKey: string): OrchestrationGoalTask[] =>
    (childrenByParent.get(parentKey) ?? [])
      .toSorted(
        (left, right) =>
          left.position - right.position ||
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      )
      .map((task) => ({
        id: task.id,
        goalId: task.goalId,
        parentTaskId: task.parentTaskId,
        text: task.text,
        done: task.done,
        position: task.position,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        deletedAt: null,
        children: build(task.id),
      }));
  return build("");
}

/** Ids of `taskId` plus all of its descendants in a flat task list. */
export function collectSubtreeIds(
  flat: ReadonlyArray<FlatGoalTask>,
  taskId: GoalTaskId,
): Set<string> {
  const childrenByParent = new Map<string, FlatGoalTask[]>();
  for (const task of flat) {
    const key = task.parentTaskId ?? "";
    const bucket = childrenByParent.get(key);
    if (bucket) bucket.push(task);
    else childrenByParent.set(key, [task]);
  }
  const ids = new Set<string>();
  const visit = (id: string) => {
    if (ids.has(id)) return;
    ids.add(id);
    for (const child of childrenByParent.get(id) ?? []) visit(child.id);
  };
  visit(taskId);
  return ids;
}
