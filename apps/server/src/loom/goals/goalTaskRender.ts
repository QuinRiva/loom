/**
 * The single home of the `- [x] text (id)` rendering every goal-tree read surface shares. A scoped
 * rendering is either COMPLETE within its scope, so resubmitting it to the matching
 * `goal_tasks_rewrite` scope is a no-op, or unusable as a submission: elided views carry
 * bullet-less marker lines that `parseGoalTaskMarkdown` rejects.
 */
import type { GoalTaskId, IsoDateTime, LoomGoalTask } from "@t3tools/contracts";

import {
  findGoalTask,
  flattenGoalTasks,
  goalTaskSpine,
  isWithinGoalTaskBranch,
  resolveThreadAnchor,
  type FlatGoalTask,
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

const indent = (depth: number) => "  ".repeat(depth + 1);

/** Ancestor lines, outermost first, as read-only context (never rewrite input). */
const renderSpine = (spine: ReadonlyArray<LoomGoalTask>): string =>
  spine.map((task, depth) => `${indent(depth)}${task.text} (${task.id})`).join("\n");

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
  `Your branch: its root line is your anchor, and this block is the complete source a branch rewrite takes:\n${renderGoalTaskTree([anchor]).trimEnd()}`;

/** Where an out-of-branch add landed: its ancestor spine, then the added line. */
const renderGoalTaskPlacement = (spine: ReadonlyArray<LoomGoalTask>, added: LoomGoalTask): string =>
  `Recorded outside your branch, under:\n${renderSpine(spine)}\n${indent(spine.length)}+ ${added.text} (${added.id})`;

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

/** What one write did, as its reply reports it. */
export type GoalTaskWrite =
  | { readonly kind: "add" | "update"; readonly taskId: GoalTaskId }
  | {
      readonly kind: "rewrite";
      /** Tasks the rewrite created, whose ids only this reply carries. */
      readonly minted: ReadonlySet<string>;
      /** Every task whose stored state the rewrite changed, minted and removed included. */
      readonly touched: ReadonlySet<string>;
    };

/** The tasks in `marked` under their ancestor paths, bullet-less; marked lines carry `+`. */
const renderMarkedPaths = (
  tasks: ReadonlyArray<LoomGoalTask>,
  marked: ReadonlySet<string>,
  depth = 0,
): string =>
  tasks
    .map((task) => {
      const below = renderMarkedPaths(task.children, marked, depth + 1);
      return marked.has(task.id) || below.length > 0
        ? `${indent(depth)}${marked.has(task.id) ? "+ " : ""}${task.text} (${task.id})\n${below}`
        : "";
    })
    .join("");

/**
 * Tasks another writer added, ticked, edited or removed after `readAt`, outside `touched`. A removed
 * subtree is its root line with a count; "ticked" and "edited" read the current state, since a row
 * keeps no history.
 */
const renderOthersChanged = (
  tasks: ReadonlyArray<LoomGoalTask>,
  deleted: ReadonlyArray<FlatGoalTask>,
  readAt: IsoDateTime | null,
  touched: ReadonlySet<string>,
): string => {
  if (readAt === null) return "";
  const live = flattenGoalTasks(tasks);
  const textOf = new Map<string, string>([...deleted, ...live].map((task) => [task.id, task.text]));
  const since = (task: FlatGoalTask) => task.updatedAt > readAt && !touched.has(task.id);
  const removed = deleted.filter(since);
  const removedIds = new Set<string>(removed.map((task) => task.id));
  const beneath = (task: FlatGoalTask): number =>
    removed
      .filter((child) => child.parentTaskId === task.id)
      .reduce((count, child) => count + 1 + beneath(child), 0);
  const line = (verb: string, task: FlatGoalTask, suffix = "") => {
    const parent = task.parentTaskId === null ? undefined : textOf.get(task.parentTaskId);
    return `  ${verb.padEnd(9)}${task.text} (${task.id})${parent === undefined ? "" : `, under ${parent}`}${suffix}`;
  };
  const lines = [
    ...live
      .filter(since)
      .map((task) =>
        line(task.createdAt > readAt ? "added" : task.done ? "ticked" : "edited", task),
      ),
    ...removed
      .filter((task) => task.parentTaskId === null || !removedIds.has(task.parentTaskId))
      .map((task) => {
        const count = beneath(task);
        return line(
          "removed",
          task,
          count === 0 ? "" : `, with ${plural(count, "task")} beneath it`,
        );
      }),
  ];
  return lines.length === 0
    ? ""
    : `Changed by other threads since you last read the tree:\n${lines.join("\n")}`;
};

/**
 * A goal_task_* mutation's answer. A bound thread gets its whole branch and the pulse (plus where an
 * add outside it landed); an unscoped thread the write under its ancestors (a rewrite: the tasks it
 * created), others' changes since `readAt`, and the pulse, all bullet-less so none is rewrite input.
 */
export const renderGoalTaskEcho = (input: {
  readonly summary: string;
  readonly tasks: ReadonlyArray<LoomGoalTask>;
  readonly deleted: ReadonlyArray<FlatGoalTask>;
  readonly anchorTaskId: GoalTaskId | null;
  /** When the thread last saw the tree; null = never recorded, so nothing reads as changed. */
  readonly readAt: IsoDateTime | null;
  readonly write: GoalTaskWrite;
}): string => {
  const { tasks, write } = input;
  const anchor = resolveThreadAnchor(tasks, input.anchorTaskId);
  if (anchor !== null) {
    const placed =
      write.kind !== "rewrite" && !isWithinGoalTaskBranch(anchor, write.taskId)
        ? findGoalTask(tasks, write.taskId)
        : null;
    return [
      input.summary,
      ...(placed === null
        ? []
        : [renderGoalTaskPlacement(goalTaskSpine(tasks, placed.id), placed)]),
      renderGoalTaskBranch(anchor, goalTaskSpine(tasks, anchor.id)),
      renderGoalPulse(tasks, anchor),
    ].join("\n\n");
  }
  const written = write.kind === "rewrite" ? null : findGoalTask(tasks, write.taskId);
  const spine = written === null ? [] : goalTaskSpine(tasks, written.id);
  const added = write.kind === "rewrite" ? renderMarkedPaths(tasks, write.minted).trimEnd() : "";
  return [
    input.summary,
    written === null
      ? ""
      : `Where it sits:\n${spine.length === 0 ? "" : `${renderSpine(spine)}\n`}${indent(spine.length)}${
          write.kind === "add" ? "+ " : `[${written.done ? "x" : " "}] `
        }${written.text} (${written.id})`,
    added.length === 0 ? "" : `Added, with the ids the server assigned:\n${added}`,
    renderOthersChanged(
      tasks,
      input.deleted,
      input.readAt,
      write.kind === "rewrite" ? write.touched : new Set([write.taskId]),
    ),
    renderGoalPulse(tasks, null),
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
};
