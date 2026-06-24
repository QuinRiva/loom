import {
  type OrchestrationSession,
  type OrchestrationThreadShell,
  ProviderInstanceId,
  type ThreadId,
  type ThreadStatus,
  type TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildParentWakeMessage,
  DEFAULT_WAKE_RATE_GUARD,
  isParentIdle,
  isTerminalStatus,
  selectJoinedGenerations,
  selectThreadsToDispatch,
  wakeRateGuardTrips,
} from "./WorkstreamDispatcher.ts";

const now = "2026-06-24T00:00:00.000Z";

const shell = (
  overrides: Omit<Partial<OrchestrationThreadShell>, "id"> & { readonly id: string },
): OrchestrationThreadShell =>
  ({
    projectId: "project-1",
    goalId: null,
    parentThreadId: "parent-1" as ThreadId,
    role: "coder",
    purpose: "do the thing",
    status: "planned" as ThreadStatus,
    blockedBy: [],
    spawnGeneration: null,
    reportPath: null,
    title: "Sub-thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
    id: overrides.id as ThreadId,
  }) as OrchestrationThreadShell;

const ids = (threads: ReadonlyArray<OrchestrationThreadShell>) => threads.map((t) => t.id).sort();

describe("selectThreadsToDispatch", () => {
  it("promotes an un-started sub-thread with no dependencies", () => {
    expect(ids(selectThreadsToDispatch([shell({ id: "child-1" })]))).toEqual(["child-1"]);
  });

  it("ignores root threads (no parentThreadId)", () => {
    expect(selectThreadsToDispatch([shell({ id: "root-1", parentThreadId: null })])).toEqual([]);
  });

  it("does not promote a sub-thread that already has a started turn", () => {
    expect(selectThreadsToDispatch([shell({ id: "child-1", latestUserMessageAt: now })])).toEqual(
      [],
    );
  });

  it("does not promote a sub-thread that already has a provider session", () => {
    expect(
      selectThreadsToDispatch([
        shell({
          id: "child-1",
          session: {
            threadId: "child-1" as ThreadId,
            status: "running",
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        }),
      ]),
    ).toEqual([]);
  });

  it("gates a sub-thread until every dependency is done (review does not release)", () => {
    const threads = [
      shell({ id: "dep-coder", status: "review", latestUserMessageAt: now }),
      shell({ id: "child-reviewer", blockedBy: ["dep-coder" as ThreadId] }),
    ];
    expect(selectThreadsToDispatch(threads)).toEqual([]);
  });

  it("promotes the dependent once its dependency is done", () => {
    const threads = [
      shell({ id: "dep-coder", status: "done", latestUserMessageAt: now }),
      shell({ id: "child-reviewer", blockedBy: ["dep-coder" as ThreadId] }),
    ];
    expect(ids(selectThreadsToDispatch(threads))).toEqual(["child-reviewer"]);
  });

  it("does not gate on a non-sibling dependency (different parentThreadId)", () => {
    const threads = [
      shell({
        id: "cousin-coder",
        parentThreadId: "other-parent" as ThreadId,
        status: "running",
        latestUserMessageAt: now,
      }),
      shell({ id: "child-reviewer", blockedBy: ["cousin-coder" as ThreadId] }),
    ];
    expect(ids(selectThreadsToDispatch(threads))).toEqual(["child-reviewer"]);
  });

  it("treats self-refs and dangling dependency ids as non-gating", () => {
    const threads = [
      shell({
        id: "child-1",
        blockedBy: ["child-1" as ThreadId, "ghost-thread" as ThreadId],
      }),
    ];
    expect(ids(selectThreadsToDispatch(threads))).toEqual(["child-1"]);
  });

  it("skips sub-threads missing the role/purpose needed for a kick-off", () => {
    expect(selectThreadsToDispatch([shell({ id: "child-1", purpose: null })])).toEqual([]);
  });
});

const runningSession = (overrides: Partial<OrchestrationSession> = {}): OrchestrationSession => ({
  threadId: "parent-1" as ThreadId,
  status: "running",
  providerName: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeMode: "full-access",
  activeTurnId: "turn-1" as TurnId,
  lastError: null,
  updatedAt: now,
  ...overrides,
});

const genIds = (groups: ReadonlyArray<{ parentId: ThreadId; generation: string }>) =>
  groups.map((g) => `${g.parentId}::${g.generation}`).sort();

describe("isTerminalStatus", () => {
  it("treats done, blocked, and review as terminal wake triggers", () => {
    expect((["done", "blocked", "review"] as const).every(isTerminalStatus)).toBe(true);
    expect((["planned", "running"] as const).some(isTerminalStatus)).toBe(false);
  });
});

describe("selectJoinedGenerations", () => {
  it("joins a generation only once every member is terminal", () => {
    const partial = [
      shell({ id: "a", spawnGeneration: "gen-1", status: "done", latestUserMessageAt: now }),
      shell({ id: "b", spawnGeneration: "gen-1", status: "running", latestUserMessageAt: now }),
    ];
    expect(selectJoinedGenerations(partial)).toEqual([]);

    const complete = [
      shell({ id: "a", spawnGeneration: "gen-1", status: "done", latestUserMessageAt: now }),
      shell({ id: "b", spawnGeneration: "gen-1", status: "review", latestUserMessageAt: now }),
    ];
    expect(genIds(selectJoinedGenerations(complete))).toEqual(["parent-1::gen-1"]);
  });

  it("scopes the join per (parent, generation) so a later generation wakes independently", () => {
    const threads = [
      // earlier long-running generation, still active → must not block gen-2
      shell({ id: "old", spawnGeneration: "gen-1", status: "running", latestUserMessageAt: now }),
      shell({ id: "new", spawnGeneration: "gen-2", status: "done", latestUserMessageAt: now }),
    ];
    expect(genIds(selectJoinedGenerations(threads))).toEqual(["parent-1::gen-2"]);
  });

  it("ignores children without a spawn generation or parent", () => {
    const threads = [
      shell({ id: "root", parentThreadId: null, spawnGeneration: "gen-1", status: "done" }),
      shell({ id: "ungen", spawnGeneration: null, status: "done", latestUserMessageAt: now }),
    ];
    expect(selectJoinedGenerations(threads)).toEqual([]);
  });
});

describe("isParentIdle", () => {
  it("is idle with no session, no pending turn-start, and no active turn", () => {
    expect(isParentIdle(shell({ id: "parent-1", session: null }), new Set())).toBe(true);
  });

  it("is busy while the session is running", () => {
    expect(isParentIdle(shell({ id: "parent-1", session: runningSession() }), new Set())).toBe(
      false,
    );
  });

  it("is busy while a turn-start is pending even though activeTurnId is null", () => {
    const parent = shell({
      id: "parent-1",
      session: runningSession({ status: "idle", activeTurnId: null }),
    });
    expect(isParentIdle(parent, new Set(["parent-1" as ThreadId]))).toBe(false);
  });

  it("is busy while an active turn is set", () => {
    const parent = shell({
      id: "parent-1",
      session: runningSession({ status: "ready", activeTurnId: "turn-9" as TurnId }),
    });
    expect(isParentIdle(parent, new Set())).toBe(false);
  });
});

describe("wakeRateGuardTrips", () => {
  it("does not trip on a slow-cadence job (one wake every few minutes)", () => {
    const now = 10_000_000;
    const slow = Array.from({ length: 50 }, (_unused, index) => now - index * 5 * 60_000);
    expect(wakeRateGuardTrips(slow, now)).toBe(false);
  });

  it("trips on a tight spin-loop (many wakes in the rolling window)", () => {
    const now = 10_000_000;
    const tight = Array.from({ length: DEFAULT_WAKE_RATE_GUARD.maxInWindow }, () => now - 100);
    expect(wakeRateGuardTrips(tight, now)).toBe(true);
  });

  it("trips on the absolute backstop regardless of cadence", () => {
    const now = 10_000_000;
    const many = Array.from(
      { length: DEFAULT_WAKE_RATE_GUARD.absoluteBackstop },
      (_unused, index) => now - index * 60 * 60_000,
    );
    expect(wakeRateGuardTrips(many, now)).toBe(true);
  });
});

describe("buildParentWakeMessage", () => {
  it("includes each child's role, id, status, and report, plus the review instruction", () => {
    const text = buildParentWakeMessage([
      {
        id: "child-1" as ThreadId,
        role: "researcher",
        status: "done",
        report: "# Findings\nAll good.",
      },
      { id: "child-2" as ThreadId, role: "reviewer", status: "review", report: null },
    ]);
    expect(text).toContain("researcher");
    expect(text).toContain("child-1");
    expect(text).toContain("done");
    expect(text).toContain("All good.");
    expect(text).toContain("No report was filed");
    expect(text).toContain("workstream_set_status");
  });
});
