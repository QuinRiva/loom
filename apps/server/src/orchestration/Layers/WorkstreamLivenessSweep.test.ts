import {
  type OrchestrationSession,
  type OrchestrationThreadShell,
  ProviderInstanceId,
  type ThreadId,
  type ThreadPlanLane,
  type TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  buildStallNudgeMessage,
  classifyLiveness,
  computeProgressFingerprint,
  decideProgressLoop,
  decideStallAction,
  DEFAULT_LIVENESS_THRESHOLDS,
  type ProgressLoopState,
} from "./WorkstreamLivenessSweep.ts";

const now = Date.parse("2026-06-24T00:00:00.000Z");
const minsAgo = (m: number) => DateTime.formatIso(DateTime.makeUnsafe(now - m * 60_000));

const session = (overrides: Partial<OrchestrationSession> = {}): OrchestrationSession => ({
  threadId: "child-1" as ThreadId,
  status: "running",
  providerName: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeMode: "full-access",
  activeTurnId: "turn-1" as TurnId,
  lastError: null,
  queuedMessages: { steering: [], followUp: [] },
  updatedAt: minsAgo(0),
  ...overrides,
});

const thread = (overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell =>
  ({
    id: "child-1" as ThreadId,
    projectId: "project-1",
    goalId: null,
    parentThreadId: "parent-1" as ThreadId,
    role: "coder",
    purpose: "x",
    planLane: "in_progress" as ThreadPlanLane,
    attention: [],
    blockedBy: [],
    spawnGeneration: null,
    reportPath: null,
    title: "Sub-thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId: "turn-1" as TurnId,
      state: "running",
      requestedAt: minsAgo(30),
      startedAt: minsAgo(30),
      completedAt: null,
      assistantMessageId: null,
    },
    createdAt: minsAgo(60),
    updatedAt: minsAgo(0),
    archivedAt: null,
    session: session(),
    latestUserMessageAt: minsAgo(30),
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  }) as OrchestrationThreadShell;

const base = {
  thread: thread(),
  session: session(),
  maxActivityCreatedAtMs: now,
  heartbeatMs: now,
  hasInFlightTool: false,
  failureCount: 0,
  now,
  thresholds: DEFAULT_LIVENESS_THRESHOLDS,
};

describe("classifyLiveness", () => {
  it("returns null for a healthy, recently-active turn", () => {
    expect(classifyLiveness(base)).toBeNull();
  });

  it("trips the circuit breaker once consecutive failures reach the cap", () => {
    expect(classifyLiveness({ ...base, failureCount: 3 })?.kind).toBe("dead");
    expect(classifyLiveness({ ...base, failureCount: 2 })).toBeNull();
  });

  it("flags a mid-turn stall when the heartbeat is frozen past the stale window", () => {
    const verdict = classifyLiveness({
      ...base,
      maxActivityCreatedAtMs: now - 11 * 60_000,
      heartbeatMs: now - 11 * 60_000,
    });
    expect(verdict?.kind).toBe("stalled");
  });

  it("does NOT flag a stall when the heartbeat is fresh despite stale activity rows (long reasoning)", () => {
    // The core Phase-1 fix: a child streaming reasoning for >10 min with no
    // tool/activity row keeps a fresh heartbeat and must not read as stalled.
    const verdict = classifyLiveness({
      ...base,
      maxActivityCreatedAtMs: now - 11 * 60_000,
      heartbeatMs: now - 1_000,
    });
    expect(verdict).toBeNull();
  });

  it("never flags a child waiting for input/approvals as stalled or dead (State B)", () => {
    const stale = { heartbeatMs: now - 11 * 60_000, maxActivityCreatedAtMs: now - 11 * 60_000 };
    expect(
      classifyLiveness({ ...base, ...stale, thread: thread({ hasPendingUserInput: true }) }),
    ).toBeNull();
    expect(
      classifyLiveness({
        ...base,
        thread: thread({ hasPendingApprovals: true }),
        failureCount: 3,
      }),
    ).toBeNull();
  });

  it("respects the startup grace so a slow first tool call is not a stall", () => {
    const young = thread({
      latestTurn: { ...thread().latestTurn!, startedAt: minsAgo(1), requestedAt: minsAgo(1) },
    });
    const verdict = classifyLiveness({
      ...base,
      thread: young,
      maxActivityCreatedAtMs: now - 11 * 60_000,
      heartbeatMs: now - 11 * 60_000,
    });
    expect(verdict).toBeNull();
  });

  it("does not run the stall detector when there is no active turn", () => {
    const verdict = classifyLiveness({
      ...base,
      session: session({ status: "ready", activeTurnId: null }),
      maxActivityCreatedAtMs: now - 11 * 60_000,
      heartbeatMs: now - 11 * 60_000,
    });
    expect(verdict).toBeNull();
  });

  it("does NOT flag a stall while a tool call is in flight (class 2 — slow-but-alive)", () => {
    // A quiet-but-running tool call is informational territory (the
    // dispatcher's slow-tool notice rail), never a State-C fault: a steer
    // cannot penetrate a blocked call and long calls are often legitimate.
    const verdict = classifyLiveness({
      ...base,
      hasInFlightTool: true,
      maxActivityCreatedAtMs: now - 25 * 60_000,
      heartbeatMs: now - 25 * 60_000,
    });
    expect(verdict).toBeNull();
  });

  it("tags the stalled verdict with the effective-activity episode key", () => {
    const frozenAt = now - 11 * 60_000;
    const verdict = classifyLiveness({
      ...base,
      maxActivityCreatedAtMs: frozenAt,
      heartbeatMs: frozenAt,
    });
    expect(verdict?.kind).toBe("stalled");
    expect(verdict?.effectiveActivityMs).toBe(frozenAt);
  });
});

describe("decideStallAction (escalation ladder)", () => {
  const ladder = {
    msSinceNudge: null as number | null,
    nudgeGraceMs: DEFAULT_LIVENESS_THRESHOLDS.stallNudgeGraceMs,
  };

  it("nudges on the first sweep of a stall episode (open turn)", () => {
    expect(
      decideStallAction({ ...ladder, priorEpisodeMs: null, episodeMs: 100, hasOpenTurn: true }),
    ).toBe("nudge");
  });

  it("escalates when the same episode is still frozen after the nudge grace", () => {
    expect(
      decideStallAction({
        ...ladder,
        priorEpisodeMs: 100,
        episodeMs: 100,
        hasOpenTurn: true,
        msSinceNudge: DEFAULT_LIVENESS_THRESHOLDS.stallNudgeGraceMs,
      }),
    ).toBe("escalate");
  });

  it("waits (neither re-nudges nor escalates) while the nudge is within its grace", () => {
    expect(
      decideStallAction({
        ...ladder,
        priorEpisodeMs: 100,
        episodeMs: 100,
        hasOpenTurn: true,
        msSinceNudge: DEFAULT_LIVENESS_THRESHOLDS.stallNudgeGraceMs - 1,
      }),
    ).toBe("wait");
  });

  it("re-arms to nudge when the heartbeat advanced (new episode)", () => {
    expect(
      decideStallAction({
        ...ladder,
        priorEpisodeMs: 100,
        episodeMs: 250,
        hasOpenTurn: true,
        msSinceNudge: 30_000,
      }),
    ).toBe("nudge");
  });

  it("escalates instead of nudging when there is no open turn to steer into", () => {
    expect(
      decideStallAction({ ...ladder, priorEpisodeMs: null, episodeMs: 100, hasOpenTurn: false }),
    ).toBe("escalate");
  });
});

describe("computeProgressFingerprint (State D)", () => {
  it("changes when the within-turn tool content changes (real progress)", () => {
    const a = computeProgressFingerprint({ recentInputsSource: "editA", checkpointSource: "1|x" });
    const b = computeProgressFingerprint({ recentInputsSource: "editB", checkpointSource: "1|x" });
    expect(a).not.toBe(b);
  });

  it("is stable when the exact same content is re-emitted (spin)", () => {
    const sig = { recentInputsSource: "same-call", checkpointSource: "1|x" };
    expect(computeProgressFingerprint(sig)).toBe(computeProgressFingerprint(sig));
  });

  it("changes when only the checkpoint advances (cross-turn corroborator)", () => {
    const a = computeProgressFingerprint({ recentInputsSource: "r", checkpointSource: "1|x" });
    const b = computeProgressFingerprint({ recentInputsSource: "r", checkpointSource: "2|y" });
    expect(a).not.toBe(b);
  });

  it("does not collide null-vs-empty across the two source fields", () => {
    // Guards the delimiter: "a"+null must differ from null+"a".
    const a = computeProgressFingerprint({ recentInputsSource: "a", checkpointSource: null });
    const b = computeProgressFingerprint({ recentInputsSource: null, checkpointSource: "a" });
    expect(a).not.toBe(b);
  });
});

describe("decideProgressLoop (State D)", () => {
  const window = DEFAULT_LIVENESS_THRESHOLDS.noProgressWindowMs;
  const armed = (over: Partial<ProgressLoopState> = {}): ProgressLoopState => ({
    fingerprint: "fp1",
    flatSinceMs: now - window - 1,
    advised: false,
    ...over,
  });

  it("first observation arms the clock and never advises", () => {
    const r = decideProgressLoop({
      prior: null,
      fingerprint: "fp1",
      now,
      noProgressWindowMs: window,
    });
    expect(r.advise).toBe(false);
    expect(r.next).toEqual({ fingerprint: "fp1", flatSinceMs: now, advised: false });
  });

  it("a growing/oscillating diff re-arms and NEVER advises (the false-positive shape)", () => {
    const r = decideProgressLoop({
      prior: armed(),
      fingerprint: "fp2",
      now,
      noProgressWindowMs: window,
    });
    expect(r.advise).toBe(false);
    expect(r.next).toEqual({ fingerprint: "fp2", flatSinceMs: now, advised: false });
  });

  it("flat but still within the window does not advise yet", () => {
    const r = decideProgressLoop({
      prior: { fingerprint: "fp1", flatSinceMs: now - window + 1000, advised: false },
      fingerprint: "fp1",
      now,
      noProgressWindowMs: window,
    });
    expect(r.advise).toBe(false);
  });

  it("flat past the window advises exactly once per episode", () => {
    const first = decideProgressLoop({
      prior: armed(),
      fingerprint: "fp1",
      now,
      noProgressWindowMs: window,
    });
    expect(first.advise).toBe(true);
    expect(first.next.advised).toBe(true);
    const second = decideProgressLoop({
      prior: first.next,
      fingerprint: "fp1",
      now: now + 60_000,
      noProgressWindowMs: window,
    });
    expect(second.advise).toBe(false);
  });

  it("re-arms after progress so a later flat episode can advise again", () => {
    const advised = armed({ advised: true });
    const rearmed = decideProgressLoop({
      prior: advised,
      fingerprint: "fp9",
      now,
      noProgressWindowMs: window,
    });
    expect(rearmed.next.advised).toBe(false);
    const later = decideProgressLoop({
      prior: { ...rearmed.next, flatSinceMs: now - window - 1 },
      fingerprint: "fp9",
      now,
      noProgressWindowMs: window,
    });
    expect(later.advise).toBe(true);
  });
});

describe("buildStallNudgeMessage", () => {
  const verdict = {
    kind: "stalled" as const,
    reason: "Mid-turn stall: ...",
    effectiveActivityMs: 1,
  };

  it("carries the control-plane marker and the extracted tool error", () => {
    const text = buildStallNudgeMessage(verdict, {
      source: "tool-error",
      toolName: "edit",
      detail: "Validation failed for tool edit",
    });
    expect(text).toContain("control plane");
    expect(text).toContain("not from the user");
    expect(text).toContain("`edit`");
    expect(text).toContain("Validation failed for tool edit");
  });

  it("degrades to a generic account when no context was extracted", () => {
    const text = buildStallNudgeMessage(verdict, null);
    expect(text).toContain("control plane");
    expect(text).toContain("no specific error");
  });
});
