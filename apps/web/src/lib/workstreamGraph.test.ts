import type { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { SidebarThreadSummary } from "../types";
import { type AttentionReason, rollupGraphState } from "./workstreamGraph";

const ROOT = "root" as ThreadId;

type NodeSpec = {
  id: string;
  parent?: string | null;
  planLane?: SidebarThreadSummary["planLane"];
  attention?: AttentionReason[];
  blockedBy?: string[];
  sessionStatus?: NonNullable<SidebarThreadSummary["session"]>["status"];
  turnState?: NonNullable<SidebarThreadSummary["latestTurn"]>["state"];
  approvals?: boolean;
  input?: boolean;
  plan?: boolean;
  archived?: boolean;
};

// Only the fields rollupGraphState consumes are populated; the rest are cast
// away so the edge-case table stays readable.
const node = (spec: NodeSpec): SidebarThreadSummary =>
  ({
    id: spec.id as ThreadId,
    environmentId: "env" as SidebarThreadSummary["environmentId"],
    title: `thread ${spec.id}`,
    parentThreadId: (spec.parent === undefined ? ROOT : spec.parent) as ThreadId | null,
    planLane: spec.planLane ?? "planned",
    attention: spec.attention ?? [],
    blockedBy: (spec.blockedBy ?? []).map((id) => id as ThreadId),
    session: spec.sessionStatus ? { status: spec.sessionStatus } : null,
    latestTurn: spec.turnState ? { state: spec.turnState } : null,
    hasPendingApprovals: spec.approvals ?? false,
    hasPendingUserInput: spec.input ?? false,
    hasActionableProposedPlan: spec.plan ?? false,
    archivedAt: spec.archived ? "2026-01-01T00:00:00Z" : null,
  }) as unknown as SidebarThreadSummary;

const rollup = (nodes: ReadonlyArray<SidebarThreadSummary>) =>
  rollupGraphState(nodes, new Map(nodes.map((n) => [n.id, n])));

describe("rollupGraphState", () => {
  it("empty graph → empty, count 0", () => {
    expect(rollup([])).toMatchObject({ graphState: "empty", activeWorkerCount: 0 });
  });

  it("all nodes terminal (done/cancelled) → done, count 0", () => {
    const r = rollup([
      node({ id: "a", planLane: "done" }),
      node({ id: "b", planLane: "cancelled" }),
    ]);
    expect(r).toMatchObject({ graphState: "done", activeWorkerCount: 0 });
  });

  it("blocked-on-running → active (liveness dominates the blocked node)", () => {
    const r = rollup([
      node({ id: "a", planLane: "ready", blockedBy: ["b"] }),
      node({ id: "b", planLane: "in_progress", sessionStatus: "running" }),
    ]);
    expect(r).toMatchObject({ graphState: "active", activeWorkerCount: 1 });
  });

  it("blocked-on-human → attention with the highest-priority reason", () => {
    const r = rollup([
      node({ id: "a", planLane: "ready", blockedBy: ["b"] }),
      node({ id: "b", planLane: "in_progress", attention: ["awaiting_acceptance"] }),
    ]);
    expect(r).toMatchObject({
      graphState: "attention",
      highestAttentionReason: "awaiting_acceptance",
      attentionCount: 1,
    });
  });

  it("blockedBy cycle of released `ready` nodes, nothing running → deadlocked", () => {
    const r = rollup([
      node({ id: "a", planLane: "ready", blockedBy: ["b"] }),
      node({ id: "b", planLane: "ready", blockedBy: ["a"] }),
    ]);
    expect(r).toMatchObject({ graphState: "deadlocked", activeWorkerCount: 0 });
    // The stuck cycle members are surfaced as act-targets (reason null).
    expect(r.actionNodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
    expect(r.actionNodes.every((n) => n.reason === null)).toBe(true);
  });

  it("held `planned` subtree awaiting release → idle, not deadlocked", () => {
    const r = rollup([
      node({ id: "a", planLane: "planned" }),
      node({ id: "b", planLane: "planned", blockedBy: ["a"] }),
    ]);
    expect(r.graphState).toBe("idle");
  });

  it("stale in_progress node with no live signal, quiesced subtree → idle (not deadlocked)", () => {
    const r = rollup([
      node({ id: "a", planLane: "in_progress" }), // stale: no session/turn running
      node({ id: "b", planLane: "done" }),
    ]);
    expect(r).toMatchObject({ graphState: "idle", activeWorkerCount: 0 });
  });

  it("runnable ready node, nothing running → idle", () => {
    const r = rollup([node({ id: "a", planLane: "ready" })]);
    expect(r).toMatchObject({ graphState: "idle", activeWorkerCount: 0 });
  });

  it("attention surfaces gated sub-threads as actionNodes, highest-priority first", () => {
    const r = rollup([
      node({ id: "a", planLane: "ready", input: true }),
      node({ id: "b", planLane: "ready", approvals: true }),
      node({ id: "c", planLane: "done" }),
    ]);
    expect(r.graphState).toBe("attention");
    // approval (priority 5) before input (4); the settled node is not surfaced.
    expect(r.actionNodes.map((n) => ({ id: n.id, reason: n.reason }))).toEqual([
      { id: "b", reason: "awaiting_approval" },
      { id: "a", reason: "awaiting_input" },
    ]);
  });

  it("a raised `error` flag outranks derived gates", () => {
    const r = rollup([
      node({ id: "a", planLane: "in_progress", attention: ["error"] }),
      node({ id: "b", planLane: "ready", approvals: true }),
    ]);
    expect(r).toMatchObject({ graphState: "attention", highestAttentionReason: "error" });
  });

  it("active state surfaces no actionNodes (watching, not acting)", () => {
    const r = rollup([
      node({ id: "a", planLane: "in_progress", turnState: "running" }),
      node({ id: "b", planLane: "ready", approvals: true }),
    ]);
    expect(r.graphState).toBe("active");
    expect(r.actionNodes).toEqual([]);
  });

  it("mixed running + pending approval → active, count = running, reason = approval", () => {
    const r = rollup([
      node({ id: "a", planLane: "in_progress", turnState: "running" }),
      node({ id: "b", planLane: "in_progress", turnState: "running" }),
      node({ id: "c", planLane: "ready", approvals: true }),
    ]);
    expect(r).toMatchObject({
      graphState: "active",
      activeWorkerCount: 2,
      highestAttentionReason: "awaiting_approval",
    });
    expect(r.breakdown).toMatchObject({ running: 2, awaitingApproval: 1, planned: 1 });
  });

  it("connecting session keeps state active but is not counted in the headline", () => {
    const r = rollup([
      node({ id: "a", planLane: "in_progress", sessionStatus: "connecting" }),
      node({ id: "b", planLane: "planned" }),
    ]);
    expect(r).toMatchObject({ graphState: "active", activeWorkerCount: 0 });
  });

  it("archived nodes are excluded from the rollup", () => {
    const r = rollup([
      node({ id: "a", planLane: "in_progress", sessionStatus: "running", archived: true }),
      node({ id: "b", planLane: "planned" }),
    ]);
    // The archived running node neither counts nor forces `active`.
    expect(r).toMatchObject({ graphState: "idle", activeWorkerCount: 0, total: 1 });
  });
});
