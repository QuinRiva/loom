// LOOM-ONLY. Task-tree branch scoping (plans/task-tree-branch-scoping/plan.mdx
// §1): pure resolution of a thread's ANCHOR — the one goal task whose subtree is
// the branch that thread owns. Every surface that scopes to a branch (injection,
// the goal_task_* tools, workstream_list, the panel chip) resolves the anchor
// through here, against the LIVE tree: an anchor whose task was deleted by a
// root rewrite simply resolves to null, degrading the thread to unbound.

import type { GoalTaskId, OrchestrationGoalTask } from "@t3tools/contracts";

import type { ParsedGoalTaskLine } from "./goalTaskMarkdown.ts";

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

/**
 * Is `taskId` inside the branch rooted at `anchor`? The branch is the anchor
 * plus its descendants — the scope a bound thread may read, mutate, and
 * delegate within. One traversal primitive (`findGoalTask`) answers both this
 * and anchor resolution.
 */
export const isWithinGoalTaskBranch = (
  anchor: OrchestrationGoalTask,
  taskId: GoalTaskId,
): boolean => findGoalTask([anchor], taskId) !== null;

/** The anchor's ancestors, outermost first — read-only context around a branch. */
export const goalTaskSpine = (
  tasks: ReadonlyArray<OrchestrationGoalTask>,
  taskId: GoalTaskId,
): ReadonlyArray<OrchestrationGoalTask> => {
  const walk = (
    nodes: ReadonlyArray<OrchestrationGoalTask>,
    ancestors: ReadonlyArray<OrchestrationGoalTask>,
  ): ReadonlyArray<OrchestrationGoalTask> | null => {
    for (const task of nodes) {
      if (task.id === taskId) return ancestors;
      const found = walk(task.children, [...ancestors, task]);
      if (found !== null) return found;
    }
    return null;
  };
  return walk(tasks, []) ?? [];
};

/**
 * A BRANCH rewrite, expressed as the whole-tree rewrite the decider already
 * takes: the submission must be exactly one top-level line carrying the anchor's
 * id plus its subtree, and it replaces the anchor's subtree in place. The anchor
 * may be renamed or ticked, never deleted or moved, and nothing outside the
 * branch is touched — so an unedited branch view resubmitted verbatim resolves
 * to zero changes, exactly as the whole-tree round trip does for the root.
 */
export const composeBranchRewrite = (input: {
  readonly submitted: ReadonlyArray<ParsedGoalTaskLine>;
  readonly tasks: ReadonlyArray<OrchestrationGoalTask>;
  readonly anchor: OrchestrationGoalTask;
}): { readonly lines: ReadonlyArray<ParsedGoalTaskLine> } | { readonly error: string } => {
  const { submitted, tasks, anchor } = input;
  const anchorLabel = `"${anchor.text}" (${anchor.id})`;
  const roots = submitted.filter((line) => line.parentIndex === null);
  if (roots.length > 1) {
    return {
      error: `A branch rewrite submits YOUR BRANCH, not the whole tree: exactly one top-level line — your anchor ${anchorLabel} — with everything else nested beneath it (two spaces per level of nesting). You submitted ${roots.length} top-level lines. Nothing was applied.`,
    };
  }
  if (roots[0]?.taskId !== anchor.id) {
    return {
      error: `The first line of a branch rewrite must be your anchor ${anchorLabel}, keeping its "(id)": it is the root of the branch you own, so it cannot be deleted, replaced or moved — rename it or tick it in place instead. Nothing was applied.`,
    };
  }
  const outside = submitted.find(
    (line) => line.taskId !== null && !isWithinGoalTaskBranch(anchor, line.taskId),
  );
  if (outside) {
    return {
      error: `Task ${outside.taskId} ("${outside.text}") is outside the branch you own, rooted at ${anchorLabel}, so a branch rewrite cannot touch it. Record work elsewhere in the goal with goal_task_add (passing its parentTaskId), and ask the tree's owner to restructure anything else. Nothing was applied.`,
    };
  }

  // Re-emit the goal in document order, splicing the submitted subtree in where
  // the anchor sits; every line outside the branch keeps its identity, text,
  // done-state and rank, so the resolver sees it as unchanged.
  const composed: Array<{
    readonly taskId: GoalTaskId | null;
    readonly parentIndex: number | null;
    readonly text: string;
    readonly done: boolean;
  }> = [];
  const spliceSubmitted = (parentIndex: number | null) => {
    const composedIndex = new Map<number, number>();
    submitted.forEach((line, index) => {
      composedIndex.set(index, composed.length);
      composed.push({
        taskId: line.taskId,
        parentIndex: line.parentIndex === null ? parentIndex : composedIndex.get(line.parentIndex)!,
        text: line.text,
        done: line.done,
      });
    });
  };
  const walk = (nodes: ReadonlyArray<OrchestrationGoalTask>, parentIndex: number | null) => {
    for (const task of nodes) {
      if (task.id === anchor.id) {
        spliceSubmitted(parentIndex);
        continue;
      }
      const index = composed.length;
      composed.push({ taskId: task.id, parentIndex, text: task.text, done: task.done });
      walk(task.children, index);
    }
  };
  walk(tasks, null);

  // Positions are ranks among siblings in document order, exactly as the parser
  // derives them for a whole-tree submission.
  const nextPosition = new Map<number, number>();
  return {
    lines: composed.map((line) => {
      const key = line.parentIndex ?? -1;
      const position = nextPosition.get(key) ?? 0;
      nextPosition.set(key, position + 1);
      return { ...line, position };
    }),
  };
};
