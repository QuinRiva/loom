/**
 * Every read surface of a goal's task tree — `goal_task_list`, the goal tools'
 * echoes and `t3 goal show` — renders the same `- [x] text (id)` indented form;
 * this is the single place that shape lives.
 *
 * One invariant holds for the scoped renderings: a rendering is either
 * COMPLETE within its declared scope — so resubmitting it to the matching
 * `goal_tasks_rewrite` scope is a verbatim no-op — or it is mechanically
 * unusable as a rewrite submission. The elided/annotated views carry marker
 * lines with no `- ` bullet, which `parseGoalTaskMarkdown` rejects outright
 * rather than reading them as a new task whose siblings were deleted.
 *
 * @module loom/goals/goalTaskRender
 */
import type { GoalTaskId, LoomGoalTask } from "@t3tools/contracts";

import { agentToolName } from "../../mcp/toolkits/workstream/families.ts";
import {
  findGoalTask,
  goalTaskSpine,
  isWithinGoalTaskBranch,
  resolveThreadAnchor,
} from "./goalTaskTree.ts";

const taskLine = (task: LoomGoalTask, depth: number): string =>
  `${"  ".repeat(depth)}- [${task.done ? "x" : " "}] ${task.text} (${task.id})`;

/** Indented `- [x] text (id)` tree, one line per task, deepest last. */
export const renderGoalTaskTree = (tasks: ReadonlyArray<LoomGoalTask>, depth = 0): string =>
  tasks
    .map((task) => `${taskLine(task, depth)}\n${renderGoalTaskTree(task.children, depth + 1)}`)
    .join("");

/** Done and total counts over a task's DESCENDANTS (the task itself excluded). */
const descendantCounts = (task: LoomGoalTask): { readonly done: number; readonly total: number } =>
  task.children.reduce(
    (counts, child) => {
      const below = descendantCounts(child);
      return {
        done: counts.done + below.done + (child.done ? 1 : 0),
        total: counts.total + below.total + 1,
      };
    },
    { done: 0, total: 0 },
  );

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * The open plan: a fully-done subtree collapses to its own line plus an elision
 * marker; anything open — and every ancestor of open work — renders in full.
 */
export const renderOpenGoalTaskTree = (tasks: ReadonlyArray<LoomGoalTask>, depth = 0): string =>
  tasks
    .map((task) => {
      const counts = descendantCounts(task);
      if (task.done && counts.done === counts.total) {
        return counts.total === 0
          ? `${taskLine(task, depth)}\n`
          : `${taskLine(task, depth)}\n${"  ".repeat(depth + 1)}… ${plural(counts.total, "done task")} elided\n`;
      }
      return `${taskLine(task, depth)}\n${renderOpenGoalTaskTree(task.children, depth + 1)}`;
    })
    .join("");

/**
 * Top-level phases only, each with its `done/total` descendant counts. The
 * bullet is dropped so a pasted line never matches the parser's task line.
 */
export const renderGoalTaskOverview = (tasks: ReadonlyArray<LoomGoalTask>): string =>
  tasks
    .map((task) => {
      const counts = descendantCounts(task);
      const line = taskLine(task, 0).replace("- ", "");
      return counts.total === 0 ? line : `${line} ${counts.done}/${counts.total}`;
    })
    .join("\n");

/** Ancestor lines, outermost first, as read-only context (never rewrite input). */
const renderSpine = (spine: ReadonlyArray<LoomGoalTask>): string =>
  spine.map((task, depth) => `${"  ".repeat(depth + 1)}${task.text} (${task.id})`).join("\n");

/**
 * What a bound thread sees of the tree: where its branch hangs (bullet-less
 * read-only context), then the branch itself in full editable markdown — the
 * complete, round-trip-identical source for a branch-scoped rewrite.
 */
export const renderGoalTaskBranch = (
  anchor: LoomGoalTask,
  spine: ReadonlyArray<LoomGoalTask>,
): string =>
  (spine.length === 0
    ? ""
    : `Where your branch sits in the goal (read-only context, not rewrite input):\n${renderSpine(spine)}\n\n`) +
  `Your branch — its root line is your anchor, and this block is the complete source a branch rewrite takes:\n${renderGoalTaskTree([anchor]).trimEnd()}`;

/** Where an out-of-branch add landed: its ancestor spine, then the added line. */
const renderGoalTaskPlacement = (spine: ReadonlyArray<LoomGoalTask>, added: LoomGoalTask): string =>
  `Recorded outside your branch, under:\n${renderSpine(spine)}\n${"  ".repeat(spine.length + 1)}+ ${added.text} (${added.id})`;

/** One line of goal-level numbers, so a branch-scoped thread still sees the whole. */
export const renderGoalPulse = (
  tasks: ReadonlyArray<LoomGoalTask>,
  anchor: LoomGoalTask | null,
): string => {
  let total = 0;
  let done = 0;
  let openOutside = 0;
  const walk = (nodes: ReadonlyArray<LoomGoalTask>, inBranch: boolean) => {
    for (const task of nodes) {
      const within = inBranch || task.id === anchor?.id;
      total += 1;
      if (task.done) done += 1;
      else if (!within) openOutside += 1;
      walk(task.children, within);
    }
  };
  walk(tasks, false);
  return `Goal pulse: ${done}/${total} done · ${plural(total - done, "open task")}${
    anchor === null ? "" : ` · ${openOutside} open outside your branch`
  }`;
};

/** The whole tree, or "(no tasks yet)". */
export const renderTasks = (tasks: ReadonlyArray<LoomGoalTask>): string =>
  tasks.length === 0 ? "(no tasks yet)" : renderGoalTaskTree(tasks).trimEnd();

/**
 * What a goal_task_* mutation answers with: "complete within the scope you
 * own, plus a pulse", never a bare confirmation. A bound thread gets its whole
 * branch and the goal's numbers (and, when it just placed a task outside its
 * branch, that line with its spine); an unbound child gets the open plan; the
 * root gets the open plan plus the footer saying it is not rewrite input.
 */
export const renderGoalTaskEcho = (input: {
  readonly summary: string;
  readonly tasks: ReadonlyArray<LoomGoalTask>;
  readonly anchorTaskId: GoalTaskId | null;
  readonly isChild: boolean;
  readonly placedTaskId?: GoalTaskId;
}): string => {
  const anchor = resolveThreadAnchor(input.tasks, input.anchorTaskId);
  const open =
    input.tasks.length === 0 ? "(no tasks yet)" : renderOpenGoalTaskTree(input.tasks).trimEnd();
  if (anchor === null) {
    return input.isChild
      ? `${input.summary}\n\n${open}`
      : `${input.summary}\n\n${open}\n\nDone subtrees are elided above, so this echo is NOT rewrite input — rewrite from a fresh ${agentToolName("goal_task_list")} (scope "tree"), which returns the complete tree.`;
  }
  const placed =
    input.placedTaskId !== undefined && !isWithinGoalTaskBranch(anchor, input.placedTaskId)
      ? findGoalTask(input.tasks, input.placedTaskId)
      : null;
  return [
    input.summary,
    ...(placed === null
      ? []
      : [renderGoalTaskPlacement(goalTaskSpine(input.tasks, placed.id), placed)]),
    renderGoalTaskBranch(anchor, goalTaskSpine(input.tasks, anchor.id)),
    renderGoalPulse(input.tasks, anchor),
  ].join("\n\n");
};
