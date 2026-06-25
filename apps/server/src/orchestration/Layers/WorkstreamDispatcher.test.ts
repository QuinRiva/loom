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
  classifyGenerationByReceipts,
  DEFAULT_WAKE_RATE_GUARD,
  isTerminalStatus,
  selectJoinedGenerations,
  selectThreadsToDispatch,
  WAKE_REPORT_EXCERPT_LIMIT,
  wakeRateGuardTrips,
} from "./WorkstreamDispatcher.ts";
import { isThreadIdle } from "../threadIdle.ts";
import { workstreamChildPrompt } from "../workstreamChildPrompt.ts";

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
            queuedMessages: { steering: [], followUp: [] },
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
  queuedMessages: { steering: [], followUp: [] },
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

describe("isThreadIdle", () => {
  it("is idle with no session, no pending turn-start, and no active turn", () => {
    expect(isThreadIdle(shell({ id: "parent-1", session: null }), new Set())).toBe(true);
  });

  it("is busy while the session is running", () => {
    expect(isThreadIdle(shell({ id: "parent-1", session: runningSession() }), new Set())).toBe(
      false,
    );
  });

  it("is busy while a turn-start is pending even though activeTurnId is null", () => {
    const parent = shell({
      id: "parent-1",
      session: runningSession({ status: "idle", activeTurnId: null }),
    });
    expect(isThreadIdle(parent, new Set(["parent-1" as ThreadId]))).toBe(false);
  });

  it("is busy while an active turn is set", () => {
    const parent = shell({
      id: "parent-1",
      session: runningSession({ status: "ready", activeTurnId: "turn-9" as TurnId }),
    });
    expect(isThreadIdle(parent, new Set())).toBe(false);
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
  it("carries each child's role, id, status, report reference, and a short report inline", () => {
    const text = buildParentWakeMessage([
      {
        id: "child-1" as ThreadId,
        role: "researcher",
        status: "done",
        reportPath: "child-1.md",
        report: "# Findings\nAll good.",
      },
      {
        id: "child-2" as ThreadId,
        role: "reviewer",
        status: "review",
        reportPath: null,
        report: null,
      },
    ]);
    expect(text).toContain("researcher");
    expect(text).toContain("child-1");
    expect(text).toContain("done");
    // Short reports fit inline under the bound.
    expect(text).toContain("All good.");
    // The on-disk pointer is referenced, never the raw content alone.
    expect(text).toContain("child-1.md");
    expect(text).toContain("No report was filed");
    expect(text).toContain("workstream_set_status");
  });

  it("bounds an oversized report to an excerpt + reference, never the full text", () => {
    const tail = "TAIL_MARKER_SHOULD_NOT_APPEAR";
    const report = `${"x".repeat(WAKE_REPORT_EXCERPT_LIMIT + 50)}${tail}`;
    const text = buildParentWakeMessage([
      {
        id: "child-1" as ThreadId,
        role: "researcher",
        status: "done",
        reportPath: "child-1.md",
        report,
      },
    ]);
    expect(text).toContain("child-1.md");
    expect(text).toContain("excerpt truncated");
    expect(text).not.toContain(tail);
    expect(text).not.toContain(report);
  });
});

// Fix B regression: the park handled-check keys off the FIRST durable park
// write (the `blocked` status.set), so a crash/restart between the two park
// writes leaves the generation PARKED — never redelivered as a normal wake —
// and reconciles the missing activity marker instead. This is the pure decision
// seam the dispatcher uses per generation; the receipt round-trip through the
// engine is exercised here via the booleans it derives from the receipt store.
describe("classifyGenerationByReceipts", () => {
  it("delivers a fresh generation with no receipts", () => {
    expect(
      classifyGenerationByReceipts({
        wakeDelivered: false,
        parkBlocked: false,
        parkMarkerPresent: false,
      }),
    ).toEqual({ kind: "deliverable" });
  });

  it("never re-delivers a generation whose wake receipt exists", () => {
    expect(
      classifyGenerationByReceipts({
        wakeDelivered: true,
        parkBlocked: false,
        parkMarkerPresent: false,
      }),
    ).toEqual({ kind: "already-woken" });
  });

  it("treats a generation with only the block receipt as parked (crash between park writes / restart) and flags the marker for reconciliation — NOT a wake", () => {
    const decision = classifyGenerationByReceipts({
      wakeDelivered: false,
      parkBlocked: true,
      parkMarkerPresent: false,
    });
    expect(decision).toEqual({ kind: "parked", reconcileMarker: true });
    // The crucial property: a block-only generation is never "deliverable".
    expect(decision.kind).not.toBe("deliverable");
  });

  it("treats a fully parked generation (both writes landed) as parked with no reconciliation", () => {
    expect(
      classifyGenerationByReceipts({
        wakeDelivered: false,
        parkBlocked: true,
        parkMarkerPresent: true,
      }),
    ).toEqual({ kind: "parked", reconcileMarker: false });
  });
});

// Fix C (deferred-until-idle): a joined generation whose parent is BUSY is gated
// by `isThreadIdle` so no wake is delivered (and, with `requireIdle`, no receipt
// is written) until the parent goes idle, at which point the same generation
// becomes eligible and redelivers exactly once. The full engine deferral
// round-trip is not runnable here (see note below); this covers the pure
// decision the dispatcher composes: join × idle-gate.
describe("deferred wake gates on parent idleness", () => {
  const generation = [
    shell({ id: "child-a", spawnGeneration: "gen-1", status: "done", latestUserMessageAt: now }),
    shell({ id: "child-b", spawnGeneration: "gen-1", status: "review", latestUserMessageAt: now }),
  ];

  it("joins the generation regardless of whether the parent is busy", () => {
    expect(genIds(selectJoinedGenerations(generation))).toEqual(["parent-1::gen-1"]);
  });

  it("withholds the wake while the parent is busy and releases it once idle", () => {
    const busyParent = shell({ id: "parent-1", session: runningSession() });
    // Busy → not idle → dispatcher skips delivery (writes no receipt).
    expect(isThreadIdle(busyParent, new Set())).toBe(false);
    // Same parent, turn ended (session ready, no active turn) → idle → eligible.
    const idleParent = shell({
      id: "parent-1",
      session: runningSession({ status: "ready", activeTurnId: null }),
    });
    expect(isThreadIdle(idleParent, new Set())).toBe(true);
  });
});

describe("kick-off prompt brief/purpose resolution", () => {
  // The dispatcher's promoteThread feeds `brief ?? purpose` into
  // workstreamChildPrompt, so the full brief drives the child's first turn when
  // present and the short purpose is the fallback when it is absent.
  const resolve = (purpose: string, brief: string | null) =>
    workstreamChildPrompt({ role: "coder", brief: brief ?? purpose });

  it("uses the brief as the prompt body when a brief is present", () => {
    const prompt = resolve("short summary", "the full self-contained kickoff brief");
    expect(prompt).toContain("the full self-contained kickoff brief");
    expect(prompt).not.toContain("short summary");
  });

  it("falls back to the purpose when the brief is absent", () => {
    const prompt = resolve("short summary", null);
    expect(prompt).toContain("short summary");
  });
});
