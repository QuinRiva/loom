// @effect-diagnostics nodeBuiltinImport:off - the cache-warm case writes a variant fixture to a temp dir.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { IMAGE_TOKENS, readPiSessionContext } from "./piSessionContext.ts";

const fixture = (name: string) => NodePath.join(import.meta.dirname, "fixtures", name);
const read = async (path: string) => (await readPiSessionContext(path))!;
const byId = async (name: string) => {
  const session = await read(fixture(name));
  return { session, item: (id: string) => session.items.find((item) => item.id === id)! };
};

describe("readPiSessionContext", () => {
  it("gives a gap with one item the whole measured budget", async () => {
    const { item } = await byId("identity.jsonl");
    expect(item("t1")).toMatchObject({ tokens: 1000, measured: true, firstSeenCall: 1 });
  });

  it("splits a shared gap by characters and sums to the budget", async () => {
    const { item } = await byId("identity.jsonl");
    expect([item("t2").tokens, item("t3").tokens]).toEqual([3000, 1000]);
    expect(item("t2").measured || item("t3").measured).toBe(false);
  });

  it("reserves image tokens before the character split", async () => {
    const { session, item } = await byId("identity.jsonl");
    const [prev, call] = [session.calls[2]!, session.calls[3]!];
    expect(item("t4").tokens).toBe(IMAGE_TOKENS + 100);
    expect(item("t4").tokens + item("t5").tokens).toBe(call.ctx - prev.ctx - prev.output);
  });

  it("rolls an aborted call's items into the next valid gap", async () => {
    const { session, item } = await byId("identity.jsonl");
    expect(session.calls[5]!.valid).toBe(false);
    expect(item("e014")).toMatchObject({ firstSeenCall: 6, userKind: "control_plane_notice" });
    expect(item("e014").tokens + item("e016").tokens).toBe(22863 - 22143 - 120);
    expect(session.diagnostics).toEqual({ malformedLines: 0, negativeGaps: 0, invalidCalls: 1 });
  });

  it("attributes every token of the latest prompt", async () => {
    for (const name of ["identity.jsonl", "compaction.jsonl"]) {
      const { session } = await byId(name);
      const inWindow = session.items.filter((item) => item.inWindow);
      expect(inWindow.reduce((sum, item) => sum + item.tokens, 0)).toBe(session.totals.latestCtx);
    }
  });

  it("retires what a later system entry replaces or removes", async () => {
    const replacement = JSON.stringify({
      type: "message",
      id: "sys2",
      timestamp: "2026-10-28T01:02:00.000Z",
      message: {
        role: "system",
        content: "",
        sections: { addendum: "a shorter addendum" },
        toolsRemoved: [{ name: "demo_schedule_task" }],
      },
    });
    const lines = NodeFS.readFileSync(fixture("identity.jsonl"), "utf8").split("\n");
    const at = lines.findIndex((line) => line.includes("Try again."));
    const path = NodePath.join(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "context-viz-")),
      "s.jsonl",
    );
    NodeFS.writeFileSync(path, [...lines.slice(0, at), replacement, ...lines.slice(at)].join("\n"));
    const session = await read(path);
    const item = (id: string) => session.items.find((entry) => entry.id === id)!;
    for (const id of ["e001:addendum", "e001:demo_schedule_task"]) {
      expect(item(id)).toMatchObject({ inWindow: false, carriedCalls: 5 });
    }
    expect(item("sys2:addendum")).toMatchObject({ inWindow: true, firstSeenCall: 6 });
    const inWindow = session.items.filter((entry) => entry.inWindow);
    expect(inWindow.reduce((sum, entry) => sum + entry.tokens, 0)).toBe(session.totals.latestCtx);
  });

  it("opens a new series at a compaction with one measured base item", async () => {
    const { session, item } = await byId("compaction.jsonl");
    expect(session.calls.map((call) => [call.ctx, call.series])).toEqual([
      [5000, 0],
      [7100, 0],
      [3000, 1],
      [3560, 1],
    ]);
    expect(session.items.filter((entry) => entry.firstSeenCall === 2)).toEqual([
      expect.objectContaining({
        id: "cmp001",
        kind: "compaction_base",
        tokens: 3000,
        measured: true,
      }),
    ]);
    expect(item("c1").carriedCalls).toBe(1);
  });

  it("counts a cache-warm ping without touching the context", async () => {
    const source = fixture("identity.jsonl");
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "context-viz-"));
    const cold = NodePath.join(dir, "no-warm.jsonl");
    const lines = NodeFS.readFileSync(source, "utf8").split("\n");
    NodeFS.writeFileSync(cold, lines.filter((line) => !line.includes('"cache_warm"')).join("\n"));
    const [warm, without] = [await read(source), await read(cold)];
    expect([warm.totals.cacheWarmCount, without.totals.cacheWarmCount]).toEqual([1, 0]);
    const strip = (session: typeof warm) => ({
      calls: session.calls,
      items: session.items,
      totals: { ...session.totals, cacheWarmCount: 0, cacheWarmCostUsd: 0 },
    });
    expect(strip(warm)).toEqual(strip(without));
  });
});
