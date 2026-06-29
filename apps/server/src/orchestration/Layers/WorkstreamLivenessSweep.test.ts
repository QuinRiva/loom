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

import { classifyLiveness, DEFAULT_LIVENESS_THRESHOLDS } from "./WorkstreamLivenessSweep.ts";

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
});
