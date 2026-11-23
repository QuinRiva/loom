/**
 * loom: the Tasks tab's rows (§3 of plans/mobile-goal-tasks/plan.mdx). One walk of the goal's
 * tree decides what shows; the components only draw it. Reads structure only, so a running step
 * ticking over never re-runs it. Keys stay put when a neighbour is ticked.
 */
import { countGoalTasks } from "@t3tools/client-runtime/state/loom/goalTasks";
import type { LoomGoalTask, ThreadId } from "@t3tools/contracts";

export type TaskFilter = "todo" | "all";

/** An owning thread as the rules read it: live is no outcome yet, or a flag. */
export interface TaskThread {
  readonly id: ThreadId;
  readonly live: boolean;
}

export type GoalTaskRow =
  | {
      readonly kind: "caption";
      readonly key: string;
      readonly taskId: string;
      readonly text: string;
      readonly done: boolean;
    }
  | {
      readonly kind: "task";
      readonly key: string;
      readonly taskId: string;
      readonly depth: number;
      readonly text: string;
      readonly done: boolean;
      /** Over the tasks beneath, itself excluded; null without sub-tasks. */
      readonly count: { readonly done: number; readonly total: number } | null;
      readonly folded: boolean;
      readonly fullText: boolean;
      readonly marked: boolean;
    }
  | {
      readonly kind: "run";
      readonly key: string;
      readonly depth: number;
      readonly label: string;
      readonly open: boolean;
    }
  | {
      readonly kind: "thread";
      readonly key: string;
      readonly threadId: ThreadId;
      readonly depth: number;
      /** A finished thread: one muted line. */
      readonly quiet: boolean;
    }
  | {
      readonly kind: "threads";
      readonly key: string;
      readonly depth: number;
      readonly count: number;
      readonly open: boolean;
    };

type Tasks = ReadonlyArray<LoomGoalTask>;
type ThreadsByTask = ReadonlyMap<string, ReadonlyArray<TaskThread>>;

/** Tasks that are ticked, with every task beneath ticked and no live thread on or beneath them. */
export function finishedTaskIds(tasks: Tasks, threadsByTask: ThreadsByTask): ReadonlySet<string> {
  const finished = new Set<string>();
  const visit = (task: LoomGoalTask): boolean => {
    const children = task.children.map(visit);
    const ok =
      task.done &&
      children.every(Boolean) &&
      !(threadsByTask.get(task.id) ?? []).some((thread) => thread.live);
    if (ok) finished.add(task.id);
    return ok;
  };
  tasks.forEach(visit);
  return finished;
}

export function goalTaskRows(input: {
  readonly tasks: Tasks;
  readonly filter: TaskFilter;
  /** What the person opened or folded: "fold:<taskId>", "run:<first taskId>", "text:<taskId>", "threads:<taskId>". */
  readonly toggled: ReadonlySet<string>;
  readonly threadsByTask: ThreadsByTask;
  readonly markedTaskId: string | null;
}): ReadonlyArray<GoalTaskRow> {
  const { toggled, threadsByTask } = input;
  const finished = finishedTaskIds(input.tasks, threadsByTask);
  const rows: GoalTaskRow[] = [];
  const threadRow = (thread: TaskThread, depth: number, quiet: boolean) =>
    rows.push({ kind: "thread", key: `thread:${thread.id}`, threadId: thread.id, depth, quiet });

  const threads = (taskId: string, depth: number) => {
    const owners = threadsByTask.get(taskId) ?? [];
    const live = owners.filter((thread) => thread.live);
    const settled = owners.filter((thread) => !thread.live);
    for (const thread of live) threadRow(thread, depth, false);
    if (settled.length === 1 && live.length === 0) return threadRow(settled[0]!, depth, true);
    if (settled.length === 0) return;
    const key = `threads:${taskId}`;
    rows.push({ kind: "threads", key, depth, count: settled.length, open: toggled.has(key) });
    if (toggled.has(key)) for (const thread of settled) threadRow(thread, depth, true);
  };

  const task = (item: LoomGoalTask, depth: number, todo: boolean) => {
    const parent = item.children.length > 0;
    const folded = parent && toggled.has(`fold:${item.id}`);
    rows.push({
      kind: "task",
      key: item.id,
      taskId: item.id,
      depth,
      text: item.text,
      done: item.done,
      count: parent ? countGoalTasks(item.children) : null,
      folded,
      fullText: toggled.has(`text:${item.id}`),
      marked: item.id === input.markedTaskId,
    });
    if (folded) return;
    threads(item.id, depth + 1);
    siblings(item.children, depth + 1, todo);
  };

  const siblings = (tasks: Tasks, depth: number, todo: boolean) => {
    for (let at = 0; at < tasks.length;) {
      if (!todo || !finished.has(tasks[at]!.id)) {
        task(tasks[at]!, depth, todo);
        at += 1;
        continue;
      }
      let end = at;
      while (end < tasks.length && finished.has(tasks[end]!.id)) end += 1;
      const run = tasks.slice(at, end);
      const key = `run:${run[0]!.id}`;
      const size = countGoalTasks(run).total;
      rows.push({
        kind: "run",
        key,
        depth,
        label: size === 1 ? run[0]!.text : `${size} finished`,
        open: toggled.has(key),
      });
      // An opened run lists its tasks as All would.
      if (toggled.has(key)) for (const item of run) task(item, depth, false);
      at = end;
    }
  };

  const [lone] = input.tasks;
  // A lone top-level task restates the goal: it becomes a caption and its sub-tasks start at 0.
  if (input.tasks.length === 1 && lone!.children.length > 0) {
    rows.push({
      kind: "caption",
      key: lone!.id,
      taskId: lone!.id,
      text: lone!.text,
      done: lone!.done,
    });
    threads(lone!.id, 0);
    siblings(lone!.children, 0, input.filter === "todo");
  } else siblings(input.tasks, 0, input.filter === "todo");
  return rows;
}

/** `toggled` without the folds that hide `taskId`, so a jump to it lands on a visible row. */
export function unfoldTo(
  tasks: Tasks,
  taskId: string,
  toggled: ReadonlySet<string>,
): ReadonlySet<string> {
  const above = (list: Tasks, trail: ReadonlyArray<string>): ReadonlyArray<string> | null => {
    for (const item of list) {
      if (item.id === taskId) return trail;
      const found = above(item.children, [...trail, item.id]);
      if (found) return found;
    }
    return null;
  };
  const folds = (above(tasks, []) ?? [])
    .map((id) => `fold:${id}`)
    .filter((key) => toggled.has(key));
  if (folds.length === 0) return toggled;
  const next = new Set(toggled);
  for (const key of folds) next.delete(key);
  return next;
}
