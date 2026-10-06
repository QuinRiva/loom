import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { buildThreadLineage, type LineageThread } from "./threadRouteLineage";

const tid = (value: string) => ThreadId.make(value);

function thread(
  id: string,
  parentThreadId: string | null,
  archived = false,
): [ThreadId, LineageThread] {
  return [
    tid(id),
    {
      parentThreadId: parentThreadId === null ? null : tid(parentThreadId),
      title: `title-${id}`,
      archived,
    },
  ];
}

const byId = (...threads: Array<[ThreadId, LineageThread]>) => new Map(threads);

describe("buildThreadLineage", () => {
  it("returns ancestors root → parent for a nested chain", () => {
    const map = byId(thread("root", null), thread("mid", "root"), thread("leaf", "mid"));
    expect(buildThreadLineage(map, tid("leaf")).map((s) => s.threadId)).toEqual([
      tid("root"),
      tid("mid"),
    ]);
  });

  it("returns an empty chain for a top-level thread", () => {
    expect(buildThreadLineage(byId(thread("root", null)), tid("root"))).toEqual([]);
  });

  it("marks a missing immediate parent and stops the walk", () => {
    expect(buildThreadLineage(byId(thread("leaf", "ghost")), tid("leaf"))).toEqual([
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
    const map = byId(thread("root", null, true), thread("leaf", "root"));
    expect(buildThreadLineage(map, tid("leaf"))[0]?.archived).toBe(true);
  });

  it("does not loop on a cycle", () => {
    const result = buildThreadLineage(byId(thread("a", "b"), thread("b", "a")), tid("a"));
    expect(result.length).toBeLessThanOrEqual(2);
    expect(result.map((s) => s.threadId)).not.toContain(tid("a"));
  });

  it("caps very deep chains at maxDepth", () => {
    const threads = Array.from({ length: 50 }, (_, i) =>
      thread(`t${i}`, i === 0 ? null : `t${i - 1}`),
    );
    expect(buildThreadLineage(byId(...threads), tid("t49"), { maxDepth: 16 })).toHaveLength(16);
  });
});
