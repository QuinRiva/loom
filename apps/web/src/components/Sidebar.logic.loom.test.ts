import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";

import { buildSidebarGoalOrderedEntries } from "./Sidebar.logic.loom";

// loom: §3 empty goal headers must not render. A goal only appears when it has
// (root, non-archived) threads in the list handed to the sidebar.

const thread = (id: string, goalId: string | null, updatedAt: string) => ({
  id: ThreadId.make(id),
  goalId,
  updatedAt,
  createdAt: updatedAt,
});

const goal = (id: string, updatedAt: string) => ({ id, updatedAt, createdAt: updatedAt });

describe("buildSidebarGoalOrderedEntries", () => {
  it("omits known goals that have no threads in the current list", () => {
    const entries = buildSidebarGoalOrderedEntries({
      threads: [thread("t1", "g-with", "2026-01-02T00:00:00.000Z")],
      goals: [
        goal("g-with", "2026-01-02T00:00:00.000Z"),
        goal("g-empty", "2026-01-03T00:00:00.000Z"),
      ],
      sortOrder: "updated_at",
    });

    const goalEntries = entries.filter((entry) => entry.kind === "goal");
    expect(goalEntries).toHaveLength(1);
    expect(goalEntries[0]).toMatchObject({ kind: "goal", goalId: "g-with" });
    expect(entries.some((e) => e.kind === "goal" && e.goalId === "g-empty")).toBe(false);
  });

  it("keeps a goal referenced only by a thread even if it is missing from goals", () => {
    const entries = buildSidebarGoalOrderedEntries({
      threads: [thread("t1", "g-orphan", "2026-01-02T00:00:00.000Z")],
      goals: [],
      sortOrder: "updated_at",
    });

    expect(entries).toEqual([
      { kind: "goal", goalId: "g-orphan", threads: [expect.objectContaining({ id: "t1" })] },
    ]);
  });

  it("still emits loose (goal-less) threads", () => {
    const entries = buildSidebarGoalOrderedEntries({
      threads: [thread("loose", null, "2026-01-02T00:00:00.000Z")],
      goals: [goal("g-empty", "2026-01-03T00:00:00.000Z")],
      sortOrder: "updated_at",
    });

    expect(entries).toEqual([{ kind: "thread", thread: expect.objectContaining({ id: "loose" }) }]);
  });
});
