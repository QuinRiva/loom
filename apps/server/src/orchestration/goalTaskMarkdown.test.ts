/**
 * The rewrite contract's acceptance test: parsing `renderGoalTaskTree` output
 * reproduces the tree exactly, so `goal_task_list` output resubmitted verbatim
 * to `goal_tasks_rewrite` is a zero-change no-op. Everything else here is the
 * strict-on-meaning half of the parse rules (`plans/goal-task-tree-redesign/plan.mdx`).
 */
import { GoalId, GoalTaskId, type OrchestrationGoalTask } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { parseGoalTaskMarkdown, resolveGoalTaskRewrite } from "./goalTaskMarkdown.ts";
import { renderGoalTaskTree } from "./goalTaskRender.ts";
import { buildGoalTaskTree, type FlatGoalTask } from "./goalTaskTree.ts";

const goalId = GoalId.make("goal-markdown");
const uuid = (suffix: string): GoalTaskId =>
  GoalTaskId.make(`0000000${suffix}-0000-4000-8000-00000000000${suffix}`);

const flat = (input: {
  readonly id: string;
  readonly parentTaskId?: string;
  readonly text: string;
  readonly done?: boolean;
  readonly position: number;
}): FlatGoalTask => ({
  id: uuid(input.id),
  goalId,
  parentTaskId: input.parentTaskId === undefined ? null : uuid(input.parentTaskId),
  text: input.text,
  done: input.done ?? false,
  position: input.position,
  createdAt: `2026-01-0${input.position + 1}T00:00:00.000Z`,
  updatedAt: "2026-02-01T00:00:00.000Z",
});

// A realistic tree: nesting, done/open mix, a parenthetical in the text.
const currentFlat: ReadonlyArray<FlatGoalTask> = [
  flat({ id: "1", text: "Author the redesign plan", done: true, position: 0 }),
  flat({ id: "2", text: "Ship the rewrite tool (WP2)", position: 1 }),
  flat({ id: "3", parentTaskId: "2", text: "Markdown parse + diff", position: 0 }),
  flat({ id: "4", parentTaskId: "2", text: "HTTP handler", done: true, position: 1 }),
  flat({ id: "5", text: "Rewrite the guidance", position: 2 }),
];
const currentTree: ReadonlyArray<OrchestrationGoalTask> = buildGoalTaskTree(currentFlat);
const knownIds = new Set(currentFlat.map((task) => task.id as string));

const parseOrThrow = (markdown: string, ids: ReadonlySet<string> = knownIds) => {
  const parsed = parseGoalTaskMarkdown(markdown, ids);
  if ("error" in parsed) throw new Error(`expected a parse, got: ${parsed.error}`);
  return parsed.lines;
};

const errorOf = (markdown: string, ids: ReadonlySet<string> = knownIds): string => {
  const parsed = parseGoalTaskMarkdown(markdown, ids);
  if (!("error" in parsed)) throw new Error("expected a parse error");
  return parsed.error;
};

const rewrite = (markdown: string) =>
  resolveGoalTaskRewrite({
    lines: parseOrThrow(markdown),
    current: currentFlat,
    mintTaskId: (() => {
      let next = 0;
      return () => GoalTaskId.make(`minted-${next++}`);
    })(),
    now: "2026-03-03T00:00:00.000Z",
  });

describe("round-trip identity", () => {
  it("reproduces the rendered tree's flat task list exactly", () => {
    const { tasks, summary } = rewrite(renderGoalTaskTree(currentTree));
    expect(tasks).toEqual(
      currentFlat.map((task) => ({
        taskId: task.id,
        parentTaskId: task.parentTaskId,
        text: task.text,
        done: task.done,
        position: task.position,
        createdAt: task.createdAt,
      })),
    );
    expect(summary).toBe(
      "Rewrote the task tree: no changes (the submitted tree matches the current one).",
    );
  });

  it("re-renders identically after the rewrite is applied", () => {
    const { tasks } = rewrite(renderGoalTaskTree(currentTree));
    const applied = buildGoalTaskTree(
      tasks.map((task) => ({ ...task, id: task.taskId, goalId, updatedAt: task.createdAt })),
    );
    expect(renderGoalTaskTree(applied)).toBe(renderGoalTaskTree(currentTree));
  });
});

describe("parse rules", () => {
  it("restructures in one submission: re-nests, renames, done-marks, adds and drops", () => {
    const { tasks, summary } = rewrite(
      [
        `- [x] Author the redesign plan (${uuid("1")})`,
        `- [ ] Implementation (${uuid("2")})`,
        `  - [x] Markdown parse + diff (${uuid("3")})`,
        `  * [x] HTTP handler (${uuid("4")})`,
        "  - [ ] CLI subcommand",
      ].join("\n"),
    );
    expect(tasks.map((task) => [task.text, task.parentTaskId, task.position, task.done])).toEqual([
      ["Author the redesign plan", null, 0, true],
      ["Implementation", null, 1, false],
      ["Markdown parse + diff", uuid("2"), 0, true],
      ["HTTP handler", uuid("2"), 1, true],
      ["CLI subcommand", uuid("2"), 2, false],
    ]);
    // Retained ids keep their creation time; the new line gets a minted id.
    expect(tasks[1]!.createdAt).toBe("2026-01-02T00:00:00.000Z");
    expect(tasks[4]).toMatchObject({ taskId: "minted-0", createdAt: "2026-03-03T00:00:00.000Z" });
    // "Rewrite the guidance" was dropped; task 2 renamed; task 3 done-marked;
    // every retained task kept its parent and sibling slot, so nothing moved.
    expect(summary).toBe("Rewrote the task tree: 1 added, 2 edited, 1 removed.");
  });

  it("is tolerant of bullet, checkbox and indent style", () => {
    const lines = parseOrThrow(
      ["* Top", "\t- [X] Tab child", "    - [ ] Grandchild", "", "- [x]No space", ""].join("\n"),
      new Set(),
    );
    expect(lines).toEqual([
      { taskId: null, parentIndex: null, text: "Top", done: false, position: 0 },
      { taskId: null, parentIndex: 0, text: "Tab child", done: true, position: 0 },
      { taskId: null, parentIndex: 1, text: "Grandchild", done: false, position: 0 },
      { taskId: null, parentIndex: null, text: "No space", done: true, position: 1 },
    ]);
  });

  it("binds a line to the nearest shallower preceding line, not to its indent depth", () => {
    const lines = parseOrThrow(["- Parent", "      - Over-indented child"].join("\n"), new Set());
    expect(lines[1]).toMatchObject({ parentIndex: 0, position: 0 });
  });

  it("treats a non-uuid parenthetical as text and a line without an id as a new task", () => {
    const lines = parseOrThrow("- [ ] Ship the rewrite tool (WP2)", new Set());
    expect(lines[0]).toMatchObject({ taskId: null, text: "Ship the rewrite tool (WP2)" });
  });

  it("rejects an id that is not a task of this goal (a stale read)", () => {
    expect(errorOf(`- [ ] Ghost (${uuid("9")})`)).toContain("your view of the tree is stale");
  });

  it("rejects the same id on two lines", () => {
    expect(errorOf([`- A (${uuid("1")})`, `- B (${uuid("1")})`].join("\n"))).toContain(
      "appears on more than one line",
    );
  });

  it("rejects an unparseable line, naming it", () => {
    expect(errorOf(["- [ ] Fine", "Just a paragraph"].join("\n"))).toContain(
      'Could not parse this line as a task: "Just a paragraph"',
    );
  });

  it("rejects a line with an id but no text", () => {
    expect(errorOf(`- [x] (${uuid("1")})`)).toContain("has no task text");
  });

  it("rejects an empty submission", () => {
    expect(errorOf("   \n\n")).toContain("Wiping the whole task tree must be deliberate");
  });
});

describe("change summary", () => {
  it("counts a pure reorder as moved only", () => {
    const { summary } = rewrite(
      [
        `- [ ] Rewrite the guidance (${uuid("5")})`,
        `- [x] Author the redesign plan (${uuid("1")})`,
        `- [ ] Ship the rewrite tool (WP2) (${uuid("2")})`,
        `  - [ ] Markdown parse + diff (${uuid("3")})`,
        `  - [x] HTTP handler (${uuid("4")})`,
      ].join("\n"),
    );
    expect(summary).toBe("Rewrote the task tree: 3 moved.");
  });
});
