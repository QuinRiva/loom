import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import type { SidebarThreadSummary } from "../types";
import { formatDiffMetric, getFanInChip, getGateWaitLabel } from "./workstreamPresentation";

// getFanInChip/formatDiffMetric only read a handful of fields; build a minimal
// shell and cast rather than a full fixture.
const summary = (over: Partial<SidebarThreadSummary>): SidebarThreadSummary =>
  ({
    id: ThreadId.make("child"),
    parentThreadId: ThreadId.make("parent"),
    isolation: "isolated",
    fanInState: "none",
    planLane: "in_progress",
    ...over,
  }) as unknown as SidebarThreadSummary;

describe("formatDiffMetric", () => {
  it("returns null when unmeasured (both null)", () => {
    expect(formatDiffMetric(null, null)).toBeNull();
  });
  it("renders a settled zero diff distinctly from unmeasured", () => {
    expect(formatDiffMetric(0, 0)).toBe("+0 −0");
  });
  it("sums added/deleted lines", () => {
    expect(formatDiffMetric(128, 40)).toBe("+128 −40");
    expect(formatDiffMetric(5, null)).toBe("+5 −0");
  });
});

describe("getFanInChip", () => {
  it("is null for shared threads", () => {
    expect(getFanInChip(summary({ isolation: "shared" }))).toBeNull();
  });
  it("shows an amber merge-conflict chip", () => {
    expect(getFanInChip(summary({ fanInState: "conflicted" }))).toEqual({
      label: "merge conflict",
      tone: "conflict",
    });
  });
  it("shows merged once settled", () => {
    expect(getFanInChip(summary({ fanInState: "completed" }))).toEqual({
      label: "merged",
      tone: "merged",
    });
  });
  it("shows merging while a done child's branch is still folding in", () => {
    expect(getFanInChip(summary({ planLane: "done", fanInState: "none" }))).toEqual({
      label: "merging…",
      tone: "merging",
    });
  });
  it("is null for a not-yet-terminal isolated child with nothing to show", () => {
    expect(getFanInChip(summary({ planLane: "in_progress", fanInState: "none" }))).toBeNull();
  });
});

describe("getGateWaitLabel", () => {
  const loopRoutes = [{ kind: "loop", on: ["needs_rework"], to: ThreadId.make("coder") }];
  const reviewer = (over: Partial<SidebarThreadSummary>) =>
    summary({
      id: ThreadId.make("reviewer"),
      routes: loopRoutes,
      gateRounds: 1,
      pendingRework: false,
      lastOutcome: { decision: "loop" },
      ...over,
    } as Partial<SidebarThreadSummary>);
  const coder = (over: Partial<SidebarThreadSummary>) =>
    summary({
      id: ThreadId.make("coder"),
      routes: [],
      gateRounds: 0,
      pendingRework: false,
      lastOutcome: { decision: "loop" },
      ...over,
    } as Partial<SidebarThreadSummary>);
  const byId = (threads: SidebarThreadSummary[]) => new Map(threads.map((t) => [t.id, t]));

  it("breaks the contradictory pair: the actively re-reviewing source wins over its stale waiting state", () => {
    // Both parties' stored gate state still reads waiting mid-hand-off, but the
    // reviewer has a running turn — it must show re-reviewing, never waiting.
    const rev = reviewer({ session: { status: "running" } } as Partial<SidebarThreadSummary>);
    const cod = coder({});
    const map = byId([rev, cod]);
    expect(getGateWaitLabel(rev, map)).toEqual({ label: "re-reviewing round 1", active: true });
    // The counterpart is the only one left showing a parked wait.
    expect(getGateWaitLabel(cod, map)).toEqual({ label: "awaiting re-review", active: false });
  });

  it("shows an active coder as reworking its round, never waiting", () => {
    const rev = reviewer({ pendingRework: false });
    const cod = coder({
      pendingRework: true,
      lastOutcome: null,
      latestTurn: { state: "running" },
    } as Partial<SidebarThreadSummary>);
    expect(getGateWaitLabel(cod, byId([rev, cod]))).toEqual({
      label: "reworking round 1",
      active: true,
    });
  });

  it("falls back to the parked waiting label when neither party is executing", () => {
    const rev = reviewer({});
    const cod = coder({});
    expect(getGateWaitLabel(rev, byId([rev, cod]))).toEqual({
      label: "waiting on rework",
      active: false,
    });
  });

  it("returns null off a gate", () => {
    expect(getGateWaitLabel(summary({ routes: [] }), new Map())).toBeNull();
  });
});
