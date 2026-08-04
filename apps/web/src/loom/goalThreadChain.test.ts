import { describe, expect, it } from "vite-plus/test";

import { orderGoalThreadsByHandoff } from "./goalThreadChain";

interface TestThread {
  readonly id: string;
  readonly continuesThreadId: string | null;
  readonly forkFromThreadId: string | null;
  readonly createdAt: string;
}

const thread = (
  id: string,
  createdAt: string,
  overrides: Partial<TestThread> = {},
): TestThread => ({
  id,
  continuesThreadId: null,
  forkFromThreadId: null,
  createdAt,
  ...overrides,
});

const ids = (threads: readonly TestThread[]) =>
  orderGoalThreadsByHandoff(threads).map((entry) => entry.thread.id);

describe("orderGoalThreadsByHandoff", () => {
  it("puts a chain in handoff order regardless of input order", () => {
    const first = thread("a", "2026-01-01T00:00:00.000Z");
    const second = thread("b", "2026-01-02T00:00:00.000Z", { continuesThreadId: "a" });
    const third = thread("c", "2026-01-03T00:00:00.000Z", { continuesThreadId: "b" });
    expect(ids([third, first, second])).toEqual(["a", "b", "c"]);
    expect(orderGoalThreadsByHandoff([third, first, second]).map((e) => e.isContinuation)).toEqual([
      false,
      true,
      true,
    ]);
  });

  it("orders parallel roots by creation, each followed by its own chain", () => {
    const rootOld = thread("old", "2026-01-01T00:00:00.000Z");
    const rootNew = thread("new", "2026-01-05T00:00:00.000Z");
    // The successor is the newest thread of all, yet stays under its predecessor.
    const successor = thread("old-2", "2026-01-09T00:00:00.000Z", { continuesThreadId: "old" });
    expect(ids([rootNew, successor, rootOld])).toEqual(["old", "old-2", "new"]);
  });

  it("orders sibling successors of one predecessor by creation", () => {
    const root = thread("a", "2026-01-01T00:00:00.000Z");
    const younger = thread("c", "2026-01-04T00:00:00.000Z", { continuesThreadId: "a" });
    const older = thread("b", "2026-01-02T00:00:00.000Z", { continuesThreadId: "a" });
    expect(ids([root, younger, older])).toEqual(["a", "b", "c"]);
  });

  it("does not treat a fork as a chain edge", () => {
    const source = thread("src", "2026-01-03T00:00:00.000Z");
    const fork = thread("fork", "2026-01-01T00:00:00.000Z", { forkFromThreadId: "src" });
    // Pure creation order: the fork is its own head, so it leads despite being
    // derived from a later-created thread.
    expect(ids([source, fork])).toEqual(["fork", "src"]);
    expect(orderGoalThreadsByHandoff([source, fork]).every((e) => !e.isContinuation)).toBe(true);
  });

  it("treats a thread whose predecessor is missing as a chain head", () => {
    const orphan = thread("b", "2026-01-02T00:00:00.000Z", { continuesThreadId: "gone" });
    const successor = thread("c", "2026-01-03T00:00:00.000Z", { continuesThreadId: "b" });
    const other = thread("a", "2026-01-01T00:00:00.000Z");
    const entries = orderGoalThreadsByHandoff([successor, orphan, other]);
    expect(entries.map((e) => e.thread.id)).toEqual(["a", "b", "c"]);
    expect(entries.map((e) => e.isContinuation)).toEqual([false, false, true]);
  });

  it("emits every thread exactly once when the chain contains a cycle", () => {
    const left = thread("a", "2026-01-01T00:00:00.000Z", { continuesThreadId: "b" });
    const right = thread("b", "2026-01-02T00:00:00.000Z", { continuesThreadId: "a" });
    const unrelated = thread("c", "2026-01-03T00:00:00.000Z");
    expect(ids([left, right, unrelated])).toEqual(["c", "a", "b"]);
  });

  it("ignores a self-referential predecessor", () => {
    const selfish = thread("a", "2026-01-01T00:00:00.000Z", { continuesThreadId: "a" });
    expect(orderGoalThreadsByHandoff([selfish])).toEqual([
      { thread: selfish, isContinuation: false },
    ]);
  });

  it("returns an empty list for no threads", () => {
    expect(orderGoalThreadsByHandoff([])).toEqual([]);
  });
});
