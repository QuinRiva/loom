import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import {
  type OrchestrationCommand,
  type OrchestrationLatestTurn,
  type OrchestrationSession,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
  ProviderInstanceId,
  type ThreadId,
  type ThreadPlanLane,
  type TurnId,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vite-plus/test";

import {
  buildChildWakeMessage,
  buildParentWakeMessage,
  childWakeCommandId,
  classifyChildWake,
  classifyGenerationByReceipts,
  DEFAULT_IDLE_WAKE_GRACE_MS,
  DEFAULT_WAKE_RATE_GUARD,
  IDLE_WAKE_REPASS_INTERVAL_MS,
  idleLastProgressMs,
  idleWakeWithinGrace,
  selectThreadsToDispatch,
  WAKE_REPORT_EXCERPT_LIMIT,
  WorkstreamDispatcherLive,
  wakeRateGuardTrips,
} from "./WorkstreamDispatcher.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import { WorkstreamDispatcher } from "../Services/WorkstreamDispatcher.ts";
import { selectJoinedGenerations } from "@t3tools/shared/workstreamGraph";
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
    // Default to a released lane so the un-started promotion tests exercise the
    // dispatcher; held (`planned`) and other lanes are set per-test.
    planLane: "ready" as ThreadPlanLane,
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

  it("does not promote a held `planned` sub-thread even with deps clear (the release gate)", () => {
    expect(selectThreadsToDispatch([shell({ id: "child-1", planLane: "planned" })])).toEqual([]);
  });

  it("promotes the same sub-thread once it is released to `ready`", () => {
    expect(ids(selectThreadsToDispatch([shell({ id: "child-1", planLane: "ready" })]))).toEqual([
      "child-1",
    ]);
  });

  it("gates a sub-thread until every dependency is done (a non-done lane does not release)", () => {
    const threads = [
      shell({
        id: "dep-coder",
        planLane: "in_progress",
        attention: ["awaiting_acceptance"],
        latestUserMessageAt: now,
      }),
      shell({ id: "child-reviewer", blockedBy: ["dep-coder" as ThreadId] }),
    ];
    expect(selectThreadsToDispatch(threads)).toEqual([]);
  });

  it("promotes the dependent once its dependency is done", () => {
    const threads = [
      shell({ id: "dep-coder", planLane: "done", latestUserMessageAt: now }),
      shell({ id: "child-reviewer", blockedBy: ["dep-coder" as ThreadId] }),
    ];
    expect(ids(selectThreadsToDispatch(threads))).toEqual(["child-reviewer"]);
  });

  it("keeps the dependent gated on an `error`-flagged dependency, then promotes it once it reaches `done`", () => {
    // Dependent release is done-only, so an errored dependency keeps the
    // dependent waiting; the same promote pass releases it once the dependency
    // recovers to `done` (no special-casing of the error→done flip needed).
    const errored = [
      shell({ id: "dep-coder", attention: ["error"], latestUserMessageAt: now }),
      shell({ id: "child-reviewer", blockedBy: ["dep-coder" as ThreadId] }),
    ];
    expect(selectThreadsToDispatch(errored)).toEqual([]);
    const recovered = [
      shell({ id: "dep-coder", planLane: "done", latestUserMessageAt: now }),
      shell({ id: "child-reviewer", blockedBy: ["dep-coder" as ThreadId] }),
    ];
    expect(ids(selectThreadsToDispatch(recovered))).toEqual(["child-reviewer"]);
  });

  it("does not gate on a non-sibling dependency (different parentThreadId)", () => {
    const threads = [
      shell({
        id: "cousin-coder",
        parentThreadId: "other-parent" as ThreadId,
        planLane: "in_progress",
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
  it("carries each child's role, id, plan lane, report reference, and a short report inline", () => {
    const text = buildParentWakeMessage([
      {
        id: "child-1" as ThreadId,
        role: "researcher",
        planLane: "done",
        reportPath: "child-1.md",
        report: "# Findings\nAll good.",
      },
      {
        id: "child-2" as ThreadId,
        role: "reviewer",
        planLane: "in_progress",
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
    expect(text).toContain("workstream_set_lane");
  });

  it("bounds an oversized report to an excerpt + reference, never the full text", () => {
    const tail = "TAIL_MARKER_SHOULD_NOT_APPEAR";
    const report = `${"x".repeat(WAKE_REPORT_EXCERPT_LIMIT + 50)}${tail}`;
    const text = buildParentWakeMessage([
      {
        id: "child-1" as ThreadId,
        role: "researcher",
        planLane: "done",
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
    shell({ id: "child-a", spawnGeneration: "gen-1", planLane: "done", latestUserMessageAt: now }),
    shell({
      id: "child-b",
      spawnGeneration: "gen-1",
      planLane: "in_progress",
      attention: ["awaiting_acceptance"],
      latestUserMessageAt: now,
    }),
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

describe("buildChildWakeMessage (recovered re-notifies the parent of an error→done flip)", () => {
  it("tells the parent the prior error verdict is superseded and dependents are released", () => {
    const text = buildChildWakeMessage(
      { id: "child-1" as ThreadId, role: "reviewer", reportPath: "child-1.md" },
      "recovered",
      "# Findings\nAll good.",
    );
    expect(text).toContain("recovered");
    expect(text).toContain("superseded");
    expect(text).toContain("child-1.md");
    expect(text).toContain("All good.");
    // Recovery tail differs from the error/idle tail: deps already released, no
    // manual resolution to do.
    expect(text).toContain("already been released");
    expect(text).not.toContain("stay gated");
  });
});

describe("classifyChildWake (per-child wake rail, §1e)", () => {
  it("classifies an `error`-flagged child as an error wake", () => {
    const child = shell({ id: "child-1", attention: ["error"], session: null });
    expect(classifyChildWake(child, new Set())).toBe("error");
  });

  it("classifies a ran-then-idle non-terminal child as a forgot-to-finish idle wake", () => {
    const child = shell({
      id: "child-1",
      planLane: "in_progress",
      session: runningSession({ status: "ready", activeTurnId: null }),
    });
    expect(classifyChildWake(child, new Set())).toBe("idle");
  });

  it("does NOT wake a never-started held child (no session → waiting on release/deps)", () => {
    const child = shell({ id: "child-1", planLane: "planned", session: null });
    expect(classifyChildWake(child, new Set())).toBeNull();
  });

  it("does NOT wake a child still mid-turn", () => {
    const child = shell({
      id: "child-1",
      planLane: "in_progress",
      session: runningSession({ status: "running", activeTurnId: "turn-1" as TurnId }),
    });
    expect(classifyChildWake(child, new Set())).toBeNull();
  });

  it("does NOT wake a child whose turn-start is still pending (kickoff race)", () => {
    const child = shell({
      id: "child-1",
      planLane: "in_progress",
      session: runningSession({ status: "ready", activeTurnId: null }),
    });
    expect(classifyChildWake(child, new Set(["child-1" as ThreadId]))).toBeNull();
  });

  it("does NOT wake plan-terminal done/cancelled children", () => {
    for (const planLane of ["done", "cancelled"] as const) {
      const child = shell({
        id: "child-1",
        planLane,
        session: runningSession({ status: "ready", activeTurnId: null }),
      });
      expect(classifyChildWake(child, new Set())).toBeNull();
    }
  });

  it("does NOT idle-wake a child that already carries an attention flag (already surfaced)", () => {
    const child = shell({
      id: "child-1",
      planLane: "in_progress",
      attention: ["needs_guidance"],
      session: runningSession({ status: "ready", activeTurnId: null }),
    });
    expect(classifyChildWake(child, new Set())).toBeNull();
  });

  it("does NOT wake a top-level thread (no agent parent)", () => {
    const child = shell({
      id: "root-1",
      parentThreadId: null,
      attention: ["error"],
      session: null,
    });
    expect(classifyChildWake(child, new Set())).toBeNull();
  });

  it("keys idle episodes on the activity sequence so a quiet child is not re-nagged but re-arms on new work", () => {
    const a = childWakeCommandId("child-1" as ThreadId, "idle:7");
    const b = childWakeCommandId("child-1" as ThreadId, "idle:7");
    const c = childWakeCommandId("child-1" as ThreadId, "idle:12");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith("server:")).toBe(true);
  });
});

const latestTurn = (overrides: Partial<OrchestrationLatestTurn> = {}): OrchestrationLatestTurn => ({
  turnId: "turn-1" as TurnId,
  state: "completed",
  requestedAt: now,
  startedAt: now,
  completedAt: now,
  assistantMessageId: null,
  ...overrides,
});

// `now` (2026-06-24T00:00:00.000Z) is the reference instant; `earlier` is 60s
// before it. ISO literals + Date.parse are used (the `new Date()` constructor is
// banned by an effect lint rule, and the production code parses with Date.parse).
const earlier = "2026-06-23T23:59:00.000Z";
const t0 = Date.parse(now);

describe("idleLastProgressMs", () => {
  it("prefers the newest activity timestamp over the turn timing", () => {
    expect(idleLastProgressMs(now, latestTurn({ completedAt: earlier }))).toBe(t0);
  });

  it("falls back to the turn completion (idle onset) when there is no activity row", () => {
    expect(idleLastProgressMs(null, latestTurn({ completedAt: now }))).toBe(t0);
  });

  it("falls back to the turn start when there is no activity and no completion", () => {
    expect(idleLastProgressMs(null, latestTurn({ startedAt: now, completedAt: null }))).toBe(t0);
  });

  it("is null when nothing is known (session-bearing child with no activity and no turn)", () => {
    expect(idleLastProgressMs(null, null)).toBeNull();
  });
});

// The decisive regression coverage for the false-positive fix: a ran-then-idle
// child must NOT be woken "forgot to finish" the instant its turn completes (the
// between-turns window of a multi-turn child); it is woken only after a full
// grace window of no activity, and that re-evaluation happens via the scheduled
// re-pass even when no further domain event arrives.
describe("idle-wake activity-freshness grace", () => {
  const graceMs = DEFAULT_IDLE_WAKE_GRACE_MS;

  const idleChild = shell({
    id: "child-1",
    planLane: "in_progress",
    session: runningSession({ status: "ready", activeTurnId: null }),
    latestTurn: latestTurn({ completedAt: now }),
  });
  const lastProgress = idleLastProgressMs(now, idleChild.latestTurn);

  it("still classifies the ran-then-idle child as an idle wake (kind unchanged)", () => {
    expect(classifyChildWake(idleChild, new Set())).toBe("idle");
  });

  it("WITHHOLDS the idle wake while activity is fresher than the grace window", () => {
    // 5s after the turn completed — deep inside the 10m grace (between-turns).
    expect(idleWakeWithinGrace(lastProgress, t0 + 5_000, graceMs)).toBe(true);
  });

  it("FIRES the idle wake once activity has been quiet longer than the grace window", () => {
    expect(idleWakeWithinGrace(lastProgress, t0 + graceMs + 1, graceMs)).toBe(false);
  });

  it("re-pass semantics: the SAME suppressed child becomes eligible once the window elapses, with no new event", () => {
    // First (event-driven) pass right after turn completion: suppressed.
    expect(idleWakeWithinGrace(lastProgress, t0 + 5_000, graceMs)).toBe(true);
    // The scheduled re-pass interval is bounded by the grace, so a later tick
    // re-evaluates the child and it then fires exactly once.
    expect(IDLE_WAKE_REPASS_INTERVAL_MS).toBeLessThanOrEqual(graceMs);
    expect(
      idleWakeWithinGrace(lastProgress, t0 + graceMs + IDLE_WAKE_REPASS_INTERVAL_MS, graceMs),
    ).toBe(false);
  });

  it("withholds rather than firing eagerly when last-progress is unknown", () => {
    expect(idleWakeWithinGrace(null, t0 + graceMs * 10, graceMs)).toBe(true);
  });
});

// The decisive end-to-end coverage for the scheduled re-pass machinery: not the
// pure grace helper (covered above) but the assembled dispatcher layer driving
// its forked `Schedule.spaced` fiber under a deterministic `TestClock`. This is
// the assertion the reviewer flagged as missing — it proves a genuinely-idle
// child is woken EXACTLY ONCE after the grace elapses with NO triggering domain
// event, and that further re-pass ticks are idempotent.
describe("idle-wake scheduled re-pass (TestClock, full dispatcher layer)", () => {
  const PARENT_ID = "parent-repass" as ThreadId;
  const CHILD_ID = "child-repass" as ThreadId;
  // TestClock starts at epoch (t=0); a last-progress at epoch is "fresh" at t=0
  // (now - lastProgress === 0 < grace) and goes stale only once the clock is
  // advanced past the grace window.
  const epochIso = "1970-01-01T00:00:00.000Z";

  // Root parent (no parentThreadId → never promoted, never itself a child wake)
  // that is idle (no session), so it is an eligible wake target.
  const parent = shell({ id: PARENT_ID as unknown as string, parentThreadId: null, session: null });
  // Ran-then-idle sub-thread: latest turn completed, session ready, activeTurnId
  // null → classifyChildWake → "idle". Its freshness (below) is fresh at t=0.
  const child = shell({
    id: CHILD_ID as unknown as string,
    parentThreadId: PARENT_ID,
    planLane: "in_progress",
    session: runningSession({ threadId: CHILD_ID, status: "ready", activeTurnId: null }),
    latestTurn: latestTurn({ completedAt: epochIso }),
  });

  const buildLayer = (dispatched: Array<OrchestrationCommand>) => {
    const engine = {
      readEvents: () => Stream.empty,
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
      // No domain events: the ONLY thing that can re-run a pass is the forked
      // schedule, so any wake delivered after t=0 is proof the re-pass fired.
      streamDomainEvents: Stream.empty,
    } as unknown as OrchestrationEngineShape;

    const snapshotQuery = {
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 1,
          goals: [],
          projects: [],
          threads: [parent, child],
          updatedAt: epochIso,
        } satisfies OrchestrationShellSnapshot),
      getPendingTurnStartThreadIds: () => Effect.succeed(new Set<ThreadId>()),
      getActivityFreshnessByThreadId: () =>
        Effect.succeed({ maxCreatedAt: epochIso, maxSequence: 42, heartbeatAt: null }),
    } as unknown as ProjectionSnapshotQueryShape;

    // Empty receipt store: cross-pass dedup must therefore be carried by the
    // in-memory `handledChildWakes` set (the real machinery under test), not by
    // a receipt short-circuit.
    const receipts = {
      upsert: () => Effect.void,
      getByCommandId: () => Effect.succeed(Option.none()),
    };

    return WorkstreamDispatcherLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(OrchestrationEngineService, engine),
          Layer.succeed(ProjectionSnapshotQuery, snapshotQuery),
          Layer.succeed(OrchestrationCommandReceiptRepository, receipts as never),
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-workstream-dispatcher-repass-" }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );
  };

  effectIt.effect(
    "withholds the idle wake while fresh, then delivers exactly one after the grace via the re-pass, idempotent thereafter",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dispatched: Array<OrchestrationCommand> = [];
          yield* Effect.gen(function* () {
            const dispatcher = yield* WorkstreamDispatcher;
            yield* dispatcher.start();

            // (1) Initial pass(es) at t=0: activity is fresh (within grace) → no
            // idle wake delivered to the parent.
            yield* dispatcher.drain;
            expect(dispatched.length).toBe(0);

            // (2) No domain event arrives; advance past the grace so the next
            // scheduled re-pass tick re-evaluates the now-stale child and wakes
            // the parent exactly once.
            yield* TestClock.adjust(
              Duration.millis(DEFAULT_IDLE_WAKE_GRACE_MS + IDLE_WAKE_REPASS_INTERVAL_MS),
            );
            yield* dispatcher.drain;
            // No-silent-halt backstop (§4.7): the idle child first gets a
            // `needs_guidance` flag raised on IT, then the parent wake — two
            // dispatches.
            expect(dispatched.length).toBe(2);
            const flag = dispatched[0]!;
            if (flag.type !== "thread.attention.raise") {
              throw new Error(`expected a thread.attention.raise, got ${flag.type}`);
            }
            expect(flag.threadId).toBe(CHILD_ID);
            expect(flag.reason).toBe("needs_guidance");
            const wake = dispatched[1]!;
            // The wake is the "forgot to finish" child wake delivered to the
            // parent as a fresh turn-start.
            if (wake.type !== "thread.turn.start") {
              throw new Error(`expected a thread.turn.start wake, got ${wake.type}`);
            }
            expect(wake.threadId).toBe(PARENT_ID);
            expect(wake.message.text).toContain("went quiet");

            // (3) Further re-pass ticks must NOT re-nag: the episode is deduped
            // by the `idle:${maxSequence}` key + in-memory handled set.
            yield* TestClock.adjust(Duration.millis(IDLE_WAKE_REPASS_INTERVAL_MS * 5));
            yield* dispatcher.drain;
            expect(dispatched.length).toBe(2);
          }).pipe(Effect.provide(buildLayer(dispatched)));
        }),
      ),
  );
});

// Bug 1 (primary): an `error → done` recovery must re-notify the parent, whose
// view is otherwise frozen on the stale error verdict. The recovery wake fires
// for a `done` child ONLY when the durable error-wake receipt exists (we
// actually told the parent it errored), exactly once, and never for a `done`
// child that never errored. Exercised through the assembled dispatcher layer.
describe("recovery wake (error→done re-notifies the parent), full dispatcher layer", () => {
  const PARENT_ID = "parent-rec" as ThreadId;
  const CHILD_ID = "child-rec" as ThreadId;
  // Root parent (no parentThreadId → never promoted / never itself a child wake)
  // that is idle (no session) → an eligible wake target.
  const parent = shell({ id: PARENT_ID as unknown as string, parentThreadId: null, session: null });
  // Recovered sub-thread: now `done` with a (ready, no active turn) session, so
  // classifyChildWake returns null and the recovery branch owns it.
  const child = shell({
    id: CHILD_ID as unknown as string,
    parentThreadId: PARENT_ID,
    planLane: "done",
    session: runningSession({ threadId: CHILD_ID, status: "ready", activeTurnId: null }),
    reportPath: "child-rec.md",
  });

  const errorCmd = childWakeCommandId(CHILD_ID, "error");

  const buildLayer = (
    dispatched: Array<OrchestrationCommand>,
    opts: { readonly errorReceiptExists: boolean },
  ) => {
    const engine = {
      readEvents: () => Stream.empty,
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
      streamDomainEvents: Stream.empty,
    } as unknown as OrchestrationEngineShape;

    const snapshotQuery = {
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 1,
          goals: [],
          projects: [],
          threads: [parent, child],
          updatedAt: now,
        } satisfies OrchestrationShellSnapshot),
      getPendingTurnStartThreadIds: () => Effect.succeed(new Set<ThreadId>()),
      getActivityFreshnessByThreadId: () =>
        Effect.succeed({ maxCreatedAt: now, maxSequence: 1, heartbeatAt: null }),
    } as unknown as ProjectionSnapshotQueryShape;

    // Only the error-wake receipt is present (when opts say so); the recovery
    // receipt is absent, so cross-pass dedup is carried by the in-memory
    // handled set — the real machinery under test.
    const receipts = {
      upsert: () => Effect.void,
      getByCommandId: ({ commandId }: { readonly commandId: string }) =>
        Effect.succeed(
          opts.errorReceiptExists && commandId === errorCmd
            ? Option.some({} as never)
            : Option.none(),
        ),
    };

    return WorkstreamDispatcherLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(OrchestrationEngineService, engine),
          Layer.succeed(ProjectionSnapshotQuery, snapshotQuery),
          Layer.succeed(OrchestrationCommandReceiptRepository, receipts as never),
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-workstream-dispatcher-recovery-" }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );
  };

  effectIt.effect(
    "delivers exactly one recovery wake when the prior error-wake receipt exists, idempotent thereafter",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dispatched: Array<OrchestrationCommand> = [];
          yield* Effect.gen(function* () {
            const dispatcher = yield* WorkstreamDispatcher;
            yield* dispatcher.start();
            yield* dispatcher.drain;
            expect(dispatched.length).toBe(1);
            const wake = dispatched[0]!;
            if (wake.type !== "thread.turn.start") {
              throw new Error(`expected a thread.turn.start wake, got ${wake.type}`);
            }
            expect(wake.threadId).toBe(PARENT_ID);
            expect(wake.message.text).toContain("recovered");
            // Further passes must not re-nag: recovery is one-shot per child.
            yield* dispatcher.drain;
            expect(dispatched.length).toBe(1);
          }).pipe(Effect.provide(buildLayer(dispatched, { errorReceiptExists: true })));
        }),
      ),
  );

  effectIt.effect("does NOT wake when the child reached `done` without ever erroring", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dispatched: Array<OrchestrationCommand> = [];
        yield* Effect.gen(function* () {
          const dispatcher = yield* WorkstreamDispatcher;
          yield* dispatcher.start();
          yield* dispatcher.drain;
          expect(dispatched.length).toBe(0);
        }).pipe(Effect.provide(buildLayer(dispatched, { errorReceiptExists: false })));
      }),
    ),
  );
});
