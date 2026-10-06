import { GoalId, ProjectId, type LoomGoalShell } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { v2ShellSnapshot } from "./orchestrationV2TestFixtures.ts";
import { applyShellStreamEvent, mergeShellSnapshotProjects } from "./shellReducer.ts";

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

  it("keep the goals held when an authoritative or resume snapshot carries none", () => {
    const held = { ...v2ShellSnapshot, goals: [goal("2026-10-05T00:00:02.000Z", "Held")] };
    // An authoritative snapshot from a server that did not send goals.
    expect(
      mergeShellSnapshotProjects(held, { ...v2ShellSnapshot, snapshotSequence: 7 }).goals,
    ).toBe(held.goals);
    // The afterSequence resume frame: a metadata-only enrichment snapshot without goals.
    expect(
      mergeShellSnapshotProjects(held, v2ShellSnapshot, { resolvedRepositoryIdentityRoots: [] })
        .goals,
    ).toBe(held.goals);
    // An authoritative snapshot WITH goals replaces them (the reconnect resync).
    expect(mergeShellSnapshotProjects(held, { ...v2ShellSnapshot, goals: [] }).goals).toEqual([]);
  });
});
