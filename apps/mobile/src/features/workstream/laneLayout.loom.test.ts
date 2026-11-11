import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { type LaneNode, type LaneRow, layoutLanes, toggleFold } from "./laneLayout.loom";

const ROOT = ThreadId.make("root");
const minute = (n: number) => `2026-11-10T10:${String(n).padStart(2, "0")}:00.000Z`;

const node = (
  id: string,
  at: number,
  fields: Partial<Omit<LaneNode, "routes">> & { readonly loopTo?: string } = {},
): LaneNode => {
  const { loopTo, ...rest } = fields;
  return {
    id: ThreadId.make(id),
    parentThreadId: ROOT,
    spawnGeneration: null,
    createdAt: minute(at),
    outcome: null,
    blockedBy: [],
    routes: loopTo
      ? [{ on: ["needs_rework"], kind: "loop", to: ThreadId.make(loopTo), maxRounds: 3 }]
      : [],
    gateRounds: 0,
    ...rest,
  };
};
const ids = (...names: string[]) => names.map((name) => ThreadId.make(name));
const layout = (nodes: ReadonlyArray<LaneNode>, expanded: ReadonlySet<string> = new Set()) =>
  layoutLanes(nodes, ROOT, expanded, Infinity);
const shape = (rows: ReadonlyArray<LaneRow>) =>
  rows.map((row) =>
    row.kind === "wave" ? `wave ${row.count}` : `${row.kind} ${row.key}@${row.lane}`,
  );
const rowOf = (rows: ReadonlyArray<LaneRow>, key: string) =>
  rows.findIndex((row) => row.key === key);

describe("layoutLanes", () => {
  it("puts the newest wave first and folds a settled wave to one row that expands in place", () => {
    const nodes = [
      node("old-a", 1, { spawnGeneration: "g1", outcome: "done" }),
      node("old-b", 2, { spawnGeneration: "g1", outcome: "cancelled" }),
      node("new", 5, { spawnGeneration: "g2" }),
    ];
    const { rows } = layout(nodes);
    expect(shape(rows)).toEqual(["wave 1", "thread new@1", `fold wave:root:g1@0`]);
    expect(rows[2]).toMatchObject({ settled: 1, cancelled: 1, threadIds: ids("old-a", "old-b") });

    const opened = layout(nodes, toggleFold(new Set(), rows[2]!)).rows;
    expect(shape(opened)).toEqual([
      "wave 1",
      "thread new@1",
      "wave 2",
      "thread old-b@1",
      "thread old-a@1",
    ]);
    expect(toggleFold(new Set(["wave:root:g1"]), opened[2]!)).toEqual(new Set());
  });

  it("sits a reviewer directly above its coder with one gate arrow, while unresolved or looped", () => {
    const pair = (reviewer: Partial<LaneNode>) => [
      node("coder", 1, { spawnGeneration: "g" }),
      node("reviewer", 2, {
        spawnGeneration: "g",
        blockedBy: ids("coder"),
        loopTo: "coder",
        ...reviewer,
      }),
      node("other", 3, { spawnGeneration: "g" }),
    ];
    const open = layout(pair({}));
    expect(shape(open.rows)).toEqual([
      "wave 3",
      "thread other@1",
      "thread reviewer@1",
      "thread coder@1",
    ]);
    expect(open.rows[2]!.gutter.arcs).toEqual([
      { slot: 0, kind: "gate", above: false, below: true, joins: "source", sourceId: "reviewer" },
    ]);
    expect(open.rows[3]!.gutter.arcs).toMatchObject([
      { kind: "gate", joins: "target", above: true },
    ]);

    const cleanFirstTime = layout(pair({ outcome: "done" }));
    expect(cleanFirstTime.slotCount).toBe(0);
    const looped = layout(pair({ outcome: "done", gateRounds: 1 }));
    expect(looped.slotCount).toBe(1);
  });

  it("gives a waiter of four unfinished dependencies one slot, and drops it once they finish", () => {
    const deps = ["a", "b", "c", "d"];
    const nodes = (outcome: LaneNode["outcome"]) => [
      ...deps.map((id, index) => node(id, index + 1, { outcome })),
      node("waiter", 9, { blockedBy: ids(...deps) }),
    ];
    const live = layout(nodes(null));
    expect(live.slotCount).toBe(1);
    const waiter = live.rows[rowOf(live.rows, "waiter")]!;
    expect(waiter.gutter.arcs).toMatchObject([
      { kind: "waits", joins: "target", sourceId: "waiter" },
    ]);
    expect(deps.map((id) => live.rows[rowOf(live.rows, id)]!.gutter.arcs[0]?.joins)).toEqual([
      "source",
      "source",
      "source",
      "source",
    ]);
    expect(layout(nodes("done")).slotCount).toBe(0);
  });

  it("ends an arrow to a folded thread at the fold", () => {
    const nodes = [
      node("dep-parent", 1, { spawnGeneration: "g1", outcome: "done" }),
      node("dep", 2, { parentThreadId: ThreadId.make("dep-parent"), outcome: "cancelled" }),
      node("waiter", 5, { spawnGeneration: "g2", blockedBy: ids("dep") }),
    ];
    const { rows } = layout(nodes);
    const fold = rowOf(rows, "wave:root:g1");
    expect(rows[fold]).toMatchObject({ kind: "fold", threadIds: ids("dep-parent", "dep") });
    expect(rows[fold]!.gutter.arcs).toMatchObject([{ kind: "waits", joins: "source" }]);
  });

  it("indents a sub-orchestrator's children one lane, and the fifth level shares the fourth", () => {
    const chainOf = ["l1", "l2", "l3", "l4", "l5"];
    const nodes = chainOf.map((id, index) =>
      node(id, index + 1, {
        parentThreadId: index === 0 ? ROOT : ThreadId.make(chainOf[index - 1]!),
      }),
    );
    const result = layout(nodes);
    expect(shape(result.rows)).toEqual([
      "wave 1",
      "thread l1@1",
      "thread l2@2",
      "thread l3@3",
      "thread l4@3",
      "thread l5@3",
    ]);
    expect(result.laneCount).toBe(4);
    expect(result.rows.map((row) => row.gutter.forkTo)).toEqual([1, 2, 3, null, null, null]);
  });

  it("folds a settled sub-orchestrator's descendants into its row behind a chevron", () => {
    const nodes = [
      node("lead", 1, { outcome: "done" }),
      node("kid", 2, { parentThreadId: ThreadId.make("lead"), outcome: "done" }),
      node("live", 3),
    ];
    const folded = layout(nodes, new Set(["wave:root:solo:lead"]));
    const lead = folded.rows[rowOf(folded.rows, "lead")]!;
    expect(lead).toMatchObject({ fold: { expanded: false, keys: ["lead"] } });
    expect(rowOf(folded.rows, "kid")).toBe(-1);
    const opened = layout(nodes, toggleFold(new Set(["wave:root:solo:lead"]), lead));
    expect(shape(opened.rows)).toContain("fold wave:lead:solo:kid@2");
    expect(opened.rows[rowOf(opened.rows, "lead")]).toMatchObject({
      fold: { expanded: true, keys: ["lead"] },
    });
  });

  it("leaves an arrow that would need a fifth slot undrawn and reports its waiter", () => {
    // Five waiters, each held by the thread just below it: every trunk overlaps every other.
    const nodes = [
      ...["d1", "d2", "d3", "d4", "d5"].map((id, index) => node(id, index + 1)),
      ...["w1", "w2", "w3", "w4", "w5"].map((id, index) =>
        node(id, 10 + index, { blockedBy: ids(`d${index + 1}`) }),
      ),
    ];
    const result = layout(nodes);
    expect(result.slotCount).toBe(4);
    expect([...result.undrawn]).toHaveLength(1);
    expect(layoutLanes(nodes, ROOT, new Set(), 62).undrawn.size).toBe(5);
  });
});
