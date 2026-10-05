import { GoalId, ProjectId, type LoomGoalShell } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { v2ShellSnapshot } from "./orchestrationV2TestFixtures.ts";
import { applyShellStreamEvent } from "./shellReducer.ts";

const goal = (updatedAt: string, title = "Goal"): LoomGoalShell => ({
  id: GoalId.make("goal-1"),
  projectId: ProjectId.make("project-1"),
  slug: "goal",
  title,
  description: "",
  tasks: [],
  createdAt: "2026-10-05T00:00:00.000Z",
  updatedAt,
  archivedAt: null,
});

describe("Loom goal shell items", () => {
  it("apply ungated by sequence, last write wins by updatedAt, and remove by id", () => {
    const snapshot = { ...v2ShellSnapshot, snapshotSequence: 99 };
    const first = applyShellStreamEvent(snapshot, {
      kind: "goal.updated",
      goal: goal("2026-10-05T00:00:02.000Z", "New"),
    });
    expect(first.goals?.map((entry) => entry.title)).toEqual(["New"]);
    expect(first.snapshotSequence).toBe(99);
    const stale = applyShellStreamEvent(first, {
      kind: "goal.updated",
      goal: goal("2026-10-05T00:00:01.000Z", "Stale"),
    });
    expect(stale).toBe(first);
    const removed = applyShellStreamEvent(first, {
      kind: "goal.removed",
      goalId: GoalId.make("goal-1"),
    });
    expect(removed.goals).toEqual([]);
  });
});
