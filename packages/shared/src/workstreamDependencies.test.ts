import { type ThreadId, type ThreadPlanLane } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  areDependenciesSatisfied,
  findDependencyCycle,
  type DependencyGateThread,
} from "./workstreamDependencies.ts";

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
    readonly isolation?: DependencyGateThread["isolation"];
    readonly fanInState?: DependencyGateThread["fanInState"];
  } = {},
): DependencyGateThread => ({
  id: id as ThreadId,
  parentThreadId: overrides.parentThreadId === undefined ? parent : overrides.parentThreadId,
  blockedBy: overrides.blockedBy ?? [],
  planLane: overrides.planLane ?? "planned",
  isolation: overrides.isolation ?? "shared",
  fanInState: overrides.fanInState ?? "none",
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
    // Submission-boundary validators reject this; the runtime predicate stays
    // permissive as a backstop for pre-existing or non-MCP data.
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

  // Worktree isolation (design §3): an isolated dependency must fan in cleanly
  // before dependents release — `done` alone does not.
  it("gates an isolated dependency that is done but has not fanned in", () => {
    const dep = node("dep", { planLane: "done", isolation: "isolated", fanInState: "none" });
    const thread = node("child", { blockedBy: [dep.id] });
    expect(areDependenciesSatisfied(thread, index([dep, thread]))).toBe(false);
  });

  it("releases an isolated dependency once its fan-in completed", () => {
    const dep = node("dep", { planLane: "done", isolation: "isolated", fanInState: "completed" });
    const thread = node("child", { blockedBy: [dep.id] });
    expect(areDependenciesSatisfied(thread, index([dep, thread]))).toBe(true);
  });

  it("keeps dependents blocked when an isolated dependency's fan-in conflicted", () => {
    const dep = node("dep", { planLane: "done", isolation: "isolated", fanInState: "conflicted" });
    const thread = node("child", { blockedBy: [dep.id] });
    expect(areDependenciesSatisfied(thread, index([dep, thread]))).toBe(false);
  });

  it("releases a shared dependency on done regardless of fan-in state", () => {
    const dep = node("dep", { planLane: "done", isolation: "shared", fanInState: "none" });
    const thread = node("child", { blockedBy: [dep.id] });
    expect(areDependenciesSatisfied(thread, index([dep, thread]))).toBe(true);
  });

  it("documents the gated-reviewer deadlock that attached isolation avoids", () => {
    const coder = node("coder", {
      planLane: "done",
      isolation: "isolated",
      fanInState: "none",
    });
    const sharedReviewer = node("reviewer-shared", {
      blockedBy: [coder.id],
      isolation: "shared",
    });
    const attachedReviewer = node("reviewer-attached", {
      blockedBy: [coder.id],
      isolation: "attached",
    });
    expect(areDependenciesSatisfied(sharedReviewer, index([coder, sharedReviewer]))).toBe(false);
    expect(areDependenciesSatisfied(attachedReviewer, index([coder, attachedReviewer]))).toBe(true);
  });

  // The fan-in propagation gap: a downstream thread gated on a gated reviewer
  // (the recommended "wire downstream on the reviewer" pattern) must not release
  // on the reviewer's `done` alone. The reviewer is `attached` (fan-in `none`),
  // but the coder it gates fans in asynchronously after gate resolution; the
  // dependent must wait for that coder's fan-in or it is provisioned off the
  // pre-merge parent branch.
  it("gates a dependent of a gated reviewer until the reviewed coder has fanned in", () => {
    const coder = node("coder", { planLane: "done", isolation: "isolated", fanInState: "none" });
    const reviewer = node("reviewer", {
      blockedBy: [coder.id],
      planLane: "done",
      isolation: "attached",
    });
    const downstream = node("downstream", { blockedBy: [reviewer.id], isolation: "isolated" });
    expect(areDependenciesSatisfied(downstream, index([coder, reviewer, downstream]))).toBe(false);
  });

  it("releases a dependent of a gated reviewer once the reviewed coder's fan-in completed", () => {
    const coder = node("coder", {
      planLane: "done",
      isolation: "isolated",
      fanInState: "completed",
    });
    const reviewer = node("reviewer", {
      blockedBy: [coder.id],
      planLane: "done",
      isolation: "attached",
    });
    const downstream = node("downstream", { blockedBy: [reviewer.id], isolation: "isolated" });
    expect(areDependenciesSatisfied(downstream, index([coder, reviewer, downstream]))).toBe(true);
  });

  it("keeps a dependent of a gated reviewer blocked when the reviewed coder's fan-in conflicted", () => {
    const coder = node("coder", {
      planLane: "done",
      isolation: "isolated",
      fanInState: "conflicted",
    });
    const reviewer = node("reviewer", {
      blockedBy: [coder.id],
      planLane: "done",
      isolation: "attached",
    });
    const downstream = node("downstream", { blockedBy: [reviewer.id], isolation: "isolated" });
    expect(areDependenciesSatisfied(downstream, index([coder, reviewer, downstream]))).toBe(false);
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
