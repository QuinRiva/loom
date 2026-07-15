import type { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { SidebarThreadSummary } from "../types";
import {
  BackEdgeLanes,
  computeForkJoinLayout,
  computeForkJoinViewBox,
  deriveConsultOverlay,
  NODE_W,
  roundedPath,
  type LaidNode,
} from "./forkJoinLayout";

const tid = (value: string) => value as ThreadId;

// Build the minimal consult-summary shape deriveConsultOverlay reads.
const consult = (targetId: string, count = 1) => ({
  targetThreadId: tid(targetId),
  targetTitle: targetId,
  lastConsultAt: "1",
  lastQuestionPreview: `ask ${targetId}`,
  count,
});

// The layout only reads lineage + generation + deps + order + title; build the
// minimal shape and cast (the renderer carries the rest of the summary).
function thread(props: {
  id: string;
  parentThreadId: string | null;
  spawnGeneration: string | null;
  createdAt: string;
  blockedBy?: string[];
  title?: string;
  loopTo?: string;
  consults?: ReturnType<typeof consult>[];
}): SidebarThreadSummary {
  return {
    id: tid(props.id),
    parentThreadId: props.parentThreadId ? tid(props.parentThreadId) : null,
    spawnGeneration: props.spawnGeneration,
    blockedBy: (props.blockedBy ?? []).map(tid),
    createdAt: props.createdAt,
    title: props.title ?? props.id,
    routes: props.loopTo ? [{ on: ["needs_rework"], kind: "loop", to: tid(props.loopTo) }] : [],
    consults: props.consults ?? [],
  } as unknown as SidebarThreadSummary;
}

// A point lies inside a node's rectangle (used to assert channels stay clear).
const pointInNode = (p: { x: number; y: number }, n: Extract<LaidNode, { kind: "thread" }>) =>
  p.x >= n.x && p.x <= n.x + n.w && p.y >= n.y && p.y <= n.y + n.h;

// Does a horizontal segment [x1,x2] at height y cut through a node rectangle?
const segCutsNode = (x1: number, x2: number, y: number, n: Extract<LaidNode, { kind: "thread" }>) =>
  y > n.y && y < n.y + n.h && Math.min(x1, x2) < n.x + n.w && Math.max(x1, x2) > n.x;

// Whether an axis-aligned segment crosses a node's INTERIOR (edge-touching is
// allowed, so ports on a card border are not treated as a crossing).
const EPS = 0.5;
const segmentCrossesInterior = (
  p: { x: number; y: number },
  q: { x: number; y: number },
  n: Extract<LaidNode, { kind: "thread" }>,
) =>
  Math.min(p.x, q.x) < n.x + n.w - EPS &&
  Math.max(p.x, q.x) > n.x + EPS &&
  Math.min(p.y, q.y) < n.y + n.h - EPS &&
  Math.max(p.y, q.y) > n.y + EPS;

// A routed polyline clears every node body (whole-graph obstacle guarantee).
const polylineClearsAllNodes = (
  points: ReadonlyArray<{ x: number; y: number }>,
  threads: ReadonlyArray<Extract<LaidNode, { kind: "thread" }>>,
) =>
  points.every(
    (_, i) =>
      i === points.length - 1 ||
      threads.every((n) => !segmentCrossesInterior(points[i]!, points[i + 1]!, n)),
  );

const byId = (nodes: ReadonlyArray<LaidNode>, id: string) =>
  nodes.find((n) => n.kind === "thread" && n.thread.id === tid(id));

describe("computeForkJoinLayout", () => {
  // Root orchestrator with two dispatch waves; wave 1 has a parallel pair plus a
  // coder→reviewer dependency; coderA itself spawns a grandchild (nesting).
  const threads = [
    thread({ id: "coderC", parentThreadId: "R", spawnGeneration: "g2", createdAt: "5" }),
    thread({ id: "grandG", parentThreadId: "coderA", spawnGeneration: "g3", createdAt: "6" }),
    thread({ id: "R", parentThreadId: null, spawnGeneration: null, createdAt: "0" }),
    thread({ id: "coderA", parentThreadId: "R", spawnGeneration: "g1", createdAt: "2" }),
    thread({
      id: "reviewerA",
      parentThreadId: "R",
      spawnGeneration: "g1",
      createdAt: "3",
      blockedBy: ["coderA"],
      loopTo: "coderA",
    }),
    thread({ id: "coderB", parentThreadId: "R", spawnGeneration: "g1", createdAt: "4" }),
  ];

  const { nodes, edges } = computeForkJoinLayout(threads);

  it("renders every descendant including grandchildren as thread nodes", () => {
    const threadIds = nodes.filter((n) => n.kind === "thread").map((n) => n.thread.id);
    expect(threadIds).toEqual(
      expect.arrayContaining([
        tid("coderA"),
        tid("reviewerA"),
        tid("coderB"),
        tid("coderC"),
        tid("grandG"),
      ]),
    );
    // The root orchestrator is a spine of bridges, never a thread card.
    expect(threadIds).not.toContain(tid("R"));
  });

  it("renders one bridge node per wave per orchestrator", () => {
    const bridges = nodes.filter((n) => n.kind === "bridge");
    // Root: 2 waves (g1, g2). coderA sub-orchestrator: 1 wave (g3).
    expect(bridges).toHaveLength(3);
    const rootBridges = bridges.filter((b) => b.kind === "bridge" && b.orchestratorId === tid("R"));
    expect(rootBridges).toHaveLength(2);
    expect(bridges.some((b) => b.kind === "bridge" && b.orchestratorId === tid("coderA"))).toBe(
      true,
    );
  });

  it("anchors each bridge at the wave's earliest child and orders waves by time", () => {
    const rootBridges = nodes
      .filter((n): n is Extract<LaidNode, { kind: "bridge" }> => n.kind === "bridge")
      .filter((b) => b.orchestratorId === tid("R"))
      .sort((a, b) => a.y - b.y);
    // Wave g1 (min createdAt "2") sits above wave g2 (createdAt "5").
    expect(rootBridges[0]!.anchorAtIso).toBe("2");
    expect(rootBridges[1]!.anchorAtIso).toBe("5");
    expect(rootBridges[0]!.y).toBeLessThan(rootBridges[1]!.y);
  });

  it("routes within-wave blockedBy as a dependency cross-edge and column", () => {
    const blockedEdge = edges.find((e) => e.kind === "blocked");
    expect(blockedEdge?.key).toContain("reviewerA");
    expect(blockedEdge?.key).toContain("coderA");
    // reviewer depends on coder, so it sits one dependency column to the right.
    expect(byId(nodes, "reviewerA")!.x).toBeGreaterThan(byId(nodes, "coderA")!.x);
  });

  it("emits a reverse loop edge for a same-wave review gate pair", () => {
    const loop = edges.find((e) => e.kind === "loop");
    expect(loop?.key).toBe("loop:reviewerA:coderA");
    expect(loop?.sourceId).toBe(tid("reviewerA"));
    // Reverse direction: from the reviewer's bottom port back to the coder's.
    expect(loop!.x1).toBeGreaterThan(loop!.x2);
    // Anchored below the forward waits-on cross-edge so the cycle reads visually.
    const blocked = edges.find((e) => e.kind === "blocked")!;
    expect(loop!.y1).toBeGreaterThan(blocked.y2);
    expect(loop!.y2).toBeGreaterThan(blocked.y1);
  });

  it("routes the loop as a rounded orthogonal polyline through a channel below the pair", () => {
    const loop = edges.find((e) => e.kind === "loop")!;
    // Orthogonal waypoints with a horizontal channel run below the endpoints.
    expect(loop.points).toBeDefined();
    const pts = loop.points!;
    const channelY = Math.max(...pts.map((p) => p.y));
    // The channel run is a horizontal segment (two consecutive points at
    // channelY), and the badge rides it (never on a corner).
    const runIdx = pts.findIndex(
      (p, i) => i < pts.length - 1 && p.y === channelY && pts[i + 1]!.y === channelY,
    );
    expect(runIdx).toBeGreaterThanOrEqual(0);
    expect(loop.badge!.y).toBe(channelY);
    // The channel sits below both ports (endpoints are the polyline ends).
    expect(channelY).toBeGreaterThan(pts[0]!.y);
    expect(channelY).toBeGreaterThan(pts[pts.length - 1]!.y);
  });

  it("draws a solid spine connecting consecutive orchestrator bridges", () => {
    expect(edges.some((e) => e.kind === "spine" && e.key === "spine:R:1")).toBe(true);
  });

  it("aligns each reviewer's row with its gated coder despite spawn order", () => {
    // Three coder→reviewer pairs, but reviewers spawned in a scrambled order
    // relative to their coders — the barycentre pass must keep each pair
    // horizontal instead of criss-crossing the waits-on/loop edges.
    const pairs = computeForkJoinLayout([
      thread({ id: "R", parentThreadId: null, spawnGeneration: null, createdAt: "0" }),
      thread({ id: "c1", parentThreadId: "R", spawnGeneration: "g1", createdAt: "1" }),
      thread({ id: "c2", parentThreadId: "R", spawnGeneration: "g1", createdAt: "2" }),
      thread({ id: "c3", parentThreadId: "R", spawnGeneration: "g1", createdAt: "3" }),
      // Reviewers created in reverse order of their coders.
      thread({
        id: "r3",
        parentThreadId: "R",
        spawnGeneration: "g1",
        createdAt: "4",
        blockedBy: ["c3"],
        loopTo: "c3",
      }),
      thread({
        id: "r2",
        parentThreadId: "R",
        spawnGeneration: "g1",
        createdAt: "5",
        blockedBy: ["c2"],
        loopTo: "c2",
      }),
      thread({
        id: "r1",
        parentThreadId: "R",
        spawnGeneration: "g1",
        createdAt: "6",
        blockedBy: ["c1"],
        loopTo: "c1",
      }),
    ]);
    for (const pair of ["1", "2", "3"]) {
      expect(byId(pairs.nodes, `r${pair}`)!.y).toBe(byId(pairs.nodes, `c${pair}`)!.y);
    }
  });

  it("carries node keys on every edge for the dependency highlight", () => {
    const fork = edges.find((e) => e.kind === "fork" && e.toKey === tid("coderA"))!;
    expect(fork.fromKey).toContain("bridge:R:");
    const blocked = edges.find((e) => e.kind === "blocked")!;
    expect(blocked.fromKey).toBe(tid("coderA"));
    expect(blocked.toKey).toBe(tid("reviewerA"));
  });

  it("packs a sub-orchestrator's grandchild below its own card", () => {
    const coderA = byId(nodes, "coderA")!;
    const grandG = byId(nodes, "grandG")!;
    expect(grandG.y).toBeGreaterThan(coderA.y);
  });
});

describe("roundedPath", () => {
  it("draws a straight segment for two points", () => {
    expect(
      roundedPath([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ]),
    ).toBe("M 0 0 L 10 0");
  });

  it("rounds each interior corner with a quadratic and never revisits node bodies", () => {
    const d = roundedPath([
      { x: 0, y: 0 },
      { x: 0, y: 20 },
      { x: 30, y: 20 },
      { x: 30, y: 0 },
    ]);
    // One quadratic per interior corner (two here).
    expect(d.match(/Q/g)).toHaveLength(2);
    expect(d.startsWith("M 0 0")).toBe(true);
    expect(d.endsWith("L 30 0")).toBe(true);
  });

  it("returns empty for a degenerate single point", () => {
    expect(roundedPath([{ x: 1, y: 1 }])).toBe("");
  });
});

describe("back-edge routing", () => {
  const byThread = (nodes: ReadonlyArray<LaidNode>) =>
    nodes.filter((n): n is Extract<LaidNode, { kind: "thread" }> => n.kind === "thread");

  it("translates a NESTED gate's loop waypoints and badge with the block", () => {
    // M is a sub-orchestrator whose own wave is a coder→reviewer gate. Its loop
    // lives in a nested block placed by translation; the routed points/badge
    // must move with the endpoints, not stay in stale local coordinates.
    const { edges } = computeForkJoinLayout([
      thread({ id: "R", parentThreadId: null, spawnGeneration: null, createdAt: "0" }),
      thread({ id: "M", parentThreadId: "R", spawnGeneration: "g1", createdAt: "1" }),
      thread({ id: "nc", parentThreadId: "M", spawnGeneration: "mg1", createdAt: "2" }),
      thread({
        id: "nr",
        parentThreadId: "M",
        spawnGeneration: "mg1",
        createdAt: "3",
        blockedBy: ["nc"],
        loopTo: "nc",
      }),
    ]);
    const loop = edges.find((e) => e.kind === "loop" && e.key === "loop:nr:nc")!;
    expect(loop.points).toBeDefined();
    // Endpoints and waypoints agree after translation (the regression guard).
    expect(loop.points![0]).toEqual({ x: loop.x1, y: loop.y1 });
    expect(loop.points![loop.points!.length - 1]).toEqual({ x: loop.x2, y: loop.y2 });
    // Nested block is indented + dropped below M's card, so it is not at origin.
    expect(loop.x1).toBeGreaterThan(NODE_W);
    expect(loop.badge!.y).toBe(loop.points![1]!.y);
  });

  it("keeps every loop channel clear of all node bodies with multiple gate pairs", () => {
    const { nodes, edges } = computeForkJoinLayout([
      thread({ id: "R", parentThreadId: null, spawnGeneration: null, createdAt: "0" }),
      thread({ id: "c1", parentThreadId: "R", spawnGeneration: "g1", createdAt: "1" }),
      thread({ id: "c2", parentThreadId: "R", spawnGeneration: "g1", createdAt: "2" }),
      thread({
        id: "r1",
        parentThreadId: "R",
        spawnGeneration: "g1",
        createdAt: "3",
        blockedBy: ["c1"],
        loopTo: "c1",
      }),
      thread({
        id: "r2",
        parentThreadId: "R",
        spawnGeneration: "g1",
        createdAt: "4",
        blockedBy: ["c2"],
        loopTo: "c2",
      }),
    ]);
    const threads = byThread(nodes);
    const loops = edges.filter((e) => e.kind === "loop");
    expect(loops).toHaveLength(2);
    for (const loop of loops) {
      const [p1, c1p, c2p, p2] = loop.points!;
      // The horizontal channel run must not cut through any card, and the badge
      // sits on that run, clear of every node.
      const channelY = c1p!.y;
      for (const n of threads) {
        expect(segCutsNode(c1p!.x, c2p!.x, channelY, n)).toBe(false);
        expect(pointInNode(loop.badge!, n)).toBe(false);
      }
      // The short vertical drops stay within the reserved lane (below the cards).
      expect(c1p!.y).toBeGreaterThan(p1!.y);
      expect(c2p!.y).toBeGreaterThan(p2!.y);
    }
  });

  it("routes a backward (left) consult clear of EVERY node, incl. unrelated rows with no loop", () => {
    // Wave with two depth-0 rows (x1 above x2 in column 0) and a dependent y1 in
    // column 1. No gate loop, so rows keep the tight 18px gap. y1 consults x1
    // (leftward) — the channel must clear x2 (the unrelated row-2 node below x1),
    // which the old endpoint-local +30 drop would have sliced.
    const { nodes } = computeForkJoinLayoutWith([
      thread({ id: "R", parentThreadId: null, spawnGeneration: null, createdAt: "0" }),
      thread({ id: "x1", parentThreadId: "R", spawnGeneration: "g1", createdAt: "1" }),
      thread({ id: "x2", parentThreadId: "R", spawnGeneration: "g1", createdAt: "2" }),
      thread({
        id: "y1",
        parentThreadId: "R",
        spawnGeneration: "g1",
        createdAt: "3",
        blockedBy: ["x1"],
        consults: [consult("x1")],
      }),
    ]);
    const overlay = deriveConsultOverlay(nodes.all, nodes.byId);
    const edge = overlay.edges.find((e) => e.key === "consult:y1:x1")!;
    expect(edge.points).toBeDefined();
    expect(edge.badge).toBeDefined();
    // No segment of the route crosses ANY node body (x1, x2 and y1 included).
    expect(polylineClearsAllNodes(edge.points!, byThread(nodes.all))).toBe(true);
  });

  it("keeps a gate loop clear of its endpoint's OWN nested child block", () => {
    // The coder owns a spawned descendant, so its card has a nested block below.
    // The reserved lane must keep the review-loop channel above that block.
    const { nodes, edges } = computeForkJoinLayout([
      thread({ id: "R", parentThreadId: null, spawnGeneration: null, createdAt: "0" }),
      thread({ id: "c", parentThreadId: "R", spawnGeneration: "g1", createdAt: "1" }),
      thread({
        id: "r",
        parentThreadId: "R",
        spawnGeneration: "g1",
        createdAt: "2",
        blockedBy: ["c"],
        loopTo: "c",
      }),
      // c spawns a grandchild → c gets a nested orchestration block.
      thread({ id: "g", parentThreadId: "c", spawnGeneration: "cg1", createdAt: "3" }),
    ]);
    const threads = byThread(nodes);
    const loop = edges.find((e) => e.kind === "loop" && e.key === "loop:r:c")!;
    expect(loop.points).toBeDefined();
    expect(polylineClearsAllNodes(loop.points!, threads)).toBe(true);
    // The grandchild really is present + below c (a genuine obstacle).
    const g = threads.find((n) => n.thread.id === tid("g"))!;
    const c = threads.find((n) => n.thread.id === tid("c"))!;
    expect(g.y).toBeGreaterThan(c.y + c.h);
  });

  it("gives two same-column consults DISTINCT gutters (shared registry)", () => {
    // Three depth-0 members stack in column 0; the lower two each consult the
    // top one — both same-column back-edges whose default lane is the gutter
    // just left of the column. The shared registry must hand them distinct
    // lanes rather than letting both pick the identical gutter.
    const { nodes } = computeForkJoinLayoutWith([
      thread({ id: "R", parentThreadId: null, spawnGeneration: null, createdAt: "0" }),
      thread({ id: "a1", parentThreadId: "R", spawnGeneration: "g1", createdAt: "1" }),
      thread({
        id: "a2",
        parentThreadId: "R",
        spawnGeneration: "g1",
        createdAt: "2",
        consults: [consult("a1")],
      }),
      thread({
        id: "a3",
        parentThreadId: "R",
        spawnGeneration: "g1",
        createdAt: "3",
        consults: [consult("a1")],
      }),
    ]);
    const overlay = deriveConsultOverlay(nodes.all, nodes.byId);
    const laneOf = (key: string) => overlay.edges.find((e) => e.key === key)!.points![1]!.x;
    const laneA2 = laneOf("consult:a2:a1");
    const laneA3 = laneOf("consult:a3:a1");
    expect(laneA2).not.toBe(laneA3);
    for (const e of overlay.edges) {
      if (e.points) expect(polylineClearsAllNodes(e.points, byThread(nodes.all))).toBe(true);
    }
  });

  it("pulls two loops onto DISTINCT channels even from the same cleared band", () => {
    // Interleaved gate chain: loop(r1→c1) and loop(r2→c2) overlap in x and clear
    // to the same preliminary band. The shared registry must give them distinct
    // final channel Ys (the old per-band counter keyed BEFORE clearance could
    // not, once obstacle-pushing collapsed different bands together).
    const { nodes, edges } = computeForkJoinLayout([
      thread({ id: "R", parentThreadId: null, spawnGeneration: null, createdAt: "0" }),
      thread({ id: "c1", parentThreadId: "R", spawnGeneration: "g1", createdAt: "1" }),
      thread({
        id: "c2",
        parentThreadId: "R",
        spawnGeneration: "g1",
        createdAt: "2",
        blockedBy: ["c1"],
      }),
      thread({
        id: "r1",
        parentThreadId: "R",
        spawnGeneration: "g1",
        createdAt: "3",
        blockedBy: ["c2"],
        loopTo: "c1",
      }),
      thread({
        id: "r2",
        parentThreadId: "R",
        spawnGeneration: "g1",
        createdAt: "4",
        blockedBy: ["r1"],
        loopTo: "c2",
      }),
    ]);
    const loops = edges.filter((e) => e.kind === "loop");
    expect(loops).toHaveLength(2);
    const ys = loops.map((e) => Math.max(...e.points!.map((p) => p.y)));
    // The two loops overlap in x — so their channels MUST be at different Ys.
    const spanLo = (e: (typeof loops)[number]) => Math.min(...e.points!.map((p) => p.x));
    const spanHi = (e: (typeof loops)[number]) => Math.max(...e.points!.map((p) => p.x));
    const overlap = spanLo(loops[1]!) < spanHi(loops[0]!) && spanLo(loops[0]!) < spanHi(loops[1]!);
    expect(overlap).toBe(true);
    expect(ys[0]).not.toBe(ys[1]);
    for (const e of loops) expect(polylineClearsAllNodes(e.points!, byThread(nodes))).toBe(true);
  });

  it("registry deconflicts channels that obstacle-clearance collapsed (unit)", () => {
    // Directly exercise the post-clearance registry: two horizontal channels
    // that clearing pushed onto the SAME Y and overlap in x must be pulled
    // apart, regardless of their (differing) preliminary bands.
    const lanes = new BackEdgeLanes();
    const y1 = lanes.claimHorizontal(100, 0, 200, 8);
    const y2 = lanes.claimHorizontal(100, 50, 150, 8); // same cleared Y, overlaps x
    const y3 = lanes.claimHorizontal(100, 400, 500, 8); // same Y, NO x-overlap
    expect(y1).toBe(100);
    expect(y2).toBe(108); // bumped
    expect(y3).toBe(100); // independent span, no bump
    // Vertical lanes: a claimed gutter is no longer free for an overlapping span.
    lanes.claimVertical(10, 0, 100);
    expect(lanes.verticalFree(10, 20, 80, 8)).toBe(false);
    expect(lanes.verticalFree(10, 200, 300, 8)).toBe(true);
  });

  it("offsets shared leftward consult channels so they never overlap", () => {
    const { nodes } = computeForkJoinLayoutWith([
      thread({ id: "R", parentThreadId: null, spawnGeneration: null, createdAt: "0" }),
      thread({ id: "t1", parentThreadId: "R", spawnGeneration: "g1", createdAt: "1" }),
      thread({ id: "t2", parentThreadId: "R", spawnGeneration: "g1", createdAt: "2" }),
      thread({
        id: "s1",
        parentThreadId: "R",
        spawnGeneration: "g1",
        createdAt: "3",
        blockedBy: ["t1"],
        consults: [consult("t1")],
      }),
      thread({
        id: "s2",
        parentThreadId: "R",
        spawnGeneration: "g1",
        createdAt: "4",
        blockedBy: ["t2"],
        consults: [consult("t2")],
      }),
    ]);
    const overlay = deriveConsultOverlay(nodes.all, nodes.byId);
    // Channel height = the lowest point of each routed staple.
    const channels = overlay.edges
      .filter((e) => e.points)
      .map((e) => Math.max(...e.points!.map((p) => p.y)));
    expect(channels.length).toBeGreaterThanOrEqual(2);
    // Distinct channel heights (offset), and each route stays clear of all nodes.
    expect(new Set(channels).size).toBe(channels.length);
    for (const e of overlay.edges) {
      if (e.points) expect(polylineClearsAllNodes(e.points, byThread(nodes.all))).toBe(true);
    }
  });

  it("routes a same-column consult to a node above through a side gutter", () => {
    // Two members in the SAME dependency column (a chain), the later one
    // consulting the earlier (directly above). A naive target.x<asker.x test
    // misses this; it must still route orthogonally, not as a crossing spline.
    const { nodes } = computeForkJoinLayoutWith([
      thread({ id: "R", parentThreadId: null, spawnGeneration: null, createdAt: "0" }),
      thread({ id: "top", parentThreadId: "R", spawnGeneration: "g1", createdAt: "1" }),
      thread({
        id: "bot",
        parentThreadId: "R",
        spawnGeneration: "g1",
        createdAt: "2",
        consults: [consult("top")],
      }),
    ]);
    const overlay = deriveConsultOverlay(nodes.all, nodes.byId);
    const edge = overlay.edges.find((e) => e.key === "consult:bot:top")!;
    expect(edge.points).toBeDefined();
    // Vertical gutter lane sits to the LEFT of the column (clear of both cards).
    const laneX = edge.points![1]!.x;
    const top = byThread(nodes.all).find((n) => n.thread.id === tid("top"))!;
    expect(laneX).toBeLessThan(top.x);
    for (const n of byThread(nodes.all)) expect(pointInNode(edge.points![1]!, n)).toBe(false);
  });

  it("draws within-wave waits-on strictly left-to-right (no backward edge)", () => {
    const { edges } = computeForkJoinLayout([
      thread({ id: "R", parentThreadId: null, spawnGeneration: null, createdAt: "0" }),
      thread({ id: "c", parentThreadId: "R", spawnGeneration: "g1", createdAt: "1" }),
      thread({
        id: "r",
        parentThreadId: "R",
        spawnGeneration: "g1",
        createdAt: "2",
        blockedBy: ["c"],
      }),
    ]);
    for (const e of edges.filter((edge) => edge.kind === "blocked")) {
      expect(e.x1).toBeLessThanOrEqual(e.x2);
    }
  });

  it("expands the viewBox to bound a backward consult's channel below the nodes", () => {
    const { nodes } = computeForkJoinLayoutWith([
      thread({ id: "R", parentThreadId: null, spawnGeneration: null, createdAt: "0" }),
      thread({ id: "a", parentThreadId: "R", spawnGeneration: "g1", createdAt: "1" }),
      thread({
        id: "b",
        parentThreadId: "R",
        spawnGeneration: "g1",
        createdAt: "2",
        blockedBy: ["a"],
        consults: [consult("a")],
      }),
    ]);
    const overlay = deriveConsultOverlay(nodes.all, nodes.byId);
    const nodesOnly = computeForkJoinViewBox(nodes.all);
    const withEdges = computeForkJoinViewBox(nodes.all, [], overlay.edges);
    const channelBottom = Math.max(...overlay.edges.flatMap((e) => e.points!.map((p) => p.y)));
    // The full box contains every routed point (no clipping) and is never
    // smaller than the nodes-only box — back-edge geometry is always bounded.
    expect(withEdges.y + withEdges.h).toBeGreaterThanOrEqual(channelBottom);
    expect(withEdges.y + withEdges.h).toBeGreaterThanOrEqual(nodesOnly.y + nodesOnly.h);
  });

  it("draws a cross-wave dependency INVERSION (early node waiting on a later wave)", () => {
    // An early-wave node re-gated (post-spawn) to wait on a later-spawned
    // sibling: the spine implies the WRONG order, so this edge must be drawn as
    // a routed back-edge (a within-wave-only layout would drop it, leaving the
    // node "Blocked" with no visible reason).
    const { nodes, edges } = computeForkJoinLayout([
      thread({ id: "R", parentThreadId: null, spawnGeneration: null, createdAt: "0" }),
      // Wave 1: `doc` depends on the LATER assessor (the inversion).
      thread({
        id: "doc",
        parentThreadId: "R",
        spawnGeneration: "g1",
        createdAt: "1",
        blockedBy: ["assessor"],
      }),
      // Wave 2 (later generation): the replacement it now waits on.
      thread({ id: "assessor", parentThreadId: "R", spawnGeneration: "g2", createdAt: "2" }),
    ]);
    const edge = edges.find((e) => e.kind === "blocked" && e.key === "blocked:doc:assessor");
    expect(edge).toBeDefined();
    // Direction: from the dependency (assessor) to the blocked node (doc).
    expect(edge!.fromKey).toBe(tid("assessor"));
    expect(edge!.toKey).toBe(tid("doc"));
    // Routed orthogonally (waypoints), clear of every card.
    expect(edge!.points).toBeDefined();
    const threads = nodes.filter(
      (n): n is Extract<LaidNode, { kind: "thread" }> => n.kind === "thread",
    );
    expect(polylineClearsAllNodes(edge!.points!, threads)).toBe(true);
    // The dependency really is in a later wave (below on the spine).
    expect(byId(nodes, "assessor")!.y).toBeGreaterThan(byId(nodes, "doc")!.y);
  });

  it("leaves a forward cross-wave dependency to the spine (no back-edge)", () => {
    // A later-wave node waiting on an earlier-wave one is the NORMAL order the
    // spine already encodes; drawing it would be redundant clutter.
    const { edges } = computeForkJoinLayout([
      thread({ id: "R", parentThreadId: null, spawnGeneration: null, createdAt: "0" }),
      thread({ id: "early", parentThreadId: "R", spawnGeneration: "g1", createdAt: "1" }),
      thread({
        id: "late",
        parentThreadId: "R",
        spawnGeneration: "g2",
        createdAt: "2",
        blockedBy: ["early"],
      }),
    ]);
    expect(edges.some((e) => e.kind === "blocked")).toBe(false);
  });
});

// Small helper: run the layout and return nodes plus a byId map for consult
// overlay derivation.
function computeForkJoinLayoutWith(threads: ReadonlyArray<SidebarThreadSummary>): {
  nodes: { all: ReadonlyArray<LaidNode>; byId: Map<ThreadId, SidebarThreadSummary> };
} {
  const { nodes } = computeForkJoinLayout(threads);
  return { nodes: { all: nodes, byId: new Map(threads.map((t) => [t.id, t])) } };
}
