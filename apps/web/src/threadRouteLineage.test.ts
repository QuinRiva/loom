import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { buildThreadLineage } from "./threadRouteLineage";
import type { ThreadShell } from "./types";

const tid = (value: string) => ThreadId.make(value);

// The helper only reads parentThreadId / title / archivedAt, so a partial cast
// keeps the fixtures focused on the lineage-relevant fields.
function shell(
  id: string,
  parentThreadId: string | null,
  overrides: Partial<ThreadShell> = {},
): ThreadShell {
  return {
    id: tid(id),
    parentThreadId: parentThreadId === null ? null : tid(parentThreadId),
    title: `title-${id}`,
    archivedAt: null,
    ...overrides,
  } as ThreadShell;
}

function byId(...shells: ThreadShell[]): Record<ThreadId, ThreadShell> {
  return Object.fromEntries(shells.map((s) => [s.id, s])) as Record<ThreadId, ThreadShell>;
}

describe("buildThreadLineage", () => {
  it("returns ancestors root → parent for a nested chain", () => {
    const map = byId(shell("root", null), shell("mid", "root"), shell("leaf", "mid"));
    expect(buildThreadLineage(map, tid("leaf")).map((s) => s.threadId)).toEqual([
      tid("root"),
      tid("mid"),
    ]);
  });

  it("returns an empty chain for a top-level thread", () => {
    expect(buildThreadLineage(byId(shell("root", null)), tid("root"))).toEqual([]);
  });

  it("marks a missing immediate parent and stops the walk", () => {
    const result = buildThreadLineage(byId(shell("leaf", "ghost")), tid("leaf"));
    expect(result).toEqual([
      {
        threadId: tid("ghost"),
        title: "parent unavailable",
        archived: false,
        missing: true,
        isRoot: false,
      },
    ]);
  });

  it("flags archived ancestors", () => {
    const map = byId(
      shell("root", null, { archivedAt: "2026-01-02T00:00:00.000Z" }),
      shell("leaf", "root"),
    );
    expect(buildThreadLineage(map, tid("leaf"))[0]?.archived).toBe(true);
  });

  it("does not loop on a cycle", () => {
    const map = byId(shell("a", "b"), shell("b", "a"));
    const result = buildThreadLineage(map, tid("a"));
    expect(result.length).toBeLessThanOrEqual(2);
    expect(result.map((s) => s.threadId)).not.toContain(tid("a"));
  });

  it("caps very deep chains at maxDepth", () => {
    const shells = Array.from({ length: 50 }, (_, i) =>
      shell(`t${i}`, i === 0 ? null : `t${i - 1}`),
    );
    const result = buildThreadLineage(byId(...shells), tid("t49"), { maxDepth: 16 });
    expect(result).toHaveLength(16);
  });
});
