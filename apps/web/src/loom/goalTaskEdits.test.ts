import { GoalId, GoalTaskId, type LoomGoalTask } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { goalTaskRewriteFor } from "./goalTaskEdits";

const task = (id: string, parent: string | null, children: LoomGoalTask[] = []): LoomGoalTask => ({
  id: GoalTaskId.make(id),
  goalId: GoalId.make("g"),
  parentTaskId: parent === null ? null : GoalTaskId.make(parent),
  text: id.toUpperCase(),
  done: false,
  position: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
  children,
});
const tree = [task("a", null, [task("a1", "a")]), task("b", null)];
const id = GoalTaskId.make;

describe("goalTaskRewriteFor", () => {
  it("submits the smallest branch that holds the edit", () => {
    expect(goalTaskRewriteFor(tree, { kind: "toggle", taskId: id("a1") })).toEqual({
      branchTaskId: "a1",
      tasks: [{ id: "a1", text: "A1", done: true, children: [] }],
    });
    expect(goalTaskRewriteFor(tree, { kind: "remove", taskId: id("a1") })).toEqual({
      branchTaskId: "a",
      tasks: [{ id: "a", text: "A", done: false, children: [] }],
    });
    expect(
      goalTaskRewriteFor(tree, { kind: "add", parentTaskId: id("a"), text: "New" })?.tasks[0]
        ?.children,
    ).toEqual([
      { id: "a1", text: "A1", done: false, children: [] },
      { text: "New", done: false, children: [] },
    ]);
  });

  it("submits the whole tree only for top-level adds and removals", () => {
    expect(goalTaskRewriteFor(tree, { kind: "remove", taskId: id("b") })?.branchTaskId).toBeNull();
    expect(
      goalTaskRewriteFor(tree, { kind: "add", parentTaskId: null, text: "C" })?.tasks,
    ).toHaveLength(3);
    expect(goalTaskRewriteFor(tree, { kind: "toggle", taskId: id("gone") })).toBeNull();
  });
});
