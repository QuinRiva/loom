import type {
  LoomAttentionReason,
  LoomOutcome,
  ThreadId,
  WorkOutcomeDecision,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  childrenOf,
  descendantsOf,
  type GateNode,
  graphViewFor,
  type GraphViewThread,
  holdErasedByCompletion,
  isMemberOfUnresolvedGate,
  isTerminalForJoin,
  isWaitingInGate,
  requiresSubmitToComplete,
  rootOf,
  routeWorkSubmit,
  subtreeCostOf,
  subtreeOf,
} from "./workstreamGraph.ts";

const tid = (id: string) => id as ThreadId;

const node = (
  overrides: Omit<Partial<GraphViewThread>, "id"> & { readonly id: string },
): GraphViewThread => ({
  parentThreadId: null,
  spawnGeneration: null,
  outcome: null,
  held: false,
  kickoffAt: null,
  attention: [],
  role: null,
  title: null,
  purpose: null,
  graphKey: null,
  reportPath: null,
  blockedBy: [],
  lastActivityAt: null,
  lastActivitySummary: null,
  ...overrides,
  id: tid(overrides.id),
});

// A small two-tree fixture:
//   root-a → (child-1, child-2 → grandchild)
//   root-b → other
const tree = [
  node({ id: "root-a" }),
  node({ id: "child-1", parentThreadId: tid("root-a") }),
  node({ id: "child-2", parentThreadId: tid("root-a") }),
  node({ id: "grandchild", parentThreadId: tid("child-2") }),
  node({ id: "root-b" }),
  node({ id: "other", parentThreadId: tid("root-b") }),
];

describe("structural queries", () => {
  it("childrenOf returns only direct children", () => {
    expect(
      childrenOf(tid("root-a"), tree)
        .map((t) => t.id)
        .sort(),
    ).toEqual(["child-1", "child-2"]);
    expect(childrenOf(tid("grandchild"), tree)).toEqual([]);
  });

  it("descendantsOf returns all transitive descendants (excluding self)", () => {
    expect(
      descendantsOf(tid("root-a"), tree)
        .map((t) => t.id)
        .sort(),
    ).toEqual(["child-1", "child-2", "grandchild"]);
  });

  it("subtreeOf includes the node and its descendants", () => {
    expect(
      subtreeOf(tid("child-2"), tree)
        .map((t) => t.id)
        .sort(),
    ).toEqual(["child-2", "grandchild"]);
  });

  it("tolerates a missing root node (singleton subtree)", () => {
    expect(subtreeOf(tid("ghost"), tree)).toEqual([]);
  });

  it("rootOf walks lineage up to the top-most ancestor from any member", () => {
    expect(rootOf(tid("grandchild"), tree)).toBe("root-a");
    expect(rootOf(tid("child-1"), tree)).toBe("root-a");
    expect(rootOf(tid("root-a"), tree)).toBe("root-a");
    expect(rootOf(tid("other"), tree)).toBe("root-b");
  });

  it("rootOf treats an unknown node, or one with a dangling parent, as its own root", () => {
    expect(rootOf(tid("ghost"), tree)).toBe("ghost");
    expect(rootOf(tid("orphan"), [node({ id: "orphan", parentThreadId: tid("gone") })])).toBe(
      "orphan",
    );
  });

  it("rootOf breaks a lineage cycle with the visited guard", () => {
    const cycle = [
      node({ id: "a", parentThreadId: tid("b") }),
      node({ id: "b", parentThreadId: tid("a") }),
    ];
    expect(rootOf(tid("a"), cycle)).toBe("a");
  });
});

describe("subtreeCostOf", () => {
  const costNode = (
    id: string,
    parentThreadId: string | null,
    cumulativeCostUsd: number | null,
  ) => ({
    id: tid(id),
    parentThreadId: parentThreadId === null ? null : tid(parentThreadId),
    cumulativeCostUsd,
  });
  // root-a($1) → child-1($2), child-2($4) → grandchild($8); root-b($16)
  const costTree = [
    costNode("root-a", null, 1),
    costNode("child-1", "root-a", 2),
    costNode("child-2", "root-a", 4),
    costNode("grandchild", "child-2", 8),
    costNode("root-b", null, 16),
  ];

  it("sums the node plus all descendants", () => {
    expect(subtreeCostOf(tid("root-a"), costTree)).toBe(15);
    expect(subtreeCostOf(tid("child-2"), costTree)).toBe(12);
  });

  it("a leaf is just its own cost", () => {
    expect(subtreeCostOf(tid("grandchild"), costTree)).toBe(8);
  });

  it("treats null/absent cost as 0 and a missing node as 0", () => {
    expect(subtreeCostOf(tid("ghost"), costTree)).toBe(0);
    expect(subtreeCostOf(tid("a"), [costNode("a", null, null), costNode("b", "a", 3)])).toBe(3);
  });
});

// Join nodes carry runtime state the terminal-for-join predicate must ignore,
// on top of outcome + attention.
const joinNode = (overrides: {
  readonly id?: string;
  readonly parentThreadId?: ThreadId | null;
  readonly spawnGeneration?: string | null;
  readonly outcome?: LoomOutcome | null;
  readonly attention?: ReadonlyArray<LoomAttentionReason>;
  readonly executing?: boolean;
}) => ({
  id: tid(overrides.id ?? "n"),
  parentThreadId:
    overrides.parentThreadId === undefined ? tid("parent-1") : overrides.parentThreadId,
  spawnGeneration: overrides.spawnGeneration ?? null,
  outcome: overrides.outcome ?? null,
  attention: overrides.attention ?? [],
  session: overrides.executing ? { status: "running" } : null,
  latestTurn: overrides.executing ? { state: "running" } : null,
});

describe("isTerminalForJoin", () => {
  it("treats done and cancelled as terminal", () => {
    expect(isTerminalForJoin(joinNode({ outcome: "done" }))).toBe(true);
    expect(isTerminalForJoin(joinNode({ outcome: "cancelled" }))).toBe(true);
  });

  it("does NOT treat an attention-flagged node as terminal — a pause is not a result", () => {
    expect(isTerminalForJoin(joinNode({ attention: ["needs_guidance"] }))).toBe(false);
    expect(isTerminalForJoin(joinNode({ attention: ["awaiting_orchestrator"] }))).toBe(false);
    expect(isTerminalForJoin(joinNode({ attention: ["error"], executing: true }))).toBe(false);
  });

  it("does NOT treat an open, unflagged node as terminal", () => {
    expect(isTerminalForJoin(joinNode({}))).toBe(false);
  });
});

describe("graphViewFor", () => {
  it("returns the caller's whole tree from any member, with lineage + report flags", () => {
    const withReport = [
      node({ id: "root-a", role: "orchestrator", title: "Root" }),
      node({
        id: "child-1",
        parentThreadId: tid("root-a"),
        role: "coder",
        reportPath: "child-1.md",
      }),
      node({ id: "child-2", parentThreadId: tid("root-a"), role: "reviewer" }),
      node({ id: "grandchild", parentThreadId: tid("child-2") }),
      node({ id: "root-b" }),
      node({ id: "other", parentThreadId: tid("root-b") }),
    ];
    // Called from a child, it still returns the full tree (discovery for siblings).
    const view = graphViewFor(tid("child-1"), withReport);
    expect(view.rootId).toBe("root-a");
    expect(view.nodes.map((n) => n.id).sort()).toEqual([
      "child-1",
      "child-2",
      "grandchild",
      "root-a",
    ]);
    // Out-of-tree threads are excluded.
    expect(view.nodes.some((n) => n.id === "other")).toBe(false);
    expect(view.nodes.find((n) => n.id === "child-1")?.hasReport).toBe(true);
    expect(view.nodes.find((n) => n.id === "child-2")?.hasReport).toBe(false);
    // Scaffold shape-review fields are projected through to the node.
    const scaffolded = graphViewFor(tid("root-a"), [
      node({ id: "root-a", role: "orchestrator" }),
      node({
        id: "child-1",
        parentThreadId: tid("root-a"),
        graphKey: "api",
        purpose: "Adds the merge endpoint.",
      }),
    ]).nodes.find((n) => n.id === "child-1");
    expect(scaffolded?.graphKey).toBe("api");
    expect(scaffolded?.purpose).toBe("Adds the merge endpoint.");
    expect(view.lineageEdges).toContainEqual({ from: tid("root-a"), to: tid("child-1") });
    expect(view.lineageEdges).toContainEqual({ from: tid("child-2"), to: tid("grandchild") });
  });

  it("emits waits-on edges only for in-tree dependencies", () => {
    const withDeps = [
      node({ id: "root-a" }),
      node({ id: "coder", parentThreadId: tid("root-a") }),
      node({
        id: "reviewer",
        parentThreadId: tid("root-a"),
        blockedBy: [tid("coder"), tid("ghost")],
      }),
    ];
    const view = graphViewFor(tid("reviewer"), withDeps);
    expect(view.waitsOnEdges).toEqual([{ from: tid("reviewer"), to: tid("coder") }]);
  });

  it("widens scope across fork provenance: a parentless fork root sees its source's tree", () => {
    const withFork = [
      node({ id: "root-a", role: "orchestrator" }),
      node({ id: "child-1", parentThreadId: tid("root-a"), role: "coder" }),
      node({ id: "retro", role: "retro-reviewer", forkFromThreadId: tid("root-a") }),
      node({ id: "root-b" }),
    ];
    // Called from the fork, the view is rooted at the SOURCE's root and includes
    // the whole source tree plus the fork itself.
    const view = graphViewFor(tid("retro"), withFork);
    expect(view.rootId).toBe("root-a");
    expect(view.nodes.map((n) => n.id).sort()).toEqual(["child-1", "retro", "root-a"]);
    // The fork stays a ROOT in the emitted shape — no lineage edge to it.
    expect(view.nodes.find((n) => n.id === "retro")?.parentThreadId).toBeNull();
    expect(view.lineageEdges.some((e) => e.to === tid("retro"))).toBe(false);
    // And the source tree sees the fork symmetrically.
    const fromSource = graphViewFor(tid("child-1"), withFork);
    expect(fromSource.nodes.some((n) => n.id === "retro")).toBe(true);
  });

  it("forked-from-a-child fork joins that child's whole tree", () => {
    const withFork = [
      node({ id: "root-a" }),
      node({ id: "child-1", parentThreadId: tid("root-a") }),
      node({ id: "fork", forkFromThreadId: tid("child-1") }),
    ];
    const view = graphViewFor(tid("fork"), withFork);
    expect(view.rootId).toBe("root-a");
    expect(view.nodes.map((n) => n.id).sort()).toEqual(["child-1", "fork", "root-a"]);
  });

  it("ignores a dangling fork source (fork stays its own root)", () => {
    const view = graphViewFor(tid("fork"), [node({ id: "fork", forkFromThreadId: tid("gone") })]);
    expect(view.rootId).toBe("fork");
    expect(view.nodes.map((n) => n.id)).toEqual(["fork"]);
  });
});

// ---------------------------------------------------------------------------
// Review gates (docs/design/workstream-review-gates.md §4–§6)
// ---------------------------------------------------------------------------

const gnode = (overrides: Omit<Partial<GateNode>, "id"> & { readonly id: string }): GateNode => ({
  outcome: null,
  routes: [],
  gateRounds: 0,
  pendingRework: false,
  lastOutcome: null,
  ...overrides,
  id: tid(overrides.id),
});

const loopRoutes = (to: string, maxRounds?: number): GateNode["routes"] => [
  {
    on: ["needs_rework"],
    kind: "loop",
    to: tid(to),
    ...(maxRounds !== undefined ? { maxRounds } : {}),
  },
  { on: ["clean", "fixed_inline"], kind: "resolve" },
];

const byId = (threads: ReadonlyArray<GateNode>) => new Map(threads.map((t) => [t.id, t] as const));

describe("routeWorkSubmit", () => {
  it("routes plain done to terminal and unknown outcomes to yield (no routes anywhere)", () => {
    const t = gnode({ id: "t" });
    expect(routeWorkSubmit(t, [t], "done")).toMatchObject({ decision: "terminal", round: 0 });
    expect(routeWorkSubmit(t, [t], "rework_approach")).toMatchObject({ decision: "yield" });
  });

  it("routes needs_human to attention even for a gate source (reserved token wins)", () => {
    const coder = gnode({ id: "coder", outcome: "done" });
    const reviewer = gnode({ id: "reviewer", routes: loopRoutes("coder") });
    expect(routeWorkSubmit(reviewer, [reviewer, coder], "needs_human")).toMatchObject({
      decision: "attention",
    });
  });

  it("loops needs_rework to the coder while rounds remain, advancing the round", () => {
    const coder = gnode({ id: "coder", outcome: "done" });
    const reviewer = gnode({ id: "reviewer", routes: loopRoutes("coder") });
    expect(routeWorkSubmit(reviewer, [reviewer, coder], "needs_rework")).toEqual({
      decision: "loop",
      round: 1,
      routeTo: tid("coder"),
      resolveWith: null,
    });
  });

  it("breaches at the cap: needs_rework with gateRounds === maxRounds yields as cap-breach", () => {
    const coder = gnode({ id: "coder", outcome: null });
    const reviewer = gnode({ id: "reviewer", routes: loopRoutes("coder", 2), gateRounds: 2 });
    expect(routeWorkSubmit(reviewer, [reviewer, coder], "needs_rework")).toMatchObject({
      decision: "cap-breach",
      round: 2,
      routeTo: null,
    });
  });

  it("R4: a cancelled (or missing) loop target degrades needs_rework to a yield", () => {
    const coder = gnode({ id: "coder", outcome: "cancelled" });
    const reviewer = gnode({ id: "reviewer", routes: loopRoutes("coder") });
    expect(routeWorkSubmit(reviewer, [reviewer, coder], "needs_rework")).toMatchObject({
      decision: "yield",
    });
    expect(routeWorkSubmit(reviewer, [reviewer], "needs_rework")).toMatchObject({
      decision: "yield",
    });
  });

  it("resolves clean/fixed_inline, completing a non-terminal counterpart alongside", () => {
    const coder = gnode({ id: "coder", outcome: null });
    const reviewer = gnode({ id: "reviewer", routes: loopRoutes("coder") });
    expect(routeWorkSubmit(reviewer, [reviewer, coder], "clean")).toMatchObject({
      decision: "resolve",
      resolveWith: tid("coder"),
    });
    expect(routeWorkSubmit(reviewer, [reviewer, coder], "fixed_inline")).toMatchObject({
      decision: "resolve",
      resolveWith: tid("coder"),
    });
  });

  it("resolve leaves an already-done counterpart alone (round 0, no loop ever taken)", () => {
    const coder = gnode({ id: "coder", outcome: "done" });
    const reviewer = gnode({ id: "reviewer", routes: loopRoutes("coder") });
    expect(routeWorkSubmit(reviewer, [reviewer, coder], "clean")).toMatchObject({
      decision: "resolve",
      resolveWith: null,
    });
  });

  it("intercepts any rework-round outcome, routing back to the source", () => {
    const reviewer = gnode({ id: "reviewer", routes: loopRoutes("coder"), gateRounds: 1 });
    const coder = gnode({ id: "coder", pendingRework: true });
    for (const outcome of ["done", "fixed", "findings_unimplementable"]) {
      expect(routeWorkSubmit(coder, [reviewer, coder], outcome)).toEqual({
        decision: "loop",
        round: 1,
        routeTo: tid("reviewer"),
        resolveWith: null,
      });
    }
  });

  it("does NOT intercept when the gate dissolved (source terminal) — done is plain terminal", () => {
    const reviewer = gnode({ id: "reviewer", routes: loopRoutes("coder"), outcome: "done" });
    const coder = gnode({ id: "coder", pendingRework: true });
    expect(routeWorkSubmit(coder, [reviewer, coder], "done")).toMatchObject({
      decision: "terminal",
    });
  });

  it("routes the reserved quiescent outcome to yield, before the rework interception", () => {
    const reviewer = gnode({ id: "reviewer", routes: loopRoutes("coder"), gateRounds: 1 });
    const coder = gnode({ id: "coder", pendingRework: true });
    expect(routeWorkSubmit(coder, [reviewer, coder], "quiescent")).toEqual({
      decision: "yield",
      round: 0,
      routeTo: null,
      resolveWith: null,
    });
    // A quiet gate source never loops or resolves its gate either.
    expect(routeWorkSubmit(reviewer, [reviewer, coder], "quiescent")).toMatchObject({
      decision: "yield",
    });
  });

  it("needs_human still raises attention from a rework round", () => {
    const reviewer = gnode({ id: "reviewer", routes: loopRoutes("coder"), gateRounds: 1 });
    const coder = gnode({ id: "coder", pendingRework: true });
    expect(routeWorkSubmit(coder, [reviewer, coder], "needs_human")).toMatchObject({
      decision: "attention",
    });
  });
});

describe("isWaitingInGate", () => {
  it("suppresses the source while its target holds an open rework round", () => {
    const reviewer = gnode({ id: "reviewer", routes: loopRoutes("coder"), gateRounds: 1 });
    const coder = gnode({ id: "coder", pendingRework: true });
    expect(isWaitingInGate(reviewer, byId([reviewer, coder]))).toBe(true);
  });

  it("suppresses the routed-back target while the source owes the re-verify", () => {
    const reviewer = gnode({ id: "reviewer", routes: loopRoutes("coder"), gateRounds: 1 });
    const coder = gnode({
      id: "coder",
      pendingRework: false,
      lastOutcome: { decision: "loop" },
    });
    expect(isWaitingInGate(coder, byId([reviewer, coder]))).toBe(true);
  });

  it("suppresses the source after its loop verdict while the target remains non-terminal", () => {
    const reviewer = gnode({
      id: "reviewer",
      routes: loopRoutes("coder"),
      gateRounds: 1,
      lastOutcome: { decision: "loop" },
    });
    const coder = gnode({ id: "coder", pendingRework: false });
    expect(isWaitingInGate(reviewer, byId([reviewer, coder]))).toBe(true);
  });

  it("does not suppress a source whose loop target is plain terminal done", () => {
    const reviewer = gnode({
      id: "reviewer",
      routes: loopRoutes("coder"),
      gateRounds: 1,
      lastOutcome: { decision: "loop" },
    });
    const coder = gnode({ id: "coder", outcome: "done", pendingRework: false });
    expect(isWaitingInGate(reviewer, byId([reviewer, coder]))).toBe(false);
  });

  it("suppresses a source while the target's routed-back outcome awaits re-verify", () => {
    const reviewer = gnode({
      id: "reviewer",
      routes: loopRoutes("coder"),
      gateRounds: 1,
      lastOutcome: { decision: "loop" },
    });
    const coder = gnode({
      id: "coder",
      outcome: "done",
      pendingRework: false,
      lastOutcome: { decision: "loop" },
    });
    expect(isWaitingInGate(reviewer, byId([reviewer, coder]))).toBe(true);
  });

  it("does not suppress the source when a TERMINAL target holds the open round (forced done mid-round — the dead loop must surface)", () => {
    const reviewer = gnode({
      id: "reviewer",
      routes: loopRoutes("coder"),
      gateRounds: 1,
      lastOutcome: { decision: "loop" },
    });
    const coder = gnode({ id: "coder", outcome: "done", pendingRework: true });
    expect(isWaitingInGate(reviewer, byId([reviewer, coder]))).toBe(false);
  });

  it("R4: a cancelled counterpart never suppresses (the dead gate must surface)", () => {
    const reviewer = gnode({
      id: "reviewer",
      routes: loopRoutes("coder"),
      gateRounds: 1,
      lastOutcome: { decision: "loop" },
    });
    const coder = gnode({ id: "coder", outcome: "cancelled", pendingRework: true });
    expect(isWaitingInGate(reviewer, byId([reviewer, coder]))).toBe(false);
  });

  it("does not suppress a source whose target has no open round (forgot-to-finish applies)", () => {
    const reviewer = gnode({ id: "reviewer", routes: loopRoutes("coder") });
    const coder = gnode({ id: "coder" });
    expect(isWaitingInGate(reviewer, byId([reviewer, coder]))).toBe(false);
  });

  it("does not suppress a target once the gate resolved (source terminal)", () => {
    const reviewer = gnode({
      id: "reviewer",
      routes: loopRoutes("coder"),
      outcome: "done",
      gateRounds: 1,
    });
    const coder = gnode({ id: "coder", lastOutcome: { decision: "loop" } });
    expect(isWaitingInGate(coder, byId([reviewer, coder]))).toBe(false);
  });
});

describe("isMemberOfUnresolvedGate (generation-join gating)", () => {
  it("marks both parties while the source is non-terminal", () => {
    const reviewer = gnode({ id: "reviewer", routes: loopRoutes("coder") });
    const coder = gnode({ id: "coder", outcome: "done" });
    const all = [reviewer, coder];
    expect(isMemberOfUnresolvedGate(reviewer, all)).toBe(true);
    expect(isMemberOfUnresolvedGate(coder, all)).toBe(true);
  });

  it("clears once the source is terminal (resolution or parent dissolution)", () => {
    const reviewer = gnode({ id: "reviewer", routes: loopRoutes("coder"), outcome: "done" });
    const coder = gnode({ id: "coder", outcome: "done" });
    const all = [reviewer, coder];
    expect(isMemberOfUnresolvedGate(reviewer, all)).toBe(false);
    expect(isMemberOfUnresolvedGate(coder, all)).toBe(false);
  });

  it("never marks gate-free threads", () => {
    const solo = gnode({ id: "solo", outcome: "done" });
    expect(isMemberOfUnresolvedGate(solo, [solo])).toBe(false);
  });
});

describe("holdErasedByCompletion (raise-then-complete guard predicate)", () => {
  const held = (attention: ReadonlyArray<LoomAttentionReason>, decision: WorkOutcomeDecision) =>
    holdErasedByCompletion({ attention, decision });

  it("names the raised reason a completing submit would erase", () => {
    expect(held(["awaiting_acceptance"], "terminal")).toBe("awaiting_acceptance");
    expect(held(["needs_guidance"], "terminal")).toBe("needs_guidance");
    // A gate `resolve` completes the submitter too, so it erases the hold alike.
    expect(held(["awaiting_acceptance"], "resolve")).toBe("awaiting_acceptance");
  });

  it("allows every decision that leaves the thread non-terminal (the flag survives)", () => {
    for (const decision of ["loop", "yield", "cap-breach", "attention"] as const) {
      expect(held(["awaiting_acceptance"], decision)).toBeNull();
    }
  });

  it("ignores flags an agent cannot raise, so a liveness `error` never blocks a completion", () => {
    expect(held(["error"], "terminal")).toBeNull();
    expect(held(["awaiting_orchestrator"], "terminal")).toBeNull();
    expect(held([], "terminal")).toBeNull();
  });
});

describe("requiresSubmitToComplete (§5.3 bypass guard predicate)", () => {
  it("blocks a self-done on an open rework round or an unresolved gate source", () => {
    expect(requiresSubmitToComplete(gnode({ id: "c", pendingRework: true }))).toBe(true);
    expect(requiresSubmitToComplete(gnode({ id: "r", routes: loopRoutes("c") }))).toBe(true);
  });

  it("allows terminal threads and gate-free threads", () => {
    expect(
      requiresSubmitToComplete(gnode({ id: "r", routes: loopRoutes("c"), outcome: "done" })),
    ).toBe(false);
    expect(requiresSubmitToComplete(gnode({ id: "plain" }))).toBe(false);
  });
});
