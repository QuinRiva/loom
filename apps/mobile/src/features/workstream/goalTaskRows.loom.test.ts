import { GoalId, GoalTaskId, type LoomGoalTask, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type GoalTaskRow,
  goalTaskRows,
  type TaskFilter,
  type TaskThread,
  unfoldTo,
} from "./goalTaskRows.loom";

const AT = "2026-11-24T10:00:00.000Z";
const task = (id: string, done: boolean, children: LoomGoalTask[] = []): LoomGoalTask => ({
  id: GoalTaskId.make(id),
  goalId: GoalId.make("goal"),
  parentTaskId: null,
  text: `task ${id}`,
  done,
  position: 0,
  createdAt: AT as LoomGoalTask["createdAt"],
  updatedAt: AT as LoomGoalTask["updatedAt"],
  deletedAt: null,
  children,
});
const thread = (id: string, live: boolean): TaskThread => ({ id: ThreadId.make(id), live });

const rows = (
  tasks: LoomGoalTask[],
  options: {
    readonly filter?: TaskFilter;
    readonly toggled?: ReadonlyArray<string>;
    readonly threads?: Record<string, ReadonlyArray<TaskThread>>;
    readonly marked?: string;
  } = {},
) =>
  goalTaskRows({
    tasks,
    filter: options.filter ?? "todo",
    toggled: new Set(options.toggled ?? []),
    threadsByTask: new Map(Object.entries(options.threads ?? {})),
    markedTaskId: options.marked ?? null,
  });

/** One line per row: kind, depth and what tells it apart. */
const shape = (list: ReadonlyArray<GoalTaskRow>) =>
  list.map((row) => {
    switch (row.kind) {
      case "caption":
        return `caption ${row.taskId}`;
      case "task":
        return `${"  ".repeat(row.depth)}task ${row.taskId}${row.count ? ` ${row.count.done}/${row.count.total}` : ""}`;
      case "run":
        return `${"  ".repeat(row.depth)}run "${row.label}"${row.open ? " open" : ""}`;
      case "thread":
        return `${"  ".repeat(row.depth)}thread ${row.threadId}${row.quiet ? " quiet" : ""}`;
      case "threads":
        return `${"  ".repeat(row.depth)}threads ${row.count}${row.open ? " open" : ""}`;
    }
  });

describe("goalTaskRows", () => {
  it("folds a run of finished siblings to one row counting their subtrees; a lone finished leaf keeps its text", () => {
    const tree = [
      task("a", true, [task("a1", true), task("a2", true)]),
      task("b", true),
      task("c", false),
      task("d", true),
    ];
    expect(shape(rows(tree))).toEqual(['run "4 finished"', "task c", 'run "task d"']);
  });

  it("keeps a ticked parent with an open descendant as a row while its finished children fold", () => {
    const tree = [
      task("p", true, [task("p1", true), task("p2", true), task("p3", false)]),
      task("q", false),
    ];
    expect(shape(rows(tree))).toEqual(["task p 2/3", '  run "2 finished"', "  task p3", "task q"]);
  });

  it("keeps a finished task with a live thread visible, the thread under it", () => {
    const tree = [task("a", true), task("b", false)];
    const threads = { a: [thread("t1", true), thread("t0", false)] };
    expect(shape(rows(tree, { threads }))).toEqual([
      "task a",
      "  thread t1",
      "  threads 1",
      "task b",
    ]);
    expect(shape(rows(tree, { threads: { a: [thread("t0", false)] } }))).toEqual([
      'run "task a"',
      "task b",
    ]);
  });

  it("shows one settled owner as a quiet line and several behind a line that opens", () => {
    const tree = [task("a", false), task("b", false)];
    const threads = { a: [thread("t1", false)], b: [thread("t2", false), thread("t3", false)] };
    expect(shape(rows(tree, { threads, toggled: ["threads:b"] }))).toEqual([
      "task a",
      "  thread t1 quiet",
      "task b",
      "  threads 2 open",
      "  thread t2 quiet",
      "  thread t3 quiet",
    ]);
  });

  it("makes a lone top-level task a caption whose sub-tasks start at depth 0", () => {
    const tree = [task("top", false, [task("x", false, [task("x1", false)]), task("y", true)])];
    expect(shape(rows(tree))).toEqual(["caption top", "task x 0/1", "  task x1", 'run "task y"']);
    expect(shape(rows([task("only", false)]))).toEqual(["task only"]);
  });

  it("lists every task in tree order with no runs on All", () => {
    const tree = [
      task("a", true, [task("a1", true)]),
      task("b", false, [task("b1", true), task("b2", false)]),
    ];
    const all = rows(tree, { filter: "all" });
    expect(shape(all)).toEqual(["task a 1/1", "  task a1", "task b 1/2", "  task b1", "  task b2"]);
    expect(all.filter((row) => row.kind === "task" && row.done).map((row) => row.key)).toEqual([
      "a",
      "a1",
      "b1",
    ]);
  });

  it("opens a run in place as All lists it, and closes it again", () => {
    const tree = [task("a", true, [task("a1", true)]), task("b", true), task("c", false)];
    expect(shape(rows(tree, { toggled: ["run:a"] }))).toEqual([
      'run "3 finished" open',
      "task a 1/1",
      "  task a1",
      "task b",
      "task c",
    ]);
    expect(shape(rows(tree, { toggled: [] }))).toEqual(['run "3 finished"', "task c"]);
  });

  it("folds a parent's subtree to its one row on both filters", () => {
    const tree = [task("p", false, [task("p1", false, [task("p11", false)])]), task("q", false)];
    const threads = { p: [thread("t1", true)] };
    for (const filter of ["todo", "all"] as const) {
      const folded = rows(tree, { filter, threads, toggled: ["fold:p"] });
      expect(shape(folded)).toEqual(["task p 0/2", "task q"]);
      expect(folded[0]).toMatchObject({ folded: true });
    }
  });

  it("counts a parent's sub-tasks without itself, and marks and unclips by task", () => {
    const tree = [task("p", true, [task("p1", true), task("p2", false, [task("p21", true)])])];
    const [first, second] = rows([...tree, task("z", false)], {
      filter: "all",
      marked: "p1",
      toggled: ["text:p1"],
    });
    expect(first).toMatchObject({ kind: "task", count: { done: 2, total: 3 }, marked: false });
    expect(second).toMatchObject({
      kind: "task",
      taskId: "p1",
      count: null,
      marked: true,
      fullText: true,
    });
  });
});

describe("unfoldTo", () => {
  const tree = [task("a", false, [task("b", false, [task("c", false)])]), task("d", false)];

  it("removes exactly the folds above a task", () => {
    const toggled = new Set(["fold:a", "fold:b", "fold:c", "fold:d", "text:b"]);
    expect([...unfoldTo(tree, "c", toggled)]).toEqual(["fold:c", "fold:d", "text:b"]);
  });

  it("returns the same set when nothing hides the task", () => {
    const toggled = new Set(["fold:c"]);
    expect(unfoldTo(tree, "a", toggled)).toBe(toggled);
    expect(unfoldTo(tree, "missing", toggled)).toBe(toggled);
  });
});
