/** The shared wake vocabulary, ported from V1's `WorkstreamDispatcher.test.ts` and retyped. */
import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  IsoDateTime,
  ThreadId,
  type WorkOutcomeRecord,
  type WorkstreamRoute,
} from "@t3tools/contracts";

import {
  buildChildWakeMessage,
  declaredEstimateMs,
  formatWakeTimestamp,
  groupBatchForWake,
  parseEtaMarkerMs,
  renderWakePair,
  renderWakeSingle,
  slowToolDeferralMs,
  slowToolEstimateClause,
  slowToolNoticeIndex,
  type WakeMember,
  workstreamLane,
} from "./wakes.ts";

const m = (mins: number) => mins * 60_000;
const at = IsoDateTime.make("2026-07-07T14:32:00.000Z");

const member = (
  overrides: Omit<Partial<WakeMember>, "id"> & { readonly id: string },
): WakeMember => ({
  role: "coder",
  outcome: "done",
  attention: [],
  reportPath: null,
  report: null,
  lastOutcome: null,
  gateRounds: 0,
  routes: [],
  eventAt: at,
  releasedDependents: [],
  ...overrides,
  id: ThreadId.make(overrides.id),
});
const resolveRoutes = (to: string): ReadonlyArray<WorkstreamRoute> => [
  { on: ["needs_rework"], kind: "loop", to: ThreadId.make(to), maxRounds: 2 },
  { on: ["clean", "fixed_inline"], kind: "resolve" },
];
const outcomeRecord = (
  outcome: string,
  decision: WorkOutcomeRecord["decision"] = "resolve",
): WorkOutcomeRecord => ({ outcome, decision, round: 0, eventId: EventId.make("evt-1"), at });

describe("workstreamLane (V1's plan lane, derived)", () => {
  const node = (patch: Partial<Parameters<typeof workstreamLane>[0]> = {}) => ({
    id: ThreadId.make("n"),
    parentThreadId: ThreadId.make("p"),
    held: false,
    outcome: null,
    kickoffAt: null,
    kickoffBriefPath: null,
    blockedBy: [],
    archivedAt: null,
    deletedAt: null,
    ...patch,
  });
  it("reads outcome, then held, then started, then dependencies", () => {
    const dep = node({ id: ThreadId.make("dep") });
    const byId = new Map([[dep.id, dep]]);
    assert.equal(workstreamLane(node({ outcome: "cancelled", held: true }), byId), "cancelled");
    assert.equal(workstreamLane(node({ held: true, kickoffAt: at }), byId), "held");
    assert.equal(workstreamLane(node({ kickoffAt: at }), byId), "in_progress");
    assert.equal(workstreamLane(node({ blockedBy: [dep.id] }), byId), "blocked");
    assert.equal(workstreamLane(node(), byId), "ready");
  });
});

describe("groupBatchForWake + pair rendering", () => {
  it("pairs a resolve-source with its in-batch loop target; singles pass through", () => {
    const { pairs, singles } = groupBatchForWake([
      member({
        id: "rev",
        role: "reviewer",
        routes: resolveRoutes("cod"),
        lastOutcome: outcomeRecord("clean"),
      }),
      member({ id: "cod" }),
      member({ id: "solo", role: "researcher" }),
    ]);
    assert.deepEqual(
      pairs.map((p) => [p.source.id, p.target.id]),
      [["rev", "cod"]],
    );
    assert.deepEqual(
      singles.map((s) => s.id),
      ["solo"],
    );
  });

  it("leaves a resolve-source as a single when its target is absent from the batch", () => {
    const { pairs, singles } = groupBatchForWake([
      member({ id: "rev", routes: resolveRoutes("cod"), lastOutcome: outcomeRecord("clean") }),
    ]);
    assert.lengthOf(pairs, 0);
    assert.deepEqual(
      singles.map((s) => s.id),
      ["rev"],
    );
  });

  it("does NOT pair a force-dissolved gate (source terminal without a resolve verdict)", () => {
    const forced = member({
      id: "rev",
      role: "reviewer",
      outcome: "cancelled",
      routes: resolveRoutes("cod"),
    });
    const coder = member({ id: "cod", reportPath: "/r/cod.md", report: "work" });
    const { pairs } = groupBatchForWake([forced, coder]);
    assert.lengthOf(pairs, 0);
    const coderSingle = renderWakeSingle(coder);
    assert.include(coderSingle, "☑️");
    assert.include(coderSingle, "work");
    assert.notInclude(coderSingle, "verified by the gate");
    assert.notInclude(renderWakeSingle(forced), "Gate resolved");
  });

  it("does NOT pair a gate looped back (source outcome is loop, not resolve)", () => {
    const { pairs } = groupBatchForWake([
      member({
        id: "rev",
        routes: resolveRoutes("cod"),
        lastOutcome: outcomeRecord("needs_rework", "loop"),
      }),
      member({ id: "cod" }),
    ]);
    assert.lengthOf(pairs, 0);
  });

  it("renders a pair as ONE section: verdict, rounds, source excerpt, target reference only", () => {
    const text = renderWakePair({
      source: member({
        id: "rev",
        role: "reviewer",
        routes: resolveRoutes("cod"),
        gateRounds: 2,
        lastOutcome: outcomeRecord("clean"),
        reportPath: "/r/rev.md",
        report: "Clean. Both findings resolved.",
        releasedDependents: [{ id: ThreadId.make("tail"), role: "integration" }],
      }),
      target: member({
        id: "cod",
        reportPath: "/r/cod-r2.md",
        report: "THIS_TARGET_EXCERPT_MUST_NOT_APPEAR",
      }),
    });
    for (const fragment of [
      "Gate resolved `clean`",
      "reviewer `rev`",
      "coder `cod`",
      "2 rework rounds",
      "integration `tail`",
      "2026-07-07 14:32Z",
      "Clean. Both findings resolved.",
      "/r/cod-r2.md",
      "verified by the gate",
    ])
      assert.include(text, fragment);
    assert.notInclude(text, "THIS_TARGET_EXCERPT_MUST_NOT_APPEAR");
    assert.notInclude(text, "fan-in");
  });
});

describe("formatWakeTimestamp", () => {
  it("formats a UTC event time and drops null/unparseable", () => {
    assert.equal(formatWakeTimestamp("2026-07-07T14:32:09.000Z"), "2026-07-07 14:32Z");
    assert.equal(formatWakeTimestamp(null), "");
    assert.equal(formatWakeTimestamp("not-a-date"), "");
  });
});

describe("buildChildWakeMessage", () => {
  const child = {
    id: ThreadId.make("child-1"),
    role: "coder",
    lane: "in_progress" as const,
    attention: [] as const,
    reportPath: "child-1.md",
  };

  it("recovered: the prior error verdict is superseded and dependents are released", () => {
    const text = buildChildWakeMessage(
      { ...child, lane: "done" },
      "recovered",
      "# Findings\nAll good.",
    );
    for (const fragment of [
      "recovered",
      "superseded",
      "child-1.md",
      "All good.",
      "already been released",
    ])
      assert.include(text, fragment);
    assert.notInclude(text, "stay gated");
  });

  it("attention: names the flags and status and never claims the child finished", () => {
    const text = buildChildWakeMessage(
      { ...child, attention: ["needs_guidance"] },
      "attention",
      null,
    );
    for (const fragment of [
      "paused",
      "needs_guidance",
      "in_progress",
      "NOT finished",
      "child-1.md",
      "stay gated",
    ])
      assert.include(text, fragment);
  });

  it("attention on a wedged child names the cancelled dependency and the re-plan moves", () => {
    const text = buildChildWakeMessage(
      { ...child, lane: "blocked", attention: ["needs_guidance"] },
      "attention",
      null,
      { quietMs: 0, cancelledDependency: ThreadId.make("dep-x") },
    );
    assert.include(text, "`dep-x`, which was cancelled");
    assert.include(text, "mcp__t3-code__workstream_set_dependencies");
    assert.notInclude(text, "is paused and needs attention");
  });

  it("frozen attention: the frozen turn and the stop-then-prompt recovery", () => {
    const text = buildChildWakeMessage(
      { ...child, attention: ["needs_guidance"] },
      "attention",
      null,
      {
        quietMs: m(12),
        frozen: true,
      },
    );
    for (const fragment of [
      "frozen",
      "needs_guidance",
      "~12 min",
      "NOT finished",
      "mcp__t3-code__workstream_stop",
      "mcp__t3-code__workstream_prompt",
      "stay gated",
    ])
      assert.include(text, fragment);
  });

  it("slow-tool: informational, names the tool and durations, lists the options", () => {
    const text = buildChildWakeMessage({ ...child, reportPath: null }, "slow-tool", null, {
      quietMs: m(6),
      toolName: "bash",
      inFlightMs: m(7),
    });
    for (const fragment of [
      "Informational notice",
      "`bash`",
      "~7 min",
      "~6 min",
      "will not interrupt",
      "no agent-visible output",
      "NOT a hang verdict",
    ])
      assert.include(text, fragment);
    assert.notInclude(text, "error");
    assert.notInclude(text, "No report was filed");
  });

  it("names tools only in their prefixed form", () => {
    for (const kind of [
      "error",
      "attention",
      "awaiting-input",
      "recovered",
      "slow-tool",
    ] as const) {
      const text = buildChildWakeMessage({ ...child, attention: ["needs_guidance"] }, kind, null);
      assert.notMatch(
        text,
        /(?<!mcp__t3-code__)\b(workstream_\w+|consult_thread|ask_user_question)/,
      );
      assert.notInclude(text, "set_lane");
    }
  });
});

describe("slow-tool ladder", () => {
  it("slowToolNoticeIndex: 5/15/30 min steps, then every 30 min; deferral shifts the ladder", () => {
    assert.equal(slowToolNoticeIndex(m(5) - 1), -1);
    assert.deepEqual(
      [5, 14, 15, 29, 30, 59, 60, 90].map((min) => slowToolNoticeIndex(m(min))),
      [0, 0, 1, 1, 2, 2, 3, 4],
    );
    assert.deepEqual(
      [29, 30, 39, 40, 55, 85].map((min) => slowToolNoticeIndex(m(min), m(30))),
      [-1, 0, 0, 1, 2, 3],
    );
    for (const min of [4, 5, 14, 15, 30, 60, 90])
      assert.equal(slowToolNoticeIndex(m(min), m(5)), slowToolNoticeIndex(m(min)));
  });

  it("parseEtaMarkerMs: a `#`-anchored marker only", () => {
    assert.equal(parseEtaMarkerMs("# eta: 25m\npython run.py"), m(25));
    assert.equal(parseEtaMarkerMs("# eta: 1.5h"), m(90));
    assert.equal(parseEtaMarkerMs("# ETA=25m"), m(25));
    assert.equal(parseEtaMarkerMs("python run.py  # eta: 45m"), m(45));
    for (const text of [
      "echo eta 90m",
      "grep eta 90m file",
      null,
      "# eta: 0m",
      "# eta soon",
      "./theta 5m",
    ])
      assert.isNull(parseEtaMarkerMs(text));
  });

  it("declaredEstimateMs and slowToolDeferralMs", () => {
    assert.equal(declaredEstimateMs({ commandText: "# eta: 25m x", timeoutSeconds: 1800 }), m(25));
    assert.equal(declaredEstimateMs({ commandText: "python run.py", timeoutSeconds: 1800 }), m(30));
    assert.isNull(declaredEstimateMs({ commandText: null, timeoutSeconds: 0 }));
    assert.equal(slowToolDeferralMs(null), m(5));
    assert.equal(slowToolDeferralMs(m(1)), m(5));
    assert.equal(slowToolDeferralMs(m(25)), m(30));
    assert.equal(slowToolDeferralMs(m(300)), m(144));
  });

  it("slowToolEstimateClause: overrun on exact ms, otherwise the estimate cap", () => {
    assert.isNull(slowToolEstimateClause({ estimateMs: undefined, inFlightMs: m(30) }));
    assert.include(
      slowToolEstimateClause({ estimateMs: m(25), inFlightMs: m(31) })!,
      "now overrun",
    );
    const capped = slowToolEstimateClause({ estimateMs: m(300), inFlightMs: m(145) })!;
    assert.include(capped, "estimate was capped at the 120-min");
    assert.notInclude(
      slowToolEstimateClause({ estimateMs: m(145) + 24_000, inFlightMs: m(145) })!,
      "now overrun",
    );
  });
});
