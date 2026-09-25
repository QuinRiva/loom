/**
 * LOOM-ONLY. The rules of task-tree branch scoping
 * (plans/task-tree-branch-scoping/plan.mdx): round-trip identity holds PER
 * SCOPE (a bound thread's branch view resubmitted to a branch rewrite is a
 * no-op), a branch rewrite can only reach inside the branch, the anchor is
 * undeletable and unmovable, and the elided open-plan view is mechanically
 * unusable as a rewrite submission rather than silently destructive.
 */
import { GoalId, GoalTaskId, type OrchestrationGoalTask } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  composeBranchRewrite,
  findGoalTask,
  goalTaskSpine,
  isWithinGoalTaskBranch,
  resolveThreadAnchor,
} from "./goalTaskAnchor.loom.ts";
import { parseGoalTaskMarkdown, resolveGoalTaskRewrite } from "./goalTaskMarkdown.ts";
import {
  renderGoalPulse,
  renderGoalTaskBranch,
  renderGoalTaskOverview,
  renderGoalTaskTree,
  renderOpenGoalTaskTree,
} from "./goalTaskRender.ts";
import { buildGoalTaskTree, flattenGoalTasks, type FlatGoalTask } from "./goalTaskTree.ts";

const goalId = GoalId.make("goal-branch");
const id = (value: string): GoalTaskId => GoalTaskId.make(value);

const flat = (input: {
  readonly id: string;
  readonly parentTaskId?: string;
  readonly text: string;
  readonly done?: boolean;
  readonly position: number;
}): FlatGoalTask => ({
  id: id(input.id),
  goalId,
  parentTaskId: input.parentTaskId === undefined ? null : id(input.parentTaskId),
  text: input.text,
  done: input.done ?? false,
  position: input.position,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-02-01T00:00:00.000Z",
});

// phase-1 (all done) · phase-6 = the anchor branch · phase-7 (a sibling branch)
const currentFlat: ReadonlyArray<FlatGoalTask> = [
  flat({ id: "phase-1", text: "Audit the usage pipeline", done: true, position: 0 }),
  flat({ id: "audit-a", parentTaskId: "phase-1", text: "Measure drift", done: true, position: 0 }),
  flat({
    id: "audit-b",
    parentTaskId: "phase-1",
    text: "Trace cacheRead",
    done: true,
    position: 1,
  }),
  flat({ id: "phase-6", text: "Surface usage on the thread screen", position: 1 }),
  flat({ id: "shape", parentTaskId: "phase-6", text: "Decide the shape", done: true, position: 0 }),
  flat({ id: "chip", parentTaskId: "phase-6", text: "Add the cost chip", position: 1 }),
  flat({ id: "zero", parentTaskId: "chip", text: "Handle zero-usage rows", position: 0 }),
  flat({ id: "phase-7", text: "Goal-level rollups", position: 2 }),
  flat({ id: "rollup", parentTaskId: "phase-7", text: "Design the rollup query", position: 0 }),
];
const tree: ReadonlyArray<OrchestrationGoalTask> = buildGoalTaskTree(currentFlat);
const knownIds = new Set(currentFlat.map((task) => task.id as string));
const anchor = findGoalTask(tree, id("phase-6"))!;

const parseOrThrow = (markdown: string) => {
  const parsed = parseGoalTaskMarkdown(markdown, knownIds);
  if ("error" in parsed) throw new Error(`expected a parse, got: ${parsed.error}`);
  return parsed.lines;
};

/** Submit `markdown` as a branch rewrite rooted at `anchor`. */
const branchRewrite = (markdown: string, branchAnchor: OrchestrationGoalTask = anchor) => {
  const composed = composeBranchRewrite({
    submitted: parseOrThrow(markdown),
    tasks: tree,
    anchor: branchAnchor,
  });
  if ("error" in composed) return composed;
  let next = 0;
  return resolveGoalTaskRewrite({
    lines: composed.lines,
    current: currentFlat,
    mintTaskId: () => id(`minted-${next++}`),
    now: "2026-03-03T00:00:00.000Z",
  });
};

/** The block a bound thread is told to edit: its branch, without the spine. */
const branchSource = renderGoalTaskTree([anchor]);

describe("anchor resolution", () => {
  it("degrades to unbound when the anchor task was deleted from the tree", () => {
    expect(resolveThreadAnchor(tree, null)).toBeNull();
    expect(resolveThreadAnchor(tree, id("gone"))).toBeNull();
    expect(resolveThreadAnchor(tree, id("phase-6"))?.text).toBe(
      "Surface usage on the thread screen",
    );
  });

  it("counts the anchor and its descendants as the branch, and nothing else", () => {
    expect(isWithinGoalTaskBranch(anchor, id("phase-6"))).toBe(true);
    expect(isWithinGoalTaskBranch(anchor, id("zero"))).toBe(true);
    expect(isWithinGoalTaskBranch(anchor, id("phase-7"))).toBe(false);
  });

  it("reads the spine outermost first, and empty for a top-level anchor", () => {
    expect(goalTaskSpine(tree, id("zero")).map((task) => task.id)).toEqual(["phase-6", "chip"]);
    expect(goalTaskSpine(tree, id("phase-6"))).toEqual([]);
  });
});

describe("branch round-trip identity", () => {
  it("resubmitting the branch view verbatim changes nothing in the goal", () => {
    const result = branchRewrite(branchSource);
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.changed).toBe(false);
    expect(result.tasks.map((task) => task.taskId)).toEqual(currentFlat.map((task) => task.id));
  });

  it("keeps the spine out of the rewrite source, so the view stays legal input", () => {
    const deep = findGoalTask(tree, id("chip"))!;
    const view = renderGoalTaskBranch(deep, goalTaskSpine(tree, deep.id));
    expect(view).toContain("read-only context, not rewrite input");
    const source = view.slice(view.indexOf("- ["));
    const result = branchRewrite(source, deep);
    expect("error" in result).toBe(false);
    if (!("error" in result)) expect(result.changed).toBe(false);
  });
});

describe("branch rewrite scope", () => {
  it("applies adds, renames, ticks and deletions inside the branch only", () => {
    const result = branchRewrite(
      [
        "- [x] Surface usage on the thread screen (phase-6)",
        "  - [x] Decide the shape (shape)",
        "  - [ ] Add the cost chip (chip)",
        "  - [ ] Verify against a seeded workstream",
      ].join("\n"),
    );
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.changed).toBe(true);
    // `zero` (inside the branch) is gone; both sibling branches are untouched.
    expect(result.tasks.map((task) => task.taskId)).toEqual([
      "phase-1",
      "audit-a",
      "audit-b",
      "phase-6",
      "shape",
      "chip",
      "minted-0",
      "phase-7",
      "rollup",
    ]);
    expect(result.tasks.find((task) => task.taskId === "phase-6")?.done).toBe(true);
    expect(result.summary).toContain("1 added");
    expect(result.summary).toContain("1 removed");
  });

  it("refuses a submission whose root line is not the anchor (undeletable, unmovable)", () => {
    const result = branchRewrite("- [ ] Add the cost chip (chip)");
    expect("error" in result && result.error).toContain("must be your anchor");
    expect("error" in result && result.error).toContain("cannot be deleted, replaced or moved");
  });

  it("refuses a whole-tree submission from a bound thread", () => {
    const result = branchRewrite(renderGoalTaskTree(tree));
    expect("error" in result && result.error).toContain("exactly one top-level line");
  });

  it("refuses a submission that reaches a task outside the branch", () => {
    const result = branchRewrite(
      [
        "- [ ] Surface usage on the thread screen (phase-6)",
        "  - [ ] Design the rollup query (rollup)",
      ].join("\n"),
    );
    expect("error" in result && result.error).toContain("outside the branch you own");
    expect("error" in result && result.error).toContain("goal_task_add");
  });

  it("lets the anchor be renamed and ticked in place", () => {
    const result = branchRewrite("- [x] Ship the thread-screen usage surface (phase-6)");
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    const phase6 = result.tasks.find((task) => task.taskId === "phase-6");
    expect(phase6).toMatchObject({ text: "Ship the thread-screen usage surface", done: true });
    expect(result.tasks.map((task) => task.taskId)).not.toContain("chip");
  });
});

describe("elided open plan", () => {
  it("collapses fully-done subtrees to their root line plus a marker", () => {
    const rendered = renderOpenGoalTaskTree(tree);
    expect(rendered).toContain("- [x] Audit the usage pipeline (phase-1)\n  … 2 done tasks elided");
    expect(rendered).not.toContain("Measure drift");
    expect(rendered).toContain("- [x] Decide the shape (shape)");
  });

  it("fails loudly when pasted into a rewrite instead of deleting the elided tasks", () => {
    const parsed = parseGoalTaskMarkdown(renderOpenGoalTaskTree(tree), knownIds);
    expect("error" in parsed && parsed.error).toContain("Could not parse this line as a task");
    expect("error" in parsed && parsed.error).toContain("done tasks elided");
  });
});

describe("goal pulse and overview", () => {
  it("counts open work outside the reader's branch", () => {
    expect(renderGoalPulse(tree, anchor)).toBe(
      "Goal pulse: 4/9 done · 5 open tasks · 2 open outside your branch",
    );
    expect(renderGoalPulse(tree, null)).toBe("Goal pulse: 4/9 done · 5 open tasks");
  });

  it("shows each phase with its subtree counts and never descends", () => {
    expect(renderGoalTaskOverview(tree)).toBe(
      [
        "[x] Audit the usage pipeline (phase-1) 2/2",
        "[ ] Surface usage on the thread screen (phase-6) 1/3",
        "[ ] Goal-level rollups (phase-7) 0/1",
      ].join("\n"),
    );
  });

  it("fails loudly when pasted into a rewrite: the counts trail the id, so no line may look editable", () => {
    const parsed = parseGoalTaskMarkdown(renderGoalTaskOverview(tree), knownIds);
    expect("error" in parsed && parsed.error).toContain("Could not parse this line as a task");
  });
});

describe("whole-tree rewrite is unchanged for the tree's owner", () => {
  it("still reproduces the rendered tree exactly", () => {
    const result = resolveGoalTaskRewrite({
      lines: parseOrThrow(renderGoalTaskTree(tree)),
      current: currentFlat,
      mintTaskId: () => id("unused"),
      now: "2026-03-03T00:00:00.000Z",
    });
    expect(result.changed).toBe(false);
    expect(result.tasks.map((task) => task.taskId)).toEqual(
      flattenGoalTasks(tree).map((task) => task.id),
    );
  });
});
