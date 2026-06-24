import type { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { SidebarThreadSummary } from "../types";
import { rollupGraphState } from "./workstreamGraph";

const ROOT = "root" as ThreadId;

type NodeSpec = {
  id: string;
  parent?: string | null;
  status?: SidebarThreadSummary["status"];
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
    parentThreadId: (spec.parent === undefined ? ROOT : spec.parent) as ThreadId | null,
    status: spec.status ?? "planned",
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

  it("all nodes done → done, count 0", () => {
    const r = rollup([node({ id: "a", status: "done" }), node({ id: "b", status: "done" })]);
    expect(r).toMatchObject({ graphState: "done", activeWorkerCount: 0 });
  });

  it("blocked-on-running → active (liveness dominates the blocked node)", () => {
    const r = rollup([
      node({ id: "a", status: "blocked", blockedBy: ["b"] }),
      node({ id: "b", sessionStatus: "running" }),
    ]);
    expect(r).toMatchObject({ graphState: "active", activeWorkerCount: 1 });
  });

  it("blocked-on-human → attention with the human-gate reason", () => {
    const r = rollup([
      node({ id: "a", status: "planned", blockedBy: ["b"] }),
      node({ id: "b", status: "review" }),
    ]);
    expect(r).toMatchObject({
      graphState: "attention",
      highestAttentionReason: "review",
      attentionCount: 1,
    });
  });

  it("blockedBy cycle, nothing running → deadlocked", () => {
    const r = rollup([
      node({ id: "a", status: "planned", blockedBy: ["b"] }),
      node({ id: "b", status: "planned", blockedBy: ["a"] }),
    ]);
    expect(r).toMatchObject({ graphState: "deadlocked", activeWorkerCount: 0 });
  });

  it("all-blocked with no runnable source → deadlocked", () => {
    const r = rollup([
      node({ id: "a", status: "planned", blockedBy: ["b"] }),
      node({ id: "b", status: "planned", blockedBy: ["c"] }),
      node({ id: "c", status: "planned", blockedBy: ["a"] }),
    ]);
    expect(r.graphState).toBe("deadlocked");
  });

  it("stale status=running node with no live signal, quiesced subtree → idle (not deadlocked)", () => {
    const r = rollup([
      node({ id: "a", status: "running" }), // stale: no session/turn running
      node({ id: "b", status: "done" }),
    ]);
    expect(r).toMatchObject({ graphState: "idle", activeWorkerCount: 0 });
  });

  it("runnable planned node, nothing running → idle", () => {
    const r = rollup([node({ id: "a", status: "planned" })]);
    expect(r).toMatchObject({ graphState: "idle", activeWorkerCount: 0 });
  });

  it("mixed running + pending approval → active, count = running, reason = approval", () => {
    const r = rollup([
      node({ id: "a", turnState: "running" }),
      node({ id: "b", turnState: "running" }),
      node({ id: "c", status: "planned", approvals: true }),
    ]);
    expect(r).toMatchObject({
      graphState: "active",
      activeWorkerCount: 2,
      highestAttentionReason: "approval",
    });
    expect(r.breakdown).toMatchObject({ running: 2, awaitingApproval: 1, planned: 1 });
  });

  it("connecting session keeps state active but is not counted in the headline", () => {
    const r = rollup([
      node({ id: "a", sessionStatus: "connecting" }),
      node({ id: "b", status: "planned" }),
    ]);
    expect(r).toMatchObject({ graphState: "active", activeWorkerCount: 0 });
  });

  it("archived nodes are excluded from the rollup", () => {
    const r = rollup([
      node({ id: "a", sessionStatus: "running", archived: true }),
      node({ id: "b", status: "planned" }),
    ]);
    // The archived running node neither counts nor forces `active`.
    expect(r).toMatchObject({ graphState: "idle", activeWorkerCount: 0, total: 1 });
  });
});
