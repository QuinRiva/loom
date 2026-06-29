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

import type { ProjectionToolActivitySignal } from "../Services/ProjectionSnapshotQuery.ts";
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

const sig = (summary: string, detail: string | null = null): ProjectionToolActivitySignal => ({
  summary,
  detail,
});

const base = {
  thread: thread(),
  session: session(),
  maxActivityCreatedAtMs: now,
  toolSignals: [] as ReadonlyArray<ProjectionToolActivitySignal>,
  failureCount: 0,
  now,
  thresholds: DEFAULT_LIVENESS_THRESHOLDS,
};

describe("normalizeToolSignature", () => {
  it("collapses identical tool calls to one signature and separates distinct commands", () => {
    const a = normalizeToolSignature({ summary: "Ran command", detail: "ls -la" });
    const b = normalizeToolSignature({ summary: "Ran command", detail: "ls -la" });
    const c = normalizeToolSignature({ summary: "Ran command", detail: "git status" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("detectActivityLoop", () => {
  it("flags >=3 consecutive identical detailed calls", () => {
    expect(
      detectActivityLoop(
        [
          sig("Ran command", "ls"),
          sig("Ran command", "ls"),
          sig("Ran command", "ls"),
          sig("Read file", "a.ts"),
        ],
        3,
      ),
    ).toBe(true);
  });
  it("flags A,B,A,B,A,B two-call detailed alternation", () => {
    const a = sig("Ran command", "git status");
    const b = sig("Read file", "a.ts");
    expect(detectActivityLoop([a, b, a, b, a, b], 3)).toBe(true);
  });
  it("does not flag genuine progress", () => {
    expect(
      detectActivityLoop(
        [
          sig("Ran command", "a"),
          sig("Ran command", "b"),
          sig("Ran command", "c"),
          sig("Ran command", "d"),
        ],
        3,
      ),
    ).toBe(false);
    expect(detectActivityLoop([sig("Ran command", "a"), sig("Ran command", "a")], 3)).toBe(false);
  });

  // Fix B — the fail-safe guard, covering BOTH detector branches.
  it("does NOT flag >=3 identical detail-less signatures (identical-run branch)", () => {
    expect(
      detectActivityLoop([sig("Ran command"), sig("Ran command"), sig("Ran command")], 3),
    ).toBe(false);
  });
  it("does NOT flag a detail-less read/edit alternation (alternation branch)", () => {
    const read = sig("Read file");
    const edit = sig("Changed files");
    expect(detectActivityLoop([read, edit, read, edit, read, edit], 3)).toBe(false);
  });
  it("still flags >=3 identical DETAILED signatures", () => {
    expect(
      detectActivityLoop(
        [sig("Ran command", "npm t"), sig("Ran command", "npm t"), sig("Ran command", "npm t")],
        3,
      ),
    ).toBe(true);
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
      toolSignals: [sig("Ran command", "ls"), sig("Ran command", "ls"), sig("Ran command", "ls")],
    });
    expect(verdict?.kind).toBe("loop");
  });

  it("does not flag a loop when the repeated signatures carry no detail", () => {
    const verdict = classifyLiveness({
      ...base,
      maxActivityCreatedAtMs: now,
      toolSignals: [sig("Ran command"), sig("Ran command"), sig("Ran command")],
    });
    expect(verdict).toBeNull();
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
