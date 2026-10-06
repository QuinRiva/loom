/**
 * The goal task tree's pure helpers: flat ↔ nested conversion (the store hands
 * out the nested `LoomGoalTask` tree; diffs and rewrites work over a flat list
 * in tree order), and branch scoping — a thread anchored to a task owns that
 * task and its subtree (ported from V1's `goalTaskTree.ts` and
 * `goalTaskAnchor.loom.ts`).
 *
 * @module loom/goals/goalTaskTree
 */
import type { GoalTaskId, LoomGoalTask } from "@t3tools/contracts";

import { agentToolName } from "../../mcp/toolkits/workstream/families.ts";

export type FlatGoalTask = Omit<LoomGoalTask, "children" | "deletedAt">;

/** The tree in document order (parents before children), without nesting. */
export const flattenGoalTasks = (tasks: ReadonlyArray<LoomGoalTask>): Array<FlatGoalTask> =>
  tasks.flatMap(({ children, deletedAt: _deletedAt, ...task }) => [
    task,
    ...flattenGoalTasks(children),
  ]);

/** Nests a flat list, siblings ordered by position, then creation, then id. */
export const buildGoalTaskTree = (flat: ReadonlyArray<FlatGoalTask>): Array<LoomGoalTask> => {
  const childrenByParent = Map.groupBy(flat, (task): string => task.parentTaskId ?? "");
  const build = (parentKey: string): Array<LoomGoalTask> =>
    (childrenByParent.get(parentKey) ?? [])
      .toSorted(
        (left, right) =>
          left.position - right.position ||
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      )
      .map((task) => ({ ...task, deletedAt: null, children: build(task.id) }));
  return build("");
};

/** The live task with this id anywhere in the goal's tree, or null. */
export const findGoalTask = (
  tasks: ReadonlyArray<LoomGoalTask>,
  taskId: GoalTaskId,
): LoomGoalTask | null => {
  for (const task of tasks) {
    if (task.id === taskId) return task;
    const found = findGoalTask(task.children, taskId);
    if (found !== null) return found;
  }
  return null;
};

/** A thread's live anchor; null = unbound (never bound, or its task was deleted). */
export const resolveThreadAnchor = (
  tasks: ReadonlyArray<LoomGoalTask>,
  anchorTaskId: GoalTaskId | null,
): LoomGoalTask | null => (anchorTaskId === null ? null : findGoalTask(tasks, anchorTaskId));

/** Is `taskId` the anchor or one of its descendants? */
export const isWithinGoalTaskBranch = (anchor: LoomGoalTask, taskId: GoalTaskId): boolean =>
  findGoalTask([anchor], taskId) !== null;

/** The task's ancestors, outermost first — the read-only context around a branch. */
export const goalTaskSpine = (
  tasks: ReadonlyArray<LoomGoalTask>,
  taskId: GoalTaskId,
): ReadonlyArray<LoomGoalTask> => {
  const walk = (
    nodes: ReadonlyArray<LoomGoalTask>,
    ancestors: ReadonlyArray<LoomGoalTask>,
  ): ReadonlyArray<LoomGoalTask> | null => {
    for (const task of nodes) {
      if (task.id === taskId) return ancestors;
      const found = walk(task.children, [...ancestors, task]);
      if (found !== null) return found;
    }
    return null;
  };
  return walk(tasks, []) ?? [];
};

/** One checklist line as the goal-task markdown parser yields it. */
export interface GoalTaskLine {
  readonly taskId: GoalTaskId | null;
  readonly parentIndex: number | null;
  readonly text: string;
  readonly done: boolean;
}

/**
 * A BRANCH rewrite expressed as the whole-tree rewrite the store takes: the
 * submission is exactly one top-level line carrying the anchor's id plus its
 * subtree, spliced in where the anchor sits. The anchor may be renamed or
 * ticked, never deleted or moved, and nothing outside the branch changes.
 */
export const composeBranchRewrite = (input: {
  readonly submitted: ReadonlyArray<GoalTaskLine>;
  readonly tasks: ReadonlyArray<LoomGoalTask>;
  readonly anchor: LoomGoalTask;
}):
  | { readonly lines: ReadonlyArray<GoalTaskLine & { readonly position: number }> }
  | { readonly error: string } => {
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
      error: `Task ${outside.taskId} ("${outside.text}") is outside the branch you own, rooted at ${anchorLabel}, so a branch rewrite cannot touch it. Record work elsewhere in the goal with ${agentToolName("goal_task_add")} (passing its parentTaskId), and ask the tree's owner to restructure anything else. Nothing was applied.`,
    };
  }

  // Re-emit the goal in document order with the submitted subtree spliced in
  // at the anchor; every line outside the branch keeps its identity and rank.
  const composed: Array<GoalTaskLine> = [];
  const spliceSubmitted = (parentIndex: number | null) => {
    const composedIndex = new Map<number, number>();
    submitted.forEach((line, index) => {
      composedIndex.set(index, composed.length);
      composed.push({
        ...line,
        parentIndex: line.parentIndex === null ? parentIndex : composedIndex.get(line.parentIndex)!,
      });
    });
  };
  const walk = (nodes: ReadonlyArray<LoomGoalTask>, parentIndex: number | null) => {
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

  // Positions are ranks among siblings in document order, as the parser derives them.
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
