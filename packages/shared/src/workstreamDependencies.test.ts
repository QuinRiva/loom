import { type ThreadId, type ThreadPlanLane } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  areDependenciesSatisfied,
  deadlockedNodes,
  describeUnsatisfiedDependency,
  findDependencyCycle,
  implicitGateEdges,
  type DependencyGateThread,
  type GatedDependencyThread,
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

describe("describeUnsatisfiedDependency (turn.start diagnosability)", () => {
  it("returns null when all dependencies are satisfied", () => {
    const dep = node("dep", { planLane: "done" });
    const thread = node("child", { blockedBy: [dep.id] });
    expect(describeUnsatisfiedDependency(thread, index([dep, thread]))).toBeNull();
  });

  it("names a not-done dependency and its lane", () => {
    const dep = node("dep", { planLane: "in_progress" });
    const thread = node("child", { blockedBy: [dep.id] });
    expect(describeUnsatisfiedDependency(thread, index([dep, thread]))).toBe(
      "dependency 'dep' is not done yet (lane: in_progress)",
    );
  });

  // The incident's misleading rejection: every listed dep reads `done`, but the
  // real block is a gated coder's unsettled fan-in two hops away. The message
  // must name that coder and its fan-in state, not "until every dependency is done".
  it("names the reviewed coder whose fan-in has not completed (two hops away)", () => {
    const coder = node("coder-ab244688", {
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
    expect(describeUnsatisfiedDependency(downstream, index([coder, reviewer, downstream]))).toBe(
      "reviewer 'reviewer' is done, but the coder 'coder-ab244688' it gates has not completed fan-in (fanInState: conflicted)",
    );
  });

  it("names an isolated dependency whose own fan-in has not completed", () => {
    const dep = node("dep", { planLane: "done", isolation: "isolated", fanInState: "conflicted" });
    const thread = node("child", { blockedBy: [dep.id] });
    expect(describeUnsatisfiedDependency(thread, index([dep, thread]))).toBe(
      "dependency 'dep' is done, but its fan-in has not completed (fanInState: conflicted)",
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

// Issue #280, replayed on the incident's graph at 12:36Z: author (isolated,
// done, fan-in never ran) is reviewed by skill-review, which waits on
// script-review, which waits on the coder, which waits on the author's fan-in.
describe("issue #280: implicit gate edges + deadlock", () => {
  const gated = (
    id: string,
    overrides: Parameters<typeof node>[1] & { readonly loopTo?: string } = {},
  ): GatedDependencyThread => ({
    ...node(id, { planLane: "ready", isolation: "isolated", ...overrides }),
    routes:
      overrides.loopTo === undefined
        ? []
        : [{ on: ["needs_rework"], kind: "loop", to: overrides.loopTo as ThreadId }],
  });
  const id = (value: string) => value as ThreadId;
  const byId = (threads: ReadonlyArray<GatedDependencyThread>) =>
    new Map(threads.map((thread) => [thread.id, thread] as const));
  const incident = (authorFanIn: DependencyGateThread["fanInState"] = "none") => [
    gated("researcher", { planLane: "done", isolation: "shared" }),
    gated("author", { planLane: "done", blockedBy: [id("researcher")], fanInState: authorFanIn }),
    gated("coder", { blockedBy: [id("author")] }),
    gated("script-review", { isolation: "attached", blockedBy: [id("coder")], loopTo: "coder" }),
    gated("skill-review", {
      isolation: "attached",
      blockedBy: [id("script-review"), id("author")],
      loopTo: "author",
    }),
  ];

  it("finds exactly the hidden coder → skill-review edge, which closes the cycle", () => {
    const threads = incident();
    expect(findDependencyCycle(threads)).toBeNull();
    const edges = implicitGateEdges(threads);
    expect(edges).toEqual([{ from: id("coder"), to: id("skill-review"), via: id("author") }]);
    const explicit = threads.map((thread) =>
      thread.id === id("coder")
        ? { ...thread, blockedBy: [...thread.blockedBy, edges[0]!.to] }
        : thread,
    );
    expect(findDependencyCycle(explicit)).toEqual([
      id("coder"),
      id("skill-review"),
      id("script-review"),
      id("coder"),
    ]);
  });

  it("reports the stuck nodes as deadlocked", () => {
    const threads = incident();
    expect(deadlockedNodes(threads, byId(threads))?.map((thread) => thread.id)).toEqual([
      id("coder"),
      id("script-review"),
      id("skill-review"),
    ]);
  });

  it("is not deadlocked while an ungated fan-in is un-landed (due, conflicted, failed), nor with a held node", () => {
    // Same shape minus the gate: the author's fan-in will land on its own.
    const ungated = incident().map((thread) =>
      thread.id === id("skill-review") ? { ...thread, routes: [] } : thread,
    );
    expect(deadlockedNodes(ungated, byId(ungated))).toBeNull();
    const held = incident().map((thread) =>
      thread.id === id("coder") ? { ...thread, planLane: "planned" as const } : thread,
    );
    expect(deadlockedNodes(held, byId(held))).toBeNull();
    // A conflicted/failed fan-in is stuck, but the fan-in rails own it and the
    // way out is the merge, not re-planning: not a deadlock.
    for (const fanInState of ["conflicted", "failed"] as const) {
      const settled = ungated.map((thread) =>
        thread.id === id("author") ? { ...thread, fanInState } : thread,
      );
      expect(deadlockedNodes(settled, byId(settled))).toBeNull();
    }
    // Once the gate-held author's reviewer is itself stuck, it is a deadlock again.
    const conflictedButGated = incident("conflicted");
    expect(deadlockedNodes(conflictedButGated, byId(conflictedButGated))).not.toBeNull();
  });
});
