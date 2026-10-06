/**
 * loom: the goal panel's task edits as `loom.goal.task.rewrite` inputs (3d-3).
 *
 * Each edit submits the smallest branch that contains it — the task itself for
 * a tick or rename, its parent for a removal or an added child — so an edit
 * never rewrites (and so never clobbers) the rest of a tree agents are also
 * writing. Only top-level adds and removals submit the whole tree.
 */
import type {
  GoalTaskId,
  LoomGoalTask,
  LoomGoalTaskRewriteInput,
  LoomGoalTaskRewriteNode,
} from "@t3tools/contracts";

export type GoalTaskEdit =
  | { readonly kind: "toggle"; readonly taskId: GoalTaskId }
  | { readonly kind: "rename"; readonly taskId: GoalTaskId; readonly text: string }
  | { readonly kind: "remove"; readonly taskId: GoalTaskId }
  | { readonly kind: "add"; readonly parentTaskId: GoalTaskId | null; readonly text: string };

const toNode = (task: LoomGoalTask): LoomGoalTaskRewriteNode => ({
  id: task.id,
  text: task.text,
  done: task.done,
  children: task.children.map(toNode),
});

const findTask = (tasks: ReadonlyArray<LoomGoalTask>, id: GoalTaskId): LoomGoalTask | null => {
  for (const task of tasks) {
    if (task.id === id) return task;
    const found = findTask(task.children, id);
    if (found) return found;
  }
  return null;
};

/** The children edit applied at `parentTaskId` (null = the top level). */
const rewriteChildren = (
  tasks: ReadonlyArray<LoomGoalTask>,
  parentTaskId: GoalTaskId | null,
  edit: (children: LoomGoalTaskRewriteNode[]) => LoomGoalTaskRewriteNode[],
): Pick<LoomGoalTaskRewriteInput, "branchTaskId" | "tasks"> | null => {
  if (parentTaskId === null) return { branchTaskId: null, tasks: edit(tasks.map(toNode)) };
  const parent = findTask(tasks, parentTaskId);
  if (!parent) return null;
  const node = toNode(parent);
  return { branchTaskId: parent.id, tasks: [{ ...node, children: edit([...node.children]) }] };
};

/** The rewrite input for one panel edit, or null when the task is gone. */
export function goalTaskRewriteFor(
  tasks: ReadonlyArray<LoomGoalTask>,
  edit: GoalTaskEdit,
): Pick<LoomGoalTaskRewriteInput, "branchTaskId" | "tasks"> | null {
  if (edit.kind === "add") {
    return rewriteChildren(tasks, edit.parentTaskId, (children) => [
      ...children,
      { text: edit.text, done: false, children: [] },
    ]);
  }
  const task = findTask(tasks, edit.taskId);
  if (!task) return null;
  if (edit.kind === "remove") {
    return rewriteChildren(tasks, task.parentTaskId, (children) =>
      children.filter((child) => child.id !== task.id),
    );
  }
  const node = toNode(task);
  return {
    branchTaskId: task.id,
    tasks: [edit.kind === "toggle" ? { ...node, done: !node.done } : { ...node, text: edit.text }],
  };
}
