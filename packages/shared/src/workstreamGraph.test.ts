import type { AttentionReason, ThreadId, ThreadPlanLane } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  childrenOf,
  descendantsOf,
  graphViewFor,
  type GraphViewThread,
  isTerminalForJoin,
  selectJoinedGenerations,
  subtreeCostOf,
  subtreeOf,
} from "./workstreamGraph.ts";

const tid = (id: string) => id as ThreadId;

const node = (
  overrides: Omit<Partial<GraphViewThread>, "id"> & { readonly id: string },
): GraphViewThread => ({
  parentThreadId: null,
  spawnGeneration: null,
  planLane: "planned" as ThreadPlanLane,
  attention: [],
  role: null,
  title: null,
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

// Join nodes carry the runtime-executing projection (session/latestTurn) the
// terminal-for-join predicate reads, on top of plan lane + attention.
const joinNode = (overrides: {
  readonly id?: string;
  readonly parentThreadId?: ThreadId | null;
  readonly spawnGeneration?: string | null;
  readonly planLane?: ThreadPlanLane;
  readonly attention?: ReadonlyArray<AttentionReason>;
  readonly executing?: boolean;
}) => ({
  id: tid(overrides.id ?? "n"),
  parentThreadId:
    overrides.parentThreadId === undefined ? tid("parent-1") : overrides.parentThreadId,
  spawnGeneration: overrides.spawnGeneration ?? null,
  planLane: overrides.planLane ?? "planned",
  attention: overrides.attention ?? [],
  session: overrides.executing ? { status: "running" } : null,
  latestTurn: overrides.executing ? { state: "running" } : null,
});

describe("isTerminalForJoin", () => {
  it("treats done and cancelled as terminal", () => {
    expect(isTerminalForJoin(joinNode({ planLane: "done" }))).toBe(true);
    expect(isTerminalForJoin(joinNode({ planLane: "cancelled" }))).toBe(true);
  });

  it("does NOT treat an attention-flagged node as terminal — a pause is not a result", () => {
    expect(
      isTerminalForJoin(joinNode({ planLane: "in_progress", attention: ["needs_guidance"] })),
    ).toBe(false);
    expect(isTerminalForJoin(joinNode({ planLane: "ready", attention: ["error"] }))).toBe(false);
    expect(
      isTerminalForJoin(
        joinNode({ planLane: "in_progress", attention: ["error"], executing: true }),
      ),
    ).toBe(false);
  });

  it("does NOT treat a pre-terminal, unflagged node as terminal", () => {
    expect(isTerminalForJoin(joinNode({ planLane: "planned" }))).toBe(false);
    expect(isTerminalForJoin(joinNode({ planLane: "ready" }))).toBe(false);
    expect(isTerminalForJoin(joinNode({ planLane: "in_progress" }))).toBe(false);
  });
});

const genIds = (groups: ReadonlyArray<{ parentId: ThreadId; generation: string }>) =>
  groups.map((g) => `${g.parentId}::${g.generation}`).sort();

describe("selectJoinedGenerations", () => {
  it("joins a generation only once every member is plan-terminal", () => {
    expect(
      selectJoinedGenerations([
        joinNode({ id: "a", spawnGeneration: "gen-1", planLane: "done" }),
        joinNode({ id: "b", spawnGeneration: "gen-1", planLane: "in_progress", executing: true }),
      ]),
    ).toEqual([]);
    expect(
      genIds(
        selectJoinedGenerations([
          joinNode({ id: "a", spawnGeneration: "gen-1", planLane: "done" }),
          joinNode({ id: "b", spawnGeneration: "gen-1", planLane: "cancelled" }),
        ]),
      ),
    ).toEqual(["parent-1::gen-1"]);
  });

  it("holds the join on a flagged, non-executing child until its lane goes terminal (a pause never joins)", () => {
    // The parent hears about the pause through the per-child rail, never this
    // barrier; the one-shot generation wake stays armed for the real completion.
    expect(
      selectJoinedGenerations([
        joinNode({ id: "a", spawnGeneration: "gen-1", planLane: "done" }),
        joinNode({
          id: "b",
          spawnGeneration: "gen-1",
          planLane: "in_progress",
          attention: ["awaiting_acceptance"],
        }),
      ]),
    ).toEqual([]);
    expect(
      selectJoinedGenerations([
        joinNode({ id: "a", spawnGeneration: "gen-1", planLane: "done" }),
        joinNode({ id: "b", spawnGeneration: "gen-1", attention: ["error"] }),
      ]),
    ).toEqual([]);
    expect(
      genIds(
        selectJoinedGenerations([
          joinNode({ id: "a", spawnGeneration: "gen-1", planLane: "done" }),
          joinNode({
            id: "b",
            spawnGeneration: "gen-1",
            planLane: "cancelled",
            attention: ["error"],
          }),
        ]),
      ),
    ).toEqual(["parent-1::gen-1"]);
  });

  it("scopes the join per (parent, generation) so a later generation wakes independently", () => {
    expect(
      genIds(
        selectJoinedGenerations([
          joinNode({
            id: "old",
            spawnGeneration: "gen-1",
            planLane: "in_progress",
            executing: true,
          }),
          joinNode({ id: "new", spawnGeneration: "gen-2", planLane: "done" }),
        ]),
      ),
    ).toEqual(["parent-1::gen-2"]);
  });

  it("ignores children without a spawn generation or parent", () => {
    expect(
      selectJoinedGenerations([
        joinNode({ id: "root", spawnGeneration: "gen-1", planLane: "done", parentThreadId: null }),
        joinNode({ id: "ungen", spawnGeneration: null, planLane: "done" }),
      ]),
    ).toEqual([]);
  });

  it("preserves the concrete node type in the joined children", () => {
    const [group] = selectJoinedGenerations([
      {
        ...joinNode({ id: "a", parentThreadId: tid("p"), spawnGeneration: "g", planLane: "done" }),
        role: "coder",
      },
    ]);
    expect(group?.children[0]?.role).toBe("coder");
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
});
