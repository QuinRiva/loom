/**
 * Shared rendering for a goal's task tree. Both the once-per-session prompt
 * injection (`ProviderCommandReactor`), the human-facing `t3 goal show` CLI
 * (`cli/goal.ts`), and the on-demand `goal_task_list` read tool
 * (`mcp/GoalTaskHttp.ts`) render the SAME `- [x] text (id)` indented form — this
 * is the single place that shape lives.
 *
 * Task-tree branch scoping (plans/task-tree-branch-scoping/plan.mdx) adds the
 * scoped renderings beside it. They obey one invariant: a rendering is either
 * COMPLETE within its declared scope — so resubmitting it to the matching
 * `goal_tasks_rewrite` scope is a verbatim no-op — or it is mechanically
 * unusable as a rewrite submission. The elided/annotated views buy the second
 * half with marker lines that carry no `- ` bullet, which `parseGoalTaskMarkdown`
 * rejects outright ("Could not parse this line as a task") rather than silently
 * reading as a new task whose siblings were deleted.
 */
import type { GoalTaskId, OrchestrationGoalTask } from "@t3tools/contracts";

import {
  findGoalTask,
  goalTaskSpine,
  isWithinGoalTaskBranch,
  resolveThreadAnchor,
} from "./goalTaskAnchor.loom.ts";

/** Indented `- [x] text (id)` tree, one line per task, deepest last. */
export const renderGoalTaskTree = (
  tasks: ReadonlyArray<OrchestrationGoalTask>,
  depth = 0,
): string =>
  tasks
    .map(
      (task) =>
        `${"  ".repeat(depth)}- [${task.done ? "x" : " "}] ${task.text} (${task.id})\n` +
        renderGoalTaskTree(task.children, depth + 1),
    )
    .join("");

/** Done and total counts over a task's DESCENDANTS (the task itself excluded). */
const descendantCounts = (
  task: OrchestrationGoalTask,
): { readonly done: number; readonly total: number } =>
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

const taskLine = (task: OrchestrationGoalTask, depth: number): string =>
  `${"  ".repeat(depth)}- [${task.done ? "x" : " "}] ${task.text} (${task.id})`;

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * The open plan: a fully-done subtree collapses to its own line plus an elision
 * marker; anything open — and every ancestor of open work — renders in full.
 * The marker line is deliberately not a checklist line, so pasting this view
 * into a rewrite fails loudly instead of deleting the elided history.
 */
export const renderOpenGoalTaskTree = (
  tasks: ReadonlyArray<OrchestrationGoalTask>,
  depth = 0,
): string =>
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

/** Top-level phases only, each with its `done/total` descendant counts. */
export const renderGoalTaskOverview = (tasks: ReadonlyArray<OrchestrationGoalTask>): string =>
  tasks
    .map((task) => {
      const counts = descendantCounts(task);
      return counts.total === 0
        ? taskLine(task, 0)
        : `${taskLine(task, 0)} ${counts.done}/${counts.total}`;
    })
    .join("\n");

/** Ancestor lines, outermost first, as read-only context (never rewrite input). */
const renderSpine = (spine: ReadonlyArray<OrchestrationGoalTask>): string =>
  spine.map((task, depth) => `${"  ".repeat(depth + 1)}${task.text} (${task.id})`).join("\n");

/**
 * What a bound thread sees of the tree: where its branch hangs (read-only
 * context, bullet-less so it cannot be mistaken for rewrite input), then the
 * branch itself in full editable `- [x] text (id)` markdown — the complete,
 * round-trip-identical source for a branch-scoped `goal_tasks_rewrite`.
 */
export const renderGoalTaskBranch = (
  anchor: OrchestrationGoalTask,
  spine: ReadonlyArray<OrchestrationGoalTask>,
): string =>
  (spine.length === 0
    ? ""
    : `Where your branch sits in the goal (read-only context, not rewrite input):\n${renderSpine(spine)}\n\n`) +
  `Your branch — its root line is your anchor, and this block is the complete source a branch rewrite takes:\n${renderGoalTaskTree([anchor]).trimEnd()}`;

/** Where an out-of-branch add landed: its ancestor spine, then the added line. */
export const renderGoalTaskPlacement = (
  spine: ReadonlyArray<OrchestrationGoalTask>,
  added: OrchestrationGoalTask,
): string =>
  `Recorded outside your branch, under:\n${renderSpine(spine)}\n${"  ".repeat(spine.length + 1)}+ ${added.text} (${added.id})`;

/** One line of goal-level numbers, so a branch-scoped thread still sees the whole. */
export const renderGoalPulse = (
  tasks: ReadonlyArray<OrchestrationGoalTask>,
  anchor: OrchestrationGoalTask | null,
): string => {
  let total = 0;
  let done = 0;
  let openOutside = 0;
  const walk = (nodes: ReadonlyArray<OrchestrationGoalTask>, inBranch: boolean) => {
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

const ROOT_ECHO_FOOTER =
  'Done subtrees are elided above, so this echo is NOT rewrite input — rewrite from a fresh goal_task_list (scope "tree"), which returns the complete tree.';

/**
 * What a goal_task_* mutation answers with. The awareness contract is
 * "complete within the scope you own, plus a pulse", never a bare confirmation
 * line: a bound thread gets its whole branch and the goal's numbers (and, when
 * it just placed a task outside its branch, that line with its ancestor spine);
 * an unbound child gets the open plan; the root gets the open plan plus the
 * footer saying it is not rewrite input.
 */
export const renderGoalTaskEcho = (input: {
  readonly summary: string;
  readonly tasks: ReadonlyArray<OrchestrationGoalTask>;
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
      : `${input.summary}\n\n${open}\n\n${ROOT_ECHO_FOOTER}`;
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

export interface GoalTaskNode {
  readonly id: string;
  readonly text: string;
  readonly done: boolean;
  readonly position: number;
  readonly children: ReadonlyArray<GoalTaskNode>;
}

/** Structured tree carrying only the fields an agent acts on. */
export const toGoalTaskNodes = (
  tasks: ReadonlyArray<OrchestrationGoalTask>,
): ReadonlyArray<GoalTaskNode> =>
  tasks.map((task) => ({
    id: task.id,
    text: task.text,
    done: task.done,
    position: task.position,
    children: toGoalTaskNodes(task.children),
  }));
