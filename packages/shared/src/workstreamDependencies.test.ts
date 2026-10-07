import type { LoomOutcome, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  areDependenciesSatisfied,
  deadlockedNodes,
  describeUnsatisfiedDependency,
  findDependencyCycle,
  type DependencyGateThread,
} from "./workstreamDependencies.ts";

// The shared predicate consumed by BOTH the decider's first-turn invariant and
// the dispatcher's promote-ready pass, so execution gating and the client graph
// can never disagree. These tests pin its sibling-scoped contract.

const parent = "parent-1" as ThreadId;

const node = (
  id: string,
  overrides: {
    readonly parentThreadId?: ThreadId | null;
    readonly blockedBy?: ReadonlyArray<ThreadId>;
    readonly outcome?: LoomOutcome | null;
  } = {},
): DependencyGateThread => ({
  id: id as ThreadId,
  parentThreadId: overrides.parentThreadId === undefined ? parent : overrides.parentThreadId,
  blockedBy: overrides.blockedBy ?? [],
  outcome: overrides.outcome ?? null,
});

const index = (nodes: ReadonlyArray<DependencyGateThread>) =>
  new Map(nodes.map((entry) => [entry.id, entry] as const));

describe("areDependenciesSatisfied", () => {
  it("is satisfied when there are no dependencies", () => {
    const thread = node("child");
    expect(areDependenciesSatisfied(thread, index([thread]))).toBe(true);
  });

  it("gates on a known sibling dependency that is not done", () => {
    const dep = node("dep", { outcome: null });
    const thread = node("child", { blockedBy: [dep.id] });
    expect(areDependenciesSatisfied(thread, index([dep, thread]))).toBe(false);
  });

  it("releases once the sibling dependency is done (only `done` releases)", () => {
    const dep = node("dep", { outcome: "done" });
    const thread = node("child", { blockedBy: [dep.id] });
    expect(areDependenciesSatisfied(thread, index([dep, thread]))).toBe(true);
  });

  it("does not release on a `cancelled` dependency (an abandoned dep keeps dependents blocked)", () => {
    const dep = node("dep", { outcome: "cancelled" });
    const thread = node("child", { blockedBy: [dep.id] });
    expect(areDependenciesSatisfied(thread, index([dep, thread]))).toBe(false);
  });

  it("ignores a self-reference", () => {
    const thread = node("child", { blockedBy: ["child" as ThreadId] });
    expect(areDependenciesSatisfied(thread, index([thread]))).toBe(true);
  });

  it("ignores a dangling/unknown dependency id", () => {
    // Submission-boundary validators reject this; the runtime predicate stays
    // permissive as a backstop for pre-existing or non-MCP data.
    const thread = node("child", { blockedBy: ["ghost" as ThreadId] });
    expect(areDependenciesSatisfied(thread, index([thread]))).toBe(true);
  });

  it("does not gate on a non-sibling dependency (different parent)", () => {
    const cousin = node("cousin", {
      parentThreadId: "other-parent" as ThreadId,
      outcome: null,
    });
    const thread = node("child", { blockedBy: [cousin.id] });
    expect(areDependenciesSatisfied(thread, index([cousin, thread]))).toBe(true);
  });

  it("requires every sibling dependency to be done", () => {
    const a = node("dep-a", { outcome: "done" });
    const b = node("dep-b", { outcome: null });
    const thread = node("child", { blockedBy: [a.id, b.id] });
    expect(areDependenciesSatisfied(thread, index([a, b, thread]))).toBe(false);
  });
});

describe("describeUnsatisfiedDependency (turn.start diagnosability)", () => {
  it("returns null when all dependencies are satisfied", () => {
    const dep = node("dep", { outcome: "done" });
    const thread = node("child", { blockedBy: [dep.id] });
    expect(describeUnsatisfiedDependency(thread, index([dep, thread]))).toBeNull();
  });

  it("names a not-done dependency", () => {
    const dep = node("dep", { outcome: null });
    const thread = node("child", { blockedBy: [dep.id] });
    expect(describeUnsatisfiedDependency(thread, index([dep, thread]))).toBe(
      "dependency 'dep' is not done yet",
    );
  });
});

describe("findDependencyCycle", () => {
  it("detects a 2-cycle with the repeated first node last", () => {
    const a = node("a", { blockedBy: ["b" as ThreadId] });
    const b = node("b", { blockedBy: ["a" as ThreadId] });
    expect(findDependencyCycle([a, b])).toEqual(["a", "b", "a"]);
  });

  it("detects a 3-cycle", () => {
    const a = node("a", { blockedBy: ["b" as ThreadId] });
    const b = node("b", { blockedBy: ["c" as ThreadId] });
    const c = node("c", { blockedBy: ["a" as ThreadId] });
    expect(findDependencyCycle([a, b, c])).toEqual(["a", "b", "c", "a"]);
  });

  it("does not report a diamond as cyclic", () => {
    const a = node("a", { blockedBy: ["b" as ThreadId, "c" as ThreadId] });
    const b = node("b", { blockedBy: ["c" as ThreadId] });
    const c = node("c");
    expect(findDependencyCycle([a, b, c])).toBeNull();
  });

  it("ignores cross-parent edges", () => {
    const a = node("a", { blockedBy: ["b" as ThreadId] });
    const b = node("b", {
      parentThreadId: "other-parent" as ThreadId,
      blockedBy: ["a" as ThreadId],
    });
    expect(findDependencyCycle([a, b])).toBeNull();
  });
});

describe("deadlockedNodes", () => {
  const ready = (
    id: string,
    blockedBy: ReadonlyArray<string> = [],
    overrides: {
      readonly held?: boolean;
      readonly kickoffAt?: string;
      readonly outcome?: LoomOutcome;
    } = {},
  ) => ({
    ...node(id, { blockedBy: blockedBy.map((dep) => dep as ThreadId) }),
    held: false,
    kickoffAt: null as string | null,
    ...overrides,
  });
  const byId = <T extends { readonly id: ThreadId }>(threads: ReadonlyArray<T>) =>
    new Map(threads.map((thread) => [thread.id, thread] as const));

  it("reports released, unstarted nodes that block each other", () => {
    const threads = [ready("a", ["b"]), ready("b", ["a"]), ready("c", [], { outcome: "done" })];
    expect(deadlockedNodes(threads, byId(threads))?.map((thread) => thread.id)).toEqual(["a", "b"]);
  });

  it("is not deadlocked with a held node, a started node, or a startable dependency", () => {
    const held = [ready("a", ["b"]), ready("b", ["a"], { held: true })];
    expect(deadlockedNodes(held, byId(held))).toBeNull();
    const started = [ready("a", ["b"]), ready("b", [], { kickoffAt: "2026-10-05T00:00:00Z" })];
    expect(deadlockedNodes(started, byId(started))).toBeNull();
    const startable = [ready("a", ["b"]), ready("b")];
    expect(deadlockedNodes(startable, byId(startable))).toBeNull();
  });

  it("reports a node wedged on a cancelled dependency", () => {
    const threads = [ready("a", ["b"]), ready("b", [], { outcome: "cancelled" })];
    expect(deadlockedNodes(threads, byId(threads))?.map((thread) => thread.id)).toEqual(["a"]);
  });
});
