import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";

import {
  buildSidebarGoalOrderedEntries,
  buildSidebarProjectThreadOrdering,
} from "./Sidebar.logic.loom";
import { HANDOFF_DRAFTER_ROLE } from "../lib/handoffDrafter";

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

const orderingThread = (input: {
  id: string;
  role?: string | null;
  attention?: ReadonlyArray<string>;
  archivedAt?: string | null;
}) => ({
  id: ThreadId.make(input.id),
  goalId: null,
  updatedAt: "2026-01-02T00:00:00.000Z",
  createdAt: "2026-01-02T00:00:00.000Z",
  archivedAt: input.archivedAt ?? null,
  role: input.role ?? null,
  attention: input.attention ?? [],
});

describe("buildSidebarProjectThreadOrdering handoff-drafter visibility", () => {
  const order = (threads: ReturnType<typeof orderingThread>[]) =>
    buildSidebarProjectThreadOrdering({
      threads,
      goals: [],
      sortOrder: "updated_at",
      previewCount: 10,
      isThreadListExpanded: true,
      collapsedGoalIds: new Set<string>(),
      knownGoalIds: new Set<string>(),
    }).sortedThreads.map((t) => t.id);

  it("hides a healthy drafter but keeps ordinary threads", () => {
    const ids = order([
      orderingThread({ id: "normal" }),
      orderingThread({ id: "clean-drafter", role: HANDOFF_DRAFTER_ROLE }),
    ]);
    expect(ids).toContain("normal");
    expect(ids).not.toContain("clean-drafter");
  });

  it("surfaces a broken drafter that carries attention", () => {
    const ids = order([
      orderingThread({
        id: "broken-drafter",
        role: HANDOFF_DRAFTER_ROLE,
        attention: ["needs_guidance"],
      }),
    ]);
    expect(ids).toContain("broken-drafter");
  });
});
