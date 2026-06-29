import { type ThreadId, type ThreadPlanLane } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { areDependenciesSatisfied, type DependencyGateThread } from "./workstreamDependencies.ts";

// The shared predicate consumed by BOTH the decider's first-turn invariant and
// the dispatcher's promote-ready pass, so execution gating and the client board
// can never disagree. These tests pin its sibling-scoped contract.

const parent = "parent-1" as ThreadId;

const node = (
  id: string,
  overrides: {
    readonly parentThreadId?: ThreadId | null;
    readonly blockedBy?: ReadonlyArray<ThreadId>;
    readonly planLane?: ThreadPlanLane;
  } = {},
): DependencyGateThread => ({
  id: id as ThreadId,
  parentThreadId: overrides.parentThreadId === undefined ? parent : overrides.parentThreadId,
  blockedBy: overrides.blockedBy ?? [],
  planLane: overrides.planLane ?? "planned",
});

const index = (nodes: ReadonlyArray<DependencyGateThread>) =>
  new Map(nodes.map((entry) => [entry.id, entry] as const));

describe("areDependenciesSatisfied", () => {
  it("is satisfied when there are no dependencies", () => {
    const thread = node("child");
    expect(areDependenciesSatisfied(thread, index([thread]))).toBe(true);
  });

  it("gates on a known sibling dependency that is not done", () => {
    const dep = node("dep", { planLane: "in_progress" });
    const thread = node("child", { blockedBy: [dep.id] });
    expect(areDependenciesSatisfied(thread, index([dep, thread]))).toBe(false);
  });

  it("releases once the sibling dependency is done (only `done` releases)", () => {
    const dep = node("dep", { planLane: "done" });
    const thread = node("child", { blockedBy: [dep.id] });
    expect(areDependenciesSatisfied(thread, index([dep, thread]))).toBe(true);
  });

  it("does not release on a `cancelled` dependency (an abandoned dep keeps dependents blocked)", () => {
    const dep = node("dep", { planLane: "cancelled" });
    const thread = node("child", { blockedBy: [dep.id] });
    expect(areDependenciesSatisfied(thread, index([dep, thread]))).toBe(false);
  });

  it("ignores a self-reference", () => {
    const thread = node("child", { blockedBy: ["child" as ThreadId] });
    expect(areDependenciesSatisfied(thread, index([thread]))).toBe(true);
  });

  it("ignores a dangling/unknown dependency id", () => {
    const thread = node("child", { blockedBy: ["ghost" as ThreadId] });
    expect(areDependenciesSatisfied(thread, index([thread]))).toBe(true);
  });

  it("does not gate on a non-sibling dependency (different parent)", () => {
    const cousin = node("cousin", {
      parentThreadId: "other-parent" as ThreadId,
      planLane: "in_progress",
    });
    const thread = node("child", { blockedBy: [cousin.id] });
    expect(areDependenciesSatisfied(thread, index([cousin, thread]))).toBe(true);
  });

  it("requires every sibling dependency to be done", () => {
    const a = node("dep-a", { planLane: "done" });
    const b = node("dep-b", { planLane: "in_progress" });
    const thread = node("child", { blockedBy: [a.id, b.id] });
    expect(areDependenciesSatisfied(thread, index([a, b, thread]))).toBe(false);
  });
});
