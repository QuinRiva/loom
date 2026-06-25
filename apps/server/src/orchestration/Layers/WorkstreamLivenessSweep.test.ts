import {
  type OrchestrationSession,
  type OrchestrationThreadShell,
  ProviderInstanceId,
  type ThreadId,
  type ThreadStatus,
  type TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  classifyLiveness,
  DEFAULT_LIVENESS_THRESHOLDS,
  detectActivityLoop,
  normalizeToolSignature,
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
    status: "running" as ThreadStatus,
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
  toolSignatures: [] as ReadonlyArray<string>,
  failureCount: 0,
  now,
  thresholds: DEFAULT_LIVENESS_THRESHOLDS,
};

describe("normalizeToolSignature", () => {
  it("collapses identical tool calls to one signature and separates different targets", () => {
    const a = normalizeToolSignature({
      kind: "tool.completed",
      itemType: "read",
      summary: "read foo.ts",
      detail: "1-50",
    });
    const b = normalizeToolSignature({
      kind: "tool.completed",
      itemType: "read",
      summary: "read foo.ts",
      detail: "1-50",
    });
    const c = normalizeToolSignature({
      kind: "tool.completed",
      itemType: "read",
      summary: "read bar.ts",
      detail: "1-50",
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("detectActivityLoop", () => {
  it("flags >=3 consecutive identical calls", () => {
    expect(detectActivityLoop(["x", "x", "x", "y"], 3)).toBe(true);
  });
  it("flags A,B,A,B,A,B two-call alternation", () => {
    expect(detectActivityLoop(["a", "b", "a", "b", "a", "b"], 3)).toBe(true);
  });
  it("does not flag genuine progress", () => {
    expect(detectActivityLoop(["a", "b", "c", "d"], 3)).toBe(false);
    expect(detectActivityLoop(["x", "x"], 3)).toBe(false);
  });
});

describe("classifyLiveness", () => {
  it("returns null for a healthy, recently-active turn", () => {
    expect(classifyLiveness(base)).toBeNull();
  });

  it("trips the circuit breaker once consecutive failures reach the cap", () => {
    expect(classifyLiveness({ ...base, failureCount: 3 })?.kind).toBe("dead");
    expect(classifyLiveness({ ...base, failureCount: 2 })).toBeNull();
  });

  it("flags a mid-turn stall when no activity row is newer than the stale window", () => {
    const verdict = classifyLiveness({ ...base, maxActivityCreatedAtMs: now - 11 * 60_000 });
    expect(verdict?.kind).toBe("stalled");
  });

  it("respects the startup grace so a slow first tool call is not a stall", () => {
    const young = thread({
      latestTurn: { ...thread().latestTurn!, startedAt: minsAgo(1), requestedAt: minsAgo(1) },
    });
    const verdict = classifyLiveness({
      ...base,
      thread: young,
      maxActivityCreatedAtMs: now - 11 * 60_000,
    });
    expect(verdict).toBeNull();
  });

  it("flags a stuck loop independent of activity freshness", () => {
    const verdict = classifyLiveness({
      ...base,
      maxActivityCreatedAtMs: now,
      toolSignatures: ["x", "x", "x"],
    });
    expect(verdict?.kind).toBe("loop");
  });

  it("does not run active-turn detectors when there is no active turn", () => {
    const verdict = classifyLiveness({
      ...base,
      session: session({ status: "ready", activeTurnId: null }),
      maxActivityCreatedAtMs: now - 11 * 60_000,
    });
    expect(verdict).toBeNull();
  });
});
