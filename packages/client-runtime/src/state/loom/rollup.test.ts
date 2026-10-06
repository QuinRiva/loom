import {
  type LoomAttentionReason,
  type OrchestrationV2ThreadShell,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { workstreamFields, workstreamShell } from "./loomTestFixtures.ts";
import { v2Now } from "../orchestrationV2TestFixtures.ts";
import { attentionReasonsOf, workstreamRollupOf } from "./rollup.ts";
import { workstreamIndexOf } from "./workstream.ts";

const STARTED = "2026-10-05T01:00:00.000Z";

type Spec = {
  readonly id: string;
  readonly parent?: string | null;
  readonly started?: boolean;
  readonly outcome?: "done" | "cancelled";
  readonly held?: boolean;
  readonly brief?: boolean;
  readonly blockedBy?: ReadonlyArray<string>;
  readonly attention?: ReadonlyArray<LoomAttentionReason>;
  readonly activity?: OrchestrationV2ThreadShell["activityRunStatus"];
  readonly request?: NonNullable<OrchestrationV2ThreadShell["pendingRuntimeRequest"]>["kind"];
  readonly archived?: boolean;
};

const node = (spec: Spec) =>
  workstreamShell(
    workstreamFields(spec.id, {
      parentThreadId: ThreadId.make(spec.parent === undefined ? "root" : (spec.parent ?? "root")),
      kickoffAt: spec.started || spec.outcome === "done" ? STARTED : null,
      outcome: spec.outcome ?? null,
      held: spec.held ?? false,
      kickoffBriefPath: spec.brief === false ? null : `/briefs/${spec.id}.md`,
      blockedBy: (spec.blockedBy ?? []).map((id) => ThreadId.make(id)),
      attention: spec.attention ?? [],
    }),
    {
      activityRunStatus: spec.activity ?? null,
      pendingRuntimeRequest:
        spec.request === undefined
          ? null
          : {
              id: RuntimeRequestId.make(`request-${spec.id}`),
              kind: spec.request,
              createdAt: v2Now,
            },
      archivedAt: spec.archived ? v2Now : null,
    },
  );

const rollup = (specs: ReadonlyArray<Spec>) => {
  const threads = [
    workstreamShell(workstreamFields("root", { parentThreadId: null })),
    ...specs.map(node),
  ];
  return workstreamRollupOf(ThreadId.make("root"), threads, workstreamIndexOf(threads));
};

describe("workstream rollups", () => {
  it("an empty graph rolls up to nothing on every axis", () => {
    const { plan, activity, attention } = rollup([]);
    expect(plan).toMatchObject({ total: 0, settled: false, deadlocked: null });
    expect(activity).toEqual({ running: 0, active: 0 });
    expect(attention).toEqual({ count: 0, highest: null, nodes: [] });
  });

  it("all nodes done or cancelled → the plan is settled", () => {
    const { plan } = rollup([
      { id: "a", outcome: "done" },
      { id: "b", outcome: "cancelled" },
    ]);
    expect(plan).toMatchObject({ settled: true, columns: { done: 1, cancelled: 1 } });
  });

  it("a node blocked on a running sibling: blocked in the plan, running in the activity, never deadlocked", () => {
    const { plan, activity } = rollup([
      { id: "a", blockedBy: ["b"] },
      { id: "b", started: true, activity: "running" },
    ]);
    expect(plan).toMatchObject({ columns: { blocked: 1, in_progress: 1 }, deadlocked: null });
    expect(activity).toEqual({ running: 1, active: 1 });
  });

  it("a node blocked on a flagged sibling surfaces the stored reason", () => {
    const { attention } = rollup([
      { id: "a", blockedBy: ["b"] },
      { id: "b", started: true, attention: ["awaiting_acceptance"] },
    ]);
    expect(attention).toMatchObject({ count: 1, highest: "awaiting_acceptance" });
  });

  it("a dependency cycle of released, unstarted nodes is deadlocked", () => {
    const { plan } = rollup([
      { id: "a", blockedBy: ["b"] },
      { id: "b", blockedBy: ["a"] },
    ]);
    expect([...(plan.deadlocked ?? [])].sort()).toEqual(["a", "b"]);
  });

  it("a held subtree awaiting release is idle, not deadlocked", () => {
    const { plan } = rollup([
      { id: "a", held: true },
      { id: "b", held: true, blockedBy: ["a"] },
    ]);
    expect(plan).toMatchObject({ columns: { held: 2 }, deadlocked: null });
  });

  it("a stale in-progress node with no activity is neither running nor deadlocked", () => {
    const { plan, activity } = rollup([
      { id: "a", started: true },
      { id: "b", outcome: "done" },
    ]);
    expect(plan.deadlocked).toBeNull();
    expect(activity).toEqual({ running: 0, active: 0 });
  });

  it("derives awaiting_approval and awaiting_input from the pending request, highest priority first", () => {
    const { attention } = rollup([
      { id: "a", request: "user_input" },
      { id: "b", request: "command" },
      { id: "c", outcome: "done" },
    ]);
    expect(attention.nodes.map(({ id, reason }) => ({ id, reason }))).toEqual([
      { id: "b", reason: "awaiting_approval" },
      { id: "a", reason: "awaiting_input" },
    ]);
  });

  it("a stored error outranks a derived approval", () => {
    const { attention } = rollup([
      { id: "a", started: true, attention: ["error"] },
      { id: "b", request: "file-change" },
    ]);
    expect(attention.highest).toBe("error");
  });

  it("a starting run is active but not running", () => {
    const { activity } = rollup([{ id: "a", started: true, activity: "starting" }]);
    expect(activity).toEqual({ running: 0, active: 1 });
  });

  it("archived nodes are excluded from every axis", () => {
    const { plan, activity, attention } = rollup([
      { id: "a", started: true, activity: "running", attention: ["error"], archived: true },
      { id: "b" },
    ]);
    expect(plan.total).toBe(1);
    expect(activity.running).toBe(0);
    expect(attention.count).toBe(0);
  });

  it("covers grandchildren through lineage", () => {
    const { plan } = rollup([
      { id: "a", started: true },
      { id: "g", parent: "a", outcome: "cancelled" },
    ]);
    expect(plan.total).toBe(2);
  });
});

describe("attentionReasonsOf", () => {
  it("adds brief-needed only for a live, unbriefed, unstarted child", () => {
    expect(attentionReasonsOf(node({ id: "a", brief: false }))).toEqual(["brief-needed"]);
    expect(attentionReasonsOf(node({ id: "b", brief: false, started: true }))).toEqual([]);
    expect(attentionReasonsOf(node({ id: "c", brief: false, outcome: "cancelled" }))).toEqual([]);
    expect(
      attentionReasonsOf(
        workstreamShell(workstreamFields("root", { parentThreadId: null, kickoffBriefPath: null })),
      ),
    ).toEqual([]);
  });

  it("keeps a yield (awaiting_orchestrator) as attention, not a column", () => {
    expect(
      attentionReasonsOf(node({ id: "a", started: true, attention: ["awaiting_orchestrator"] })),
    ).toEqual(["awaiting_orchestrator"]);
  });
});
