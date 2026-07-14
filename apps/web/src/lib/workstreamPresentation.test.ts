import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import type { SidebarThreadSummary } from "../types";
import type { OrchestrationEvent } from "@t3tools/contracts";
import {
  buildThreadLifecycleRows,
  describeOutcomeVerdict,
  formatDiffMetric,
  getAttentionPulse,
  getEffectiveColumn,
  getFanInBadge,
  getFanInChip,
  getGateWaitLabel,
  getLoopEdgeStroke,
  isAwaitingBrief,
} from "./workstreamPresentation";
import type { ChildIndex } from "./workstreamPresentation";

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

const EMPTY_INDEX: ChildIndex = new Map();

describe("isAwaitingBrief", () => {
  it("is true for a released child with no kickoff brief", () => {
    expect(isAwaitingBrief(summary({ planLane: "ready", kickoffBriefPath: null }))).toBe(true);
  });
  it("is false once a brief is attached", () => {
    expect(isAwaitingBrief(summary({ planLane: "ready", kickoffBriefPath: "/b.md" }))).toBe(false);
  });
  it("is false for a held (planned) node — the hold dominates the review window", () => {
    expect(isAwaitingBrief(summary({ planLane: "planned", kickoffBriefPath: null }))).toBe(false);
  });
  it("is false for a root thread (roots carry their kickoff as the brief string)", () => {
    expect(
      isAwaitingBrief(summary({ planLane: "ready", kickoffBriefPath: null, parentThreadId: null })),
    ).toBe(false);
  });
});

describe("getEffectiveColumn", () => {
  it("maps a released, unbriefed, dependency-free child to awaiting_brief", () => {
    expect(
      getEffectiveColumn(
        summary({ planLane: "ready", kickoffBriefPath: null, blockedBy: [] }),
        EMPTY_INDEX,
      ),
    ).toBe("awaiting_brief");
  });
  it("a briefed released child is ready", () => {
    expect(
      getEffectiveColumn(
        summary({ planLane: "ready", kickoffBriefPath: "/b.md", blockedBy: [] }),
        EMPTY_INDEX,
      ),
    ).toBe("ready");
  });
  it("unmet deps win over the brief gate (blocked, matching wake eligibility)", () => {
    const dep = ThreadId.make("dep");
    const index: ChildIndex = new Map([[dep, summary({ id: dep, planLane: "in_progress" })]]);
    expect(
      getEffectiveColumn(
        summary({ planLane: "ready", kickoffBriefPath: null, blockedBy: [dep] }),
        index,
      ),
    ).toBe("blocked");
  });
});

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

describe("getLoopEdgeStroke", () => {
  const loopRoutes = [{ kind: "loop", on: ["needs_rework"], to: ThreadId.make("coder") }];
  const gate = (over: Partial<SidebarThreadSummary>) =>
    summary({
      routes: loopRoutes,
      gateRounds: 0,
      pendingRework: false,
      lastOutcome: null,
      ...over,
    } as Partial<SidebarThreadSummary>);
  const outcome = (over: Record<string, unknown>) =>
    ({ decision: "loop", round: 1, ...over }) as unknown as SidebarThreadSummary["lastOutcome"];

  it("tints amber on a needs_rework verdict, matching the chip", () => {
    expect(getLoopEdgeStroke(gate({ lastOutcome: outcome({ outcome: "needs_rework" }) }))).toBe(
      "#f59e0b",
    );
  });
  it("tints emerald once settled clean or fixed_inline", () => {
    expect(
      getLoopEdgeStroke(gate({ lastOutcome: outcome({ decision: "resolve", outcome: "clean" }) })),
    ).toBe("#34d399");
    expect(
      getLoopEdgeStroke(
        gate({ lastOutcome: outcome({ decision: "resolve", outcome: "fixed_inline" }) }),
      ),
    ).toBe("#34d399");
  });
  it("tints violet for a yielded/cap-breach outcome (decision wins over the token)", () => {
    // Regression: a cap-breach carrying a needs_rework token must read violet
    // (yielded), never amber — the edge follows getVerdictChip's decision-first
    // precedence exactly.
    expect(
      getLoopEdgeStroke(
        gate({ lastOutcome: outcome({ decision: "cap-breach", outcome: "needs_rework" }) }),
      ),
    ).toBe("#a78bfa");
  });
  it("falls back to the neutral round-depth violet with no recorded verdict", () => {
    expect(getLoopEdgeStroke(gate({ gateRounds: 0 }))).toBe("#c4b5fd");
    expect(getLoopEdgeStroke(gate({ gateRounds: 2 }))).toBe("#8b5cf6");
  });
});

describe("getAttentionPulse", () => {
  it("is null with no human-blocking attention", () => {
    expect(getAttentionPulse(summary({ attention: [] }))).toBeNull();
  });
  it("pulses rose for error, the highest-priority reason", () => {
    expect(
      getAttentionPulse(summary({ attention: ["awaiting_acceptance", "error"] })),
    ).toMatchObject({ reason: "error", stroke: "#fb7185" });
  });
  it("pulses orange for needs_guidance", () => {
    expect(getAttentionPulse(summary({ attention: ["needs_guidance"] }))).toMatchObject({
      reason: "needs_guidance",
      stroke: "#fb923c",
    });
  });
});

describe("getFanInBadge", () => {
  it("is null when there is no fan-in chip", () => {
    expect(getFanInBadge(summary({ isolation: "shared" }))).toBeNull();
  });
  it("warns amber on a merge conflict", () => {
    expect(getFanInBadge(summary({ fanInState: "conflicted" }))).toEqual({
      glyph: "!",
      stroke: "#f59e0b",
      label: "merge conflict",
    });
  });
  it("ticks emerald once merged", () => {
    expect(getFanInBadge(summary({ fanInState: "completed" }))).toMatchObject({
      glyph: "✓",
      stroke: "#34d399",
    });
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

describe("buildThreadLifecycleRows", () => {
  // Lifecycle events only read `type`/`payload`/`eventId`/`occurredAt`; build
  // minimal members and cast rather than full event fixtures.
  const ev = (
    eventId: string,
    type: string,
    payload: Record<string, unknown>,
  ): OrchestrationEvent =>
    ({
      eventId,
      type,
      occurredAt: "2026-07-13T00:00:00.000Z",
      payload,
    }) as unknown as OrchestrationEvent;

  it("reads a plan-lane-set to in_progress after a yield as a resume, else a start", () => {
    const rows = buildThreadLifecycleRows([
      ev("a", "thread.plan-lane-set", { planLane: "in_progress" }),
      ev("b", "thread.plan-lane-set", { planLane: "yielded" }),
      ev("c", "thread.plan-lane-set", { planLane: "in_progress" }),
    ]);
    expect(rows.map((r) => r.label)).toEqual(["Started", "Yielded", "Resumed"]);
    expect(rows[2]?.deepLink).toBe(true);
  });

  it("labels a terminal gate reopen (in_progress after done, no spawnGeneration) as Reopened", () => {
    // Real gate shape: a round-0-completed coder reopened for rework — the
    // second in_progress carries no spawnGeneration (thread 2279d9a0-…).
    const rows = buildThreadLifecycleRows([
      ev("a", "thread.plan-lane-set", { planLane: "in_progress" }),
      ev("b", "thread.plan-lane-set", { planLane: "yielded" }),
      ev("c", "thread.plan-lane-set", { planLane: "in_progress" }),
      ev("d", "thread.plan-lane-set", { planLane: "done" }),
      ev("e", "thread.plan-lane-set", { planLane: "in_progress" }),
    ]);
    expect(rows.map((r) => r.label)).toEqual(["Started", "Yielded", "Resumed", "Done", "Reopened"]);
    expect(rows[4]).toMatchObject({ tone: "sky", deepLink: true });
  });

  it("maps outcomes to the shared verdict vocabulary (label + tone), deep-linkable", () => {
    const rows = buildThreadLifecycleRows([
      ev("a", "thread.outcome-recorded", { outcome: "needs_rework", decision: "loop", round: 2 }),
      ev("b", "thread.outcome-recorded", {
        outcome: "fixed_inline",
        decision: "resolve",
        round: 3,
      }),
      ev("c", "thread.outcome-recorded", { outcome: "clean", decision: "resolve", round: 3 }),
    ]);
    // Labels/tones come from describeOutcomeVerdict — fixed_inline stays distinct.
    expect(rows[0]).toMatchObject({ label: "needs rework \u27f22", tone: "amber", deepLink: true });
    expect(rows[1]).toMatchObject({ label: "fixed inline", tone: "emerald", deepLink: true });
    expect(rows[2]).toMatchObject({ label: "clean", tone: "emerald", deepLink: true });
    // Chip and timeline agree (single source): same label off the primitive.
    expect(
      describeOutcomeVerdict({ outcome: "fixed_inline", decision: "resolve", round: 3 })?.chip
        .label,
    ).toBe("fixed inline");
  });

  it("folds a full needs_rework→fixed_inline gate journey with attention + fan-in in order", () => {
    const rows = buildThreadLifecycleRows([
      ev("a", "thread.plan-lane-set", { planLane: "in_progress" }),
      ev("b", "thread.outcome-recorded", { outcome: "needs_rework", decision: "loop", round: 1 }),
      ev("c", "thread.route-taken", { to: "coder", round: 1 }),
      ev("d", "thread.attention-raised", { reason: "needs_guidance" }),
      ev("e", "thread.attention-cleared", {}),
      ev("f", "thread.outcome-recorded", {
        outcome: "fixed_inline",
        decision: "resolve",
        round: 2,
      }),
      ev("g", "thread.fanin-set", { fanInState: "conflicted" }),
      ev("h", "thread.fanin-set", { fanInState: "completed" }),
    ]);
    expect(rows.map((r) => r.label)).toEqual([
      "Started",
      "needs rework \u27f21",
      "Rework round 1 opened",
      "Attention raised",
      "Attention cleared",
      "fixed inline",
      "merge conflict",
      "merged",
    ]);
    expect(rows.find((r) => r.label === "merge conflict")).toMatchObject({
      tone: "amber",
      deepLink: false,
    });
    expect(rows.find((r) => r.label === "merged")).toMatchObject({
      tone: "emerald",
      deepLink: false,
    });
  });

  it("marks a terminal reopen (spawnGeneration) to ready distinctly from a first release", () => {
    const [released, reopened] = buildThreadLifecycleRows([
      ev("a", "thread.plan-lane-set", { planLane: "ready" }),
      ev("b", "thread.plan-lane-set", { planLane: "ready", spawnGeneration: "g2" }),
    ]);
    expect(released?.label).toBe("Released");
    expect(reopened?.label).toBe("Reopened");
  });

  it("renders attention rows without deep-links", () => {
    const rows = buildThreadLifecycleRows([
      ev("a", "thread.attention-raised", { reason: "needs_guidance" }),
    ]);
    expect(rows[0]).toMatchObject({ label: "Attention raised", tone: "amber", deepLink: false });
  });
});
