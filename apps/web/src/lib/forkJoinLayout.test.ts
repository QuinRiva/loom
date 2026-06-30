import type { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { SidebarThreadSummary } from "../types";
import { computeForkJoinLayout, type LaidNode } from "./forkJoinLayout";

const tid = (value: string) => value as ThreadId;

// The layout only reads lineage + generation + deps + order + title; build the
// minimal shape and cast (the renderer carries the rest of the summary).
function thread(props: {
  id: string;
  parentThreadId: string | null;
  spawnGeneration: string | null;
  createdAt: string;
  blockedBy?: string[];
  title?: string;
}): SidebarThreadSummary {
  return {
    id: tid(props.id),
    parentThreadId: props.parentThreadId ? tid(props.parentThreadId) : null,
    spawnGeneration: props.spawnGeneration,
    blockedBy: (props.blockedBy ?? []).map(tid),
    createdAt: props.createdAt,
    title: props.title ?? props.id,
  } as unknown as SidebarThreadSummary;
}

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

  it("draws a solid spine connecting consecutive orchestrator bridges", () => {
    expect(edges.some((e) => e.kind === "spine" && e.key === "spine:R:1")).toBe(true);
  });

  it("packs a sub-orchestrator's grandchild below its own card", () => {
    const coderA = byId(nodes, "coderA")!;
    const grandG = byId(nodes, "grandG")!;
    expect(grandG.y).toBeGreaterThan(coderA.y);
  });
});
