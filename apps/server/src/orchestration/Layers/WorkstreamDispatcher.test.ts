import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import {
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationLatestTurn,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
  type ProviderSession,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ThreadPlanLane,
  type TurnId,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vite-plus/test";

import {
  buildChildWakeMessage,
  wakeCommandId,
  buildGateReverifyMessage,
  buildGateReworkMessage,
  buildParentWakeMessage,
  buildYieldWakeMessage,
  gateCommandId,
  yieldWakeCommandId,
  childWakeCommandId,
  classifyChildWake,
  classifyGenerationByReceipts,
  DEFAULT_IDLE_WAKE_GRACE_MS,
  DEFAULT_WAKE_RATE_GUARD,
  IDLE_WAKE_REPASS_INTERVAL_MS,
  idleLastProgressMs,
  idleWakeWithinGrace,
  selectThreadsToDispatch,
  slowToolNoticeIndex,
  WAKE_REPORT_EXCERPT_LIMIT,
  WorkstreamDispatcherLive,
  wakeRateGuardTrips,
} from "./WorkstreamDispatcher.ts";
import { WorktreeProvisioner } from "../../project/WorktreeProvisioner.ts";
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
import { decideOrchestrationCommand } from "../decider.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import { isThreadIdle } from "../threadIdle.ts";
import { workstreamChildPrompt } from "../workstreamChildPrompt.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { reconcileStartupStaleSessionState } from "../../serverRuntimeStartup.ts";

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
    routes: [],
    gateRounds: 0,
    pendingRework: false,
    lastOutcome: null,
    isolation: "shared" as const,
    fanInState: "none" as const,
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

// Worktree isolation: dispatcher-selection tests use only `shared` threads, so
// the provisioner is never invoked — a no-op stub satisfies the layer.
const WorktreeProvisionerStub = Layer.succeed(WorktreeProvisioner, {
  provisionWorktree: () => Effect.succeed({ worktreePath: "", branch: "" }),
  provisionIsolatedChild: () => Effect.succeed({ worktreePath: "", branch: "" }),
  runSetup: () => Effect.void,
} as never);

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
        attention: [],
        reportPath: "child-1.md",
        report: "# Findings\nAll good.",
      },
      {
        id: "child-2" as ThreadId,
        role: "reviewer",
        planLane: "in_progress",
        attention: ["needs_guidance"],
        reportPath: null,
        report: null,
      },
    ]);
    expect(text).toContain("researcher");
    expect(text).toContain("child-1");
    expect(text).toContain("done");
    // Honest copy: a non-terminal child is shown with its actual lane +
    // attention state, never described as finished.
    expect(text).toContain("in_progress (attention: needs_guidance)");
    expect(text).not.toContain("has finished");
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
        attention: [],
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
      planLane: "cancelled",
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

describe("startup stale session reconciliation", () => {
  const PARENT_ID = "parent-startup-reconcile" as ThreadId;
  const CHILD_ID = "child-startup-reconcile" as ThreadId;
  const buildLayer = (
    dispatched: Array<OrchestrationCommand>,
    providerSessions: ReadonlyArray<ProviderSession> = [],
  ) =>
    Layer.unwrap(
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<OrchestrationEvent>();
        const pendingTurnStarts = yield* Ref.make<ReadonlySet<ThreadId>>(new Set());
        const threads = yield* Ref.make<ReadonlyArray<OrchestrationThreadShell>>([
          shell({
            id: PARENT_ID,
            parentThreadId: null,
            session: runningSession({
              threadId: PARENT_ID,
              status: "running",
              activeTurnId: "turn-lost-completion" as TurnId,
            }),
          }),
          shell({
            id: CHILD_ID,
            parentThreadId: PARENT_ID,
            spawnGeneration: "gen-startup",
            planLane: "done",
            latestUserMessageAt: now,
            reportPath: "child-startup-reconcile.md",
            session: runningSession({ threadId: CHILD_ID, status: "ready", activeTurnId: null }),
          }),
        ]);
        const shellSnapshot = Effect.map(Ref.get(threads), (current) => ({
          snapshotSequence: 1,
          goals: [],
          projects: [],
          threads: current,
          updatedAt: now,
        }));
        const engine = {
          readEvents: () => Stream.empty,
          dispatch: (command: OrchestrationCommand) =>
            Effect.gen(function* () {
              if (command.type === "thread.session.set") {
                yield* Ref.update(threads, (current) =>
                  current.map((thread) =>
                    thread.id === command.threadId
                      ? { ...thread, session: command.session }
                      : thread,
                  ),
                );
              }
              if (command.type === "thread.turn-start.fail") {
                yield* Ref.update(
                  pendingTurnStarts,
                  (ids) => new Set([...ids].filter((id) => id !== command.threadId)),
                );
              }
              dispatched.push(command);
              if (command.type === "thread.session.set") {
                yield* PubSub.publish(events, { type: "thread.session-set" } as OrchestrationEvent);
              }
              return { sequence: dispatched.length };
            }),
          streamDomainEvents: Stream.fromPubSub(events),
          subscribeDomainEvents: Effect.succeed(Stream.fromPubSub(events)),
        } satisfies OrchestrationEngineShape;
        const snapshotQuery = {
          getCommandReadModel: () =>
            Effect.map(
              shellSnapshot,
              (snapshot) =>
                ({
                  ...snapshot,
                  threads: snapshot.threads as never,
                }) satisfies OrchestrationReadModel,
            ),
          getShellSnapshot: () => shellSnapshot,
          getPendingTurnStartThreadIds: () => Ref.get(pendingTurnStarts),
          getActivityFreshnessByThreadId: () =>
            Effect.succeed({ maxCreatedAt: null, maxSequence: 1, heartbeatAt: null }),
        } as unknown as ProjectionSnapshotQueryShape;
        const providerService = {
          listSessions: () => Effect.succeed(providerSessions),
        } as unknown as ProviderService["Service"];
        const receipts = {
          upsert: () => Effect.void,
          getByCommandId: () => Effect.succeed(Option.none()),
        };

        const deps = Layer.mergeAll(
          Layer.succeed(OrchestrationEngineService, engine),
          Layer.succeed(ProjectionSnapshotQuery, snapshotQuery),
          Layer.succeed(OrchestrationCommandReceiptRepository, receipts as never),
          WorktreeProvisionerStub,
          ServerConfig.layerTest(process.cwd(), {
            prefix: "t3-workstream-startup-reconcile-",
          }),
        ).pipe(Layer.provideMerge(NodeServices.layer));
        return Layer.mergeAll(
          WorkstreamDispatcherLive.pipe(Layer.provide(deps)),
          Layer.succeed(ProviderService, providerService),
          Layer.succeed(ProjectionSnapshotQuery, snapshotQuery),
          Layer.succeed(OrchestrationEngineService, engine),
        );
      }),
    );

  effectIt.effect(
    "resets a stale running parent after restart and releases the deferred generation wake",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dispatched: Array<OrchestrationCommand> = [];
          yield* Effect.gen(function* () {
            const dispatcher = yield* WorkstreamDispatcher;
            yield* dispatcher.start();
            yield* dispatcher.drain;
            expect(dispatched).toEqual([]);

            yield* reconcileStartupStaleSessionState;
            yield* dispatcher.drain;

            const reconcile = dispatched[0];
            if (reconcile?.type !== "thread.session.set") {
              throw new Error(`expected startup reconcile session-set, got ${reconcile?.type}`);
            }
            expect(reconcile.commandId.startsWith("server:startup-session-reconcile:")).toBe(true);
            expect(reconcile.threadId).toBe(PARENT_ID);
            expect(reconcile.session.status).toBe("ready");
            expect(reconcile.session.activeTurnId).toBeNull();

            const wake = dispatched.find(
              (command) => command.type === "thread.turn.start" && command.threadId === PARENT_ID,
            );
            expect(wake).toBeDefined();
            expect(wake?.type === "thread.turn.start" ? wake.requireIdle : false).toBe(true);
          }).pipe(Effect.provide(buildLayer(dispatched)));
        }),
      ),
  );

  effectIt.effect("does not reset a thread that still has an active provider turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dispatched: Array<OrchestrationCommand> = [];
        yield* reconcileStartupStaleSessionState.pipe(
          Effect.provide(
            buildLayer(dispatched, [
              {
                threadId: PARENT_ID,
                activeTurnId: "turn-live" as TurnId,
              } as ProviderSession,
            ]),
          ),
        );
        expect(dispatched).toEqual([]);
      }),
    ),
  );
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
      {
        id: "child-1" as ThreadId,
        role: "reviewer",
        planLane: "done",
        attention: [],
        reportPath: "child-1.md",
      },
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

describe("buildChildWakeMessage (attention pause notice)", () => {
  it("names the flags + lane and never claims the child finished", () => {
    const text = buildChildWakeMessage(
      {
        id: "child-1" as ThreadId,
        role: "coder",
        planLane: "in_progress",
        attention: ["needs_guidance"],
        reportPath: "child-1.md",
      },
      "attention",
      null,
    );
    expect(text).toContain("paused");
    expect(text).toContain("needs_guidance");
    expect(text).toContain("in_progress");
    expect(text).toContain("NOT finished");
    expect(text).toContain("child-1.md");
    expect(text).toContain("stay gated");
  });
});

describe("buildChildWakeMessage (frozen attention notice — stall escalation mid-turn)", () => {
  it("names the flags, the frozen turn, and the stop-then-prompt recovery options", () => {
    const text = buildChildWakeMessage(
      {
        id: "child-1" as ThreadId,
        role: "coder",
        planLane: "in_progress",
        attention: ["needs_guidance"],
        reportPath: null,
      },
      "attention",
      null,
      { quietMs: 12 * 60_000, frozen: true },
    );
    expect(text).toContain("frozen");
    expect(text).toContain("needs_guidance");
    expect(text).toContain("~12 min");
    expect(text).toContain("NOT finished");
    expect(text).toContain("workstream_stop");
    expect(text).toContain("workstream_prompt");
    expect(text).toContain("stay gated");
  });
});

describe("buildChildWakeMessage (slow-tool informational notice)", () => {
  it("names the tool + durations, raises no alarm, and lists the parent's options", () => {
    const text = buildChildWakeMessage(
      {
        id: "child-1" as ThreadId,
        role: "coder",
        planLane: "in_progress",
        attention: [],
        reportPath: null,
      },
      "slow-tool",
      null,
      { quietMs: 6 * 60_000, toolName: "bash", inFlightMs: 7 * 60_000 },
    );
    expect(text).toContain("Informational notice");
    expect(text).toContain("`bash`");
    expect(text).toContain("~7 min");
    expect(text).toContain("~6 min");
    expect(text).toContain("will not interrupt");
    expect(text).toContain("workstream_prompt");
    expect(text).toContain("workstream_stop");
    // Nothing failed: no fault language, no report boilerplate.
    expect(text).not.toContain("error");
    expect(text).not.toContain("No report was filed");
  });
});

describe("slowToolNoticeIndex (escalating notice schedule)", () => {
  const m = (mins: number) => mins * 60_000;
  it("is -1 below the first step (no notice due)", () => {
    expect(slowToolNoticeIndex(0)).toBe(-1);
    expect(slowToolNoticeIndex(m(5) - 1)).toBe(-1);
  });
  it("steps 0/1/2 at 5/15/30 minutes of quiet", () => {
    expect(slowToolNoticeIndex(m(5))).toBe(0);
    expect(slowToolNoticeIndex(m(14))).toBe(0);
    expect(slowToolNoticeIndex(m(15))).toBe(1);
    expect(slowToolNoticeIndex(m(29))).toBe(1);
    expect(slowToolNoticeIndex(m(30))).toBe(2);
  });
  it("repeats every 30 minutes past the last step", () => {
    expect(slowToolNoticeIndex(m(59))).toBe(2);
    expect(slowToolNoticeIndex(m(60))).toBe(3);
    expect(slowToolNoticeIndex(m(90))).toBe(4);
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

  it("classifies a flagged, non-executing, non-terminal child as a paused `attention` wake", () => {
    for (const attention of [["needs_guidance"], ["awaiting_acceptance"]] as const) {
      const child = shell({
        id: "child-1",
        planLane: "in_progress",
        attention: [...attention],
        session: runningSession({ status: "ready", activeTurnId: null }),
      });
      expect(classifyChildWake(child, new Set())).toBe("attention");
    }
  });

  it("does NOT attention-wake a flagged child that is still executing", () => {
    const child = shell({
      id: "child-1",
      planLane: "in_progress",
      attention: ["needs_guidance"],
      session: runningSession(),
    });
    expect(classifyChildWake(child, new Set())).toBeNull();
  });

  it("does NOT attention-wake a flagged child whose resume turn-start is pending", () => {
    const child = shell({
      id: "child-1",
      planLane: "in_progress",
      attention: ["needs_guidance"],
      session: runningSession({ status: "ready", activeTurnId: null }),
    });
    expect(classifyChildWake(child, new Set(["child-1" as ThreadId]))).toBeNull();
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
      subscribeDomainEvents: Effect.succeed(Stream.empty),
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
          WorktreeProvisionerStub,
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
      subscribeDomainEvents: Effect.succeed(Stream.empty),
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
          WorktreeProvisionerStub,
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

// Bug fix regression (human stop must never bubble a "finished" result): a
// single-child generation whose child is paused (attention-flagged, not
// executing, lane still `in_progress`) must NOT join — the parent instead gets
// exactly one honest per-child "paused" notice, and the one-shot generation
// wake stays armed for the child's real completion. Exercised through the
// assembled dispatcher layer.
describe("paused-child attention notice (full dispatcher layer)", () => {
  const PARENT_ID = "parent-pause" as ThreadId;
  const CHILD_ID = "child-pause" as ThreadId;
  const parent = shell({ id: PARENT_ID as unknown as string, parentThreadId: null, session: null });
  // Human-stopped mid-turn: interrupt raised `needs_guidance`, pi aborted the
  // turn (session ready, no active turn, latest turn interrupted), lane still
  // `in_progress`, and it is the SOLE member of its spawn generation.
  const child = shell({
    id: CHILD_ID as unknown as string,
    parentThreadId: PARENT_ID,
    planLane: "in_progress",
    spawnGeneration: "gen-1",
    attention: ["needs_guidance"],
    session: runningSession({ threadId: CHILD_ID, status: "ready", activeTurnId: null }),
    latestTurn: latestTurn({ state: "interrupted", completedAt: null }),
  });

  const buildLayer = (
    dispatched: Array<OrchestrationCommand>,
    opts: { readonly idleWakeReceiptExists: boolean },
  ) => {
    const idleCmd = childWakeCommandId(CHILD_ID, "idle:42");
    const engine = {
      readEvents: () => Stream.empty,
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
      streamDomainEvents: Stream.empty,
      subscribeDomainEvents: Effect.succeed(Stream.empty),
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
        Effect.succeed({ maxCreatedAt: now, maxSequence: 42, heartbeatAt: null }),
    } as unknown as ProjectionSnapshotQueryShape;

    const receipts = {
      upsert: () => Effect.void,
      getByCommandId: ({ commandId }: { readonly commandId: string }) =>
        Effect.succeed(
          opts.idleWakeReceiptExists && commandId === idleCmd
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
          WorktreeProvisionerStub,
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-workstream-dispatcher-pause-" }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );
  };

  effectIt.effect(
    "delivers exactly one honest pause notice — never a generation wake — and is idempotent",
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
            expect(wake.message.text).toContain("paused");
            expect(wake.message.text).toContain("needs_guidance");
            // The paused generation must NOT have joined: no "spawn generation
            // … terminal" wake, so its one-shot command id stays unconsumed for
            // the child's real completion.
            expect(wake.message.text).not.toContain("spawn generation");
            yield* dispatcher.drain;
            expect(dispatched.length).toBe(1);
          }).pipe(Effect.provide(buildLayer(dispatched, { idleWakeReceiptExists: false })));
        }),
      ),
  );

  effectIt.effect(
    "does NOT re-notify when this quiet episode was already surfaced by the idle backstop",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dispatched: Array<OrchestrationCommand> = [];
          yield* Effect.gen(function* () {
            const dispatcher = yield* WorkstreamDispatcher;
            yield* dispatcher.start();
            yield* dispatcher.drain;
            expect(dispatched.length).toBe(0);
          }).pipe(Effect.provide(buildLayer(dispatched, { idleWakeReceiptExists: true })));
        }),
      ),
  );
});

// Class-2 liveness (slow-but-alive tool call): an executing, unflagged child
// whose in-flight tool call has gone quiet gets the parent an INFORMATIONAL
// notice on the escalating schedule — no attention flag on the child, no
// interruption, one notice per schedule step. Exercised through the assembled
// dispatcher layer with the TestClock driving the scheduled re-pass.
describe("slow-tool informational notice (TestClock, full dispatcher layer)", () => {
  const PARENT_ID = "parent-slow" as ThreadId;
  const CHILD_ID = "child-slow" as ThreadId;
  const epochIso = "1970-01-01T00:00:00.000Z";

  const parent = shell({ id: PARENT_ID as unknown as string, parentThreadId: null, session: null });
  // Executing sub-thread: open turn started at epoch, session running. Its
  // freshness (below) is fresh at t=0 and goes quiet as the clock advances.
  const child = shell({
    id: CHILD_ID as unknown as string,
    parentThreadId: PARENT_ID,
    planLane: "in_progress",
    session: runningSession({
      threadId: CHILD_ID,
      status: "running",
      activeTurnId: "turn-1" as TurnId,
    }),
    latestTurn: latestTurn({ startedAt: epochIso, completedAt: null, state: "running" }),
  });

  const buildLayer = (dispatched: Array<OrchestrationCommand>) => {
    const engine = {
      readEvents: () => Stream.empty,
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
      streamDomainEvents: Stream.empty,
      subscribeDomainEvents: Effect.succeed(Stream.empty),
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
      // Heartbeat frozen at epoch: quiet time === TestClock time.
      getActivityFreshnessByThreadId: () =>
        Effect.succeed({ maxCreatedAt: epochIso, maxSequence: 1, heartbeatAt: epochIso }),
      // One tool call in flight since epoch, never completing.
      getInFlightToolByThreadId: () =>
        Effect.succeed({ toolName: "bash", startedAt: epochIso, activityId: "act-1" }),
    } as unknown as ProjectionSnapshotQueryShape;

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
          WorktreeProvisionerStub,
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-workstream-dispatcher-slowtool-" }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );
  };

  effectIt.effect(
    "notifies at the first quiet step, re-notifies at the next step, never flags the child",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dispatched: Array<OrchestrationCommand> = [];
          yield* Effect.gen(function* () {
            const dispatcher = yield* WorkstreamDispatcher;
            yield* dispatcher.start();

            // (1) t=0: the call just started, activity is fresh → no notice.
            yield* dispatcher.drain;
            expect(dispatched.length).toBe(0);

            // (2) Past the first step (5m) → exactly one informational notice,
            // idempotent across further ticks within the same step.
            yield* TestClock.adjust(Duration.millis(6 * 60_000));
            yield* dispatcher.drain;
            expect(dispatched.length).toBe(1);
            const first = dispatched[0]!;
            if (first.type !== "thread.turn.start") {
              throw new Error(`expected a thread.turn.start notice, got ${first.type}`);
            }
            expect(first.threadId).toBe(PARENT_ID);
            expect(first.message.text).toContain("Informational notice");
            expect(first.message.text).toContain("`bash`");

            // (3) Past the second step (15m) → exactly one more notice.
            yield* TestClock.adjust(Duration.millis(10 * 60_000));
            yield* dispatcher.drain;
            expect(dispatched.length).toBe(2);

            // The child was never attention-flagged and never interrupted: the
            // ONLY commands are the two parent notices.
            expect(
              dispatched.every((c) => c.type === "thread.turn.start" && c.threadId === PARENT_ID),
            ).toBe(true);
          }).pipe(Effect.provide(buildLayer(dispatched)));
        }),
      ),
  );
});

// Frozen-attention notice: a stall escalation raises `needs_guidance` while the
// child's turn is wedged OPEN, so the idle-gated attention rail can never fire.
// The executing branch must surface it to the parent once the quiet grace
// elapses — exactly once per pause episode.
describe("frozen-attention notice (flagged mid-turn, TestClock, full dispatcher layer)", () => {
  const PARENT_ID = "parent-frozen" as ThreadId;
  const CHILD_ID = "child-frozen" as ThreadId;
  const epochIso = "1970-01-01T00:00:00.000Z";

  const parent = shell({ id: PARENT_ID as unknown as string, parentThreadId: null, session: null });
  // Stall-escalated sub-thread: flagged `needs_guidance`, turn still open and
  // frozen since epoch.
  const child = shell({
    id: CHILD_ID as unknown as string,
    parentThreadId: PARENT_ID,
    planLane: "in_progress",
    attention: ["needs_guidance"],
    session: runningSession({
      threadId: CHILD_ID,
      status: "running",
      activeTurnId: "turn-1" as TurnId,
    }),
    latestTurn: latestTurn({ startedAt: epochIso, completedAt: null, state: "running" }),
  });

  const buildLayer = (dispatched: Array<OrchestrationCommand>) => {
    const engine = {
      readEvents: () => Stream.empty,
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
      streamDomainEvents: Stream.empty,
      subscribeDomainEvents: Effect.succeed(Stream.empty),
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
        Effect.succeed({ maxCreatedAt: epochIso, maxSequence: 1, heartbeatAt: epochIso }),
      getInFlightToolByThreadId: () => Effect.succeed(null),
    } as unknown as ProjectionSnapshotQueryShape;

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
          WorktreeProvisionerStub,
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-workstream-dispatcher-frozen-" }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );
  };

  effectIt.effect(
    "delivers exactly one frozen pause notice once the quiet grace elapses, idempotent thereafter",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dispatched: Array<OrchestrationCommand> = [];
          yield* Effect.gen(function* () {
            const dispatcher = yield* WorkstreamDispatcher;
            yield* dispatcher.start();

            // Within the grace: flagged but recently active → no notice yet.
            yield* dispatcher.drain;
            expect(dispatched.length).toBe(0);

            yield* TestClock.adjust(
              Duration.millis(DEFAULT_IDLE_WAKE_GRACE_MS + IDLE_WAKE_REPASS_INTERVAL_MS),
            );
            yield* dispatcher.drain;
            expect(dispatched.length).toBe(1);
            const wake = dispatched[0]!;
            if (wake.type !== "thread.turn.start") {
              throw new Error(`expected a thread.turn.start wake, got ${wake.type}`);
            }
            expect(wake.threadId).toBe(PARENT_ID);
            expect(wake.message.text).toContain("frozen");
            expect(wake.message.text).toContain("needs_guidance");
            expect(wake.message.text).toContain("NOT finished");

            // One notice per pause episode (keyed on the wedged turn id).
            yield* TestClock.adjust(Duration.millis(IDLE_WAKE_REPASS_INTERVAL_MS * 5));
            yield* dispatcher.drain;
            expect(dispatched.length).toBe(1);
          }).pipe(Effect.provide(buildLayer(dispatched)));
        }),
      ),
  );
});

// Review gates Phase 2 (design §6): a child whose submit routed to `yielded`
// wakes its parent exactly once per yield episode (keyed by the recording
// outcome event id), through the shared receipt-deduped + idle-gated rail.
// Exercised through the assembled dispatcher layer.
describe("yield wake (yielded child hands its turn to the orchestrator), full dispatcher layer", () => {
  const PARENT_ID = "parent-yield" as ThreadId;
  const CHILD_ID = "child-yield" as ThreadId;
  const parent = shell({ id: PARENT_ID as unknown as string, parentThreadId: null, session: null });
  const child = shell({
    id: CHILD_ID as unknown as string,
    parentThreadId: PARENT_ID,
    planLane: "yielded",
    session: runningSession({ threadId: CHILD_ID, status: "ready", activeTurnId: null }),
    reportPath: "child-yield.md",
    lastOutcome: {
      outcome: "rework_approach",
      decision: "yield",
      round: 0,
      recordedByEventId: "evt-outcome-1",
      at: now,
    } as unknown as OrchestrationThreadShell["lastOutcome"],
  });

  const buildLayer = (dispatched: Array<OrchestrationCommand>) => {
    const engine = {
      readEvents: () => Stream.empty,
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
      streamDomainEvents: Stream.empty,
      subscribeDomainEvents: Effect.succeed(Stream.empty),
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
          WorktreeProvisionerStub,
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-workstream-dispatcher-yield-" }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );
  };

  effectIt.effect(
    "delivers exactly one yield wake per episode (deterministic command id), idempotent thereafter",
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
            expect(wake.commandId).toBe(yieldWakeCommandId(CHILD_ID, "evt-outcome-1"));
            expect(wake.requireIdle).toBe(true);
            expect(wake.message.text).toContain("YIELDED");
            expect(wake.message.text).toContain("rework_approach");
            expect(wake.message.text).toContain("child-yield.md");
            expect(wake.message.text).toContain("NOT finished");
            // A yielded child is neither idle-nagged nor generation-joined: the
            // yield wake is the only dispatch, and further passes are no-ops.
            yield* dispatcher.drain;
            expect(dispatched.length).toBe(1);
          }).pipe(Effect.provide(buildLayer(dispatched)));
        }),
      ),
  );
});

describe("buildYieldWakeMessage", () => {
  it("marks the notice as control-plane, names the outcome, and lays out the decision menu", () => {
    const text = buildYieldWakeMessage(
      { id: "child-1" as ThreadId, role: "reviewer", reportPath: "child-1.md" },
      "rework_approach",
      "# Why\nThe approach is wrong.",
    );
    expect(text).toContain("[T3 Workstream control plane");
    expect(text).toContain("`rework_approach`");
    expect(text).toContain("child-1.md");
    expect(text).toContain("The approach is wrong.");
    expect(text).toContain("NOT finished");
    expect(text).toContain("workstream_prompt");
    expect(text).toContain("workstream_set_lane");
  });
});

// ---------------------------------------------------------------------------
// Review gates Phase 3 (design §4.3/§6): the gate traversal pass, cap-breach
// yield copy, idle-rail gate suppression, and generation-join gating.
// ---------------------------------------------------------------------------

describe("gate resume messages (pure builders)", () => {
  it("gateCommandId is deterministic per (source, round, leg)", () => {
    expect(gateCommandId("rev-1" as ThreadId, 2, "rework")).toBe(
      "server:workstream-gate:rev-1:2:rework",
    );
    expect(gateCommandId("rev-1" as ThreadId, 2, "reverify")).toBe(
      "server:workstream-gate:rev-1:2:reverify",
    );
  });

  it("rework message carries marker, round, reference, adjudication rules, and routing visibility", () => {
    const text = buildGateReworkMessage(
      { id: "rev-1" as ThreadId, role: "reviewer", reportPath: "/reports/rev-1.round-1.md" },
      1,
      "## Findings\n1. Fix the null guard.",
    );
    expect(text).toContain("[T3 Workstream control plane");
    expect(text).toContain("Review round 1");
    expect(text).toContain("/reports/rev-1.round-1.md");
    expect(text).toContain("Fix the null guard.");
    expect(text).toContain("claims, not verdicts");
    expect(text).toContain("routes back to the reviewer");
    expect(text).toContain("NOT to done");
  });

  it("reverify message carries the delta-review discipline and the verdict routing", () => {
    const text = buildGateReverifyMessage(
      { id: "coder-1" as ThreadId, role: "coder", reportPath: "/reports/coder-1.round-1.md" },
      1,
      "## Round report\nImplemented finding 1; rejected finding 2 (reasons).",
    );
    expect(text).toContain("[T3 Workstream control plane");
    expect(text).toContain("re-verification");
    expect(text).toContain("DELTA review");
    expect(text).toContain("rejected finding 2");
    expect(text).toContain("`clean` or `fixed_inline` resolves the gate");
    expect(text).toContain("`needs_rework` loops again");
  });
});

describe("buildYieldWakeMessage (gate cap breach + copy)", () => {
  it("does not duplicate 'sub-thread' when the child has no role", () => {
    const text = buildYieldWakeMessage(
      { id: "child-1" as ThreadId, role: null, reportPath: null },
      "rework_approach",
      null,
    );
    expect(text).not.toContain("sub-thread sub-thread");
    expect(text).toContain("Your Workstream sub-thread `child-1`");
  });

  it("cap breach carries the round count and BOTH parties' reports", () => {
    const text = buildYieldWakeMessage(
      { id: "rev-1" as ThreadId, role: "reviewer", reportPath: "/reports/rev-1.md" },
      "needs_rework",
      "Still two must-fix findings.",
      {
        rounds: 2,
        maxRounds: 2,
        counterpart: {
          id: "coder-1" as ThreadId,
          role: "coder",
          reportPath: "/reports/coder-1.round-2.md",
          report: "Round 2: contested finding 3 again.",
        },
      },
    );
    expect(text).toContain("round cap is exhausted (2/2");
    expect(text).toContain("Still two must-fix findings.");
    expect(text).toContain("coder `coder-1`");
    expect(text).toContain("/reports/coder-1.round-2.md");
    expect(text).toContain("contested finding 3 again");
    expect(text).toContain("dissolves the gate");
    expect(text).toContain("NOT resolved");
  });
});

// Layered gate-traversal coverage: the pass recomputes owed loop legs purely
// from shell state and delivers them under deterministic, receipt-deduped
// command ids — crash-safe across redrives.
describe("routeGateTraversals (full dispatcher layer)", () => {
  const PARENT_ID = "parent-gate" as ThreadId;
  const REVIEWER_ID = "reviewer-gate" as ThreadId;
  const CODER_ID = "coder-gate" as ThreadId;
  const epochIso = "1970-01-01T00:00:00.000Z";

  const parent = shell({ id: PARENT_ID as unknown as string, parentThreadId: null, session: null });
  const gateRoutes = [
    { on: ["needs_rework"], kind: "loop", to: CODER_ID, maxRounds: 2 },
    { on: ["clean", "fixed_inline"], kind: "resolve" },
  ] as unknown as OrchestrationThreadShell["routes"];

  const buildLayer = (
    dispatched: Array<OrchestrationCommand>,
    threads: ReadonlyArray<OrchestrationThreadShell>,
    options: { readonly receiptIds?: ReadonlySet<string>; readonly prefix: string },
  ) => {
    const engine = {
      readEvents: () => Stream.empty,
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
      streamDomainEvents: Stream.empty,
      subscribeDomainEvents: Effect.succeed(Stream.empty),
    } as unknown as OrchestrationEngineShape;

    const snapshotQuery = {
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 1,
          goals: [],
          projects: [],
          threads,
          updatedAt: epochIso,
        } satisfies OrchestrationShellSnapshot),
      getPendingTurnStartThreadIds: () => Effect.succeed(new Set<ThreadId>()),
      getActivityFreshnessByThreadId: () =>
        Effect.succeed({ maxCreatedAt: epochIso, maxSequence: 1, heartbeatAt: null }),
      getInFlightToolByThreadId: () => Effect.succeed(null),
    } as unknown as ProjectionSnapshotQueryShape;

    const receipts = {
      upsert: () => Effect.void,
      getByCommandId: ({ commandId }: { commandId: string }) =>
        Effect.succeed(
          options.receiptIds?.has(commandId) ? Option.some({ commandId }) : Option.none(),
        ),
    };

    return WorkstreamDispatcherLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(OrchestrationEngineService, engine),
          Layer.succeed(ProjectionSnapshotQuery, snapshotQuery),
          Layer.succeed(OrchestrationCommandReceiptRepository, receipts as never),
          WorktreeProvisionerStub,
          ServerConfig.layerTest(process.cwd(), { prefix: options.prefix }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );
  };

  const run = (
    threads: ReadonlyArray<OrchestrationThreadShell>,
    options: { readonly receiptIds?: ReadonlySet<string>; readonly prefix: string },
    body: (args: {
      readonly dispatched: Array<OrchestrationCommand>;
      readonly dispatcher: { readonly drain: Effect.Effect<void> };
    }) => Effect.Effect<void>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const dispatched: Array<OrchestrationCommand> = [];
        yield* Effect.gen(function* () {
          const dispatcher = yield* WorkstreamDispatcher;
          yield* dispatcher.start();
          yield* dispatcher.drain;
          yield* body({ dispatched, dispatcher });
        }).pipe(Effect.provide(buildLayer(dispatched, threads, options)));
      }),
    );

  effectIt.effect(
    "rework leg: an open round resumes the done coder with reopen, exactly once (round-trip start)",
    () => {
      const reviewer = shell({
        id: REVIEWER_ID as unknown as string,
        parentThreadId: PARENT_ID,
        role: "reviewer",
        planLane: "in_progress",
        routes: gateRoutes,
        gateRounds: 1,
        reportPath: "/nonexistent/reviewer-gate.round-1.md",
      });
      const coder = shell({
        id: CODER_ID as unknown as string,
        parentThreadId: PARENT_ID,
        role: "coder",
        planLane: "done",
        pendingRework: true,
      });
      return run(
        [parent, reviewer, coder],
        { prefix: "t3-workstream-gate-rework-" },
        ({ dispatched, dispatcher }) =>
          Effect.gen(function* () {
            expect(dispatched.length).toBe(1);
            const resume = dispatched[0]!;
            if (resume.type !== "thread.turn.start") {
              throw new Error(`expected thread.turn.start, got ${resume.type}`);
            }
            expect(resume.threadId).toBe(CODER_ID);
            expect(resume.commandId).toBe(gateCommandId(REVIEWER_ID, 1, "rework"));
            expect(resume.reopen).toBe(true);
            expect(resume.requireIdle).toBeUndefined();
            expect(resume.message.text).toContain("Review round 1");
            expect(resume.message.text).toContain("routes back to the reviewer");
            // Idempotent across passes (in-memory handled set + receipts).
            yield* dispatcher.drain;
            expect(dispatched.length).toBe(1);
          }),
      );
    },
  );

  effectIt.effect(
    "crash between route-taken and resume: a redrive with the receipt present never re-dispatches",
    () => {
      const reviewer = shell({
        id: REVIEWER_ID as unknown as string,
        parentThreadId: PARENT_ID,
        planLane: "in_progress",
        routes: gateRoutes,
        gateRounds: 1,
      });
      const coder = shell({
        id: CODER_ID as unknown as string,
        parentThreadId: PARENT_ID,
        planLane: "done",
        pendingRework: true,
      });
      return run(
        [parent, reviewer, coder],
        {
          prefix: "t3-workstream-gate-redrive-",
          receiptIds: new Set([gateCommandId(REVIEWER_ID, 1, "rework")]),
        },
        ({ dispatched }) =>
          Effect.sync(() => {
            expect(dispatched.length).toBe(0);
          }),
      );
    },
  );

  effectIt.effect(
    "reverify leg: a routed-back coder resumes the reviewer with the delta report, no reopen",
    () => {
      const reviewer = shell({
        id: REVIEWER_ID as unknown as string,
        parentThreadId: PARENT_ID,
        role: "reviewer",
        planLane: "in_progress",
        routes: gateRoutes,
        gateRounds: 1,
      });
      const coder = shell({
        id: CODER_ID as unknown as string,
        parentThreadId: PARENT_ID,
        role: "coder",
        planLane: "in_progress",
        pendingRework: false,
        lastOutcome: {
          outcome: "done",
          decision: "loop",
          round: 1,
          recordedByEventId: "evt-coder-loop",
          at: now,
        } as unknown as OrchestrationThreadShell["lastOutcome"],
      });
      return run(
        [parent, reviewer, coder],
        { prefix: "t3-workstream-gate-reverify-" },
        ({ dispatched }) =>
          Effect.sync(() => {
            expect(dispatched.length).toBe(1);
            const resume = dispatched[0]!;
            if (resume.type !== "thread.turn.start") {
              throw new Error(`expected thread.turn.start, got ${resume.type}`);
            }
            expect(resume.threadId).toBe(REVIEWER_ID);
            expect(resume.commandId).toBe(gateCommandId(REVIEWER_ID, 1, "reverify"));
            expect(resume.reopen).toBeUndefined();
            expect(resume.message.text).toContain("DELTA review");
          }),
      );
    },
  );

  effectIt.effect(
    "parent dissolution: a done reviewer stops all traversal even with an open round",
    () => {
      const reviewer = shell({
        id: REVIEWER_ID as unknown as string,
        parentThreadId: PARENT_ID,
        planLane: "done",
        routes: gateRoutes,
        gateRounds: 1,
      });
      const coder = shell({
        id: CODER_ID as unknown as string,
        parentThreadId: PARENT_ID,
        planLane: "done",
        pendingRework: true,
      });
      return run(
        [parent, reviewer, coder],
        { prefix: "t3-workstream-gate-dissolved-" },
        ({ dispatched }) =>
          Effect.sync(() => {
            // No gate traversal. (The pair joins its generation instead when
            // one is stamped — none here, so nothing at all is dispatched.)
            expect(dispatched.filter((c) => c.type === "thread.turn.start")).toHaveLength(0);
          }),
      );
    },
  );

  effectIt.effect(
    "R4: a cancelled coder gets no traversal, and the waiting reviewer's idle wake un-suppresses",
    () => {
      const reviewer = shell({
        id: REVIEWER_ID as unknown as string,
        parentThreadId: PARENT_ID,
        role: "reviewer",
        planLane: "in_progress",
        routes: gateRoutes,
        gateRounds: 1,
        session: runningSession({ threadId: REVIEWER_ID, status: "ready", activeTurnId: null }),
        latestTurn: latestTurn({ completedAt: epochIso }),
      });
      const coder = shell({
        id: CODER_ID as unknown as string,
        parentThreadId: PARENT_ID,
        planLane: "cancelled",
        pendingRework: true,
      });
      return run(
        [parent, reviewer, coder],
        { prefix: "t3-workstream-gate-r4-" },
        ({ dispatched, dispatcher }) =>
          Effect.gen(function* () {
            // No gate traversal into the dead coder.
            expect(dispatched.length).toBe(0);
            // Once the idle grace elapses the reviewer is NOT gate-suppressed
            // (cancelled counterpart): the forgot-to-finish rail flags it and
            // wakes the parent.
            yield* TestClock.adjust(
              Duration.millis(DEFAULT_IDLE_WAKE_GRACE_MS + IDLE_WAKE_REPASS_INTERVAL_MS),
            );
            yield* dispatcher.drain;
            expect(dispatched.length).toBe(2);
            const flag = dispatched[0]!;
            if (flag.type !== "thread.attention.raise") {
              throw new Error(`expected thread.attention.raise, got ${flag.type}`);
            }
            expect(flag.threadId).toBe(REVIEWER_ID);
            const wake = dispatched[1]!;
            if (wake.type !== "thread.turn.start") {
              throw new Error(`expected thread.turn.start, got ${wake.type}`);
            }
            expect(wake.threadId).toBe(PARENT_ID);
          }),
      );
    },
  );

  effectIt.effect(
    "parent interrupt mid-loop: a stopped coder is never re-sent its rework resume; the idle backstop owns it",
    () => {
      const reviewer = shell({
        id: REVIEWER_ID as unknown as string,
        parentThreadId: PARENT_ID,
        planLane: "in_progress",
        routes: gateRoutes,
        gateRounds: 1,
      });
      // The coder was resumed for rework (receipt durable), then the parent
      // stopped it mid-turn: in_progress, idle, round still open.
      const coder = shell({
        id: CODER_ID as unknown as string,
        parentThreadId: PARENT_ID,
        planLane: "in_progress",
        pendingRework: true,
        session: runningSession({ threadId: CODER_ID, status: "stopped", activeTurnId: null }),
        latestTurn: latestTurn({ completedAt: epochIso, state: "interrupted" }),
      });
      return run(
        [parent, reviewer, coder],
        {
          prefix: "t3-workstream-gate-interrupt-",
          receiptIds: new Set([gateCommandId(REVIEWER_ID, 1, "rework")]),
        },
        ({ dispatched, dispatcher }) =>
          Effect.gen(function* () {
            // The gate pass never fights the parent's pause: the rework leg is
            // receipt-deduped, so nothing is re-dispatched to the coder.
            expect(dispatched).toHaveLength(0);
            // …but the coder still owes a submit, so once the idle grace
            // elapses the forgot-to-finish backstop surfaces it (needs_guidance
            // flag + parent wake) — gate suppression does NOT apply to a party
            // holding the open round.
            yield* TestClock.adjust(
              Duration.millis(DEFAULT_IDLE_WAKE_GRACE_MS + IDLE_WAKE_REPASS_INTERVAL_MS),
            );
            yield* dispatcher.drain;
            expect(
              dispatched.filter(
                (c) => c.type === "thread.attention.raise" && c.threadId === CODER_ID,
              ),
            ).toHaveLength(1);
            expect(
              dispatched.filter((c) => c.type === "thread.turn.start" && c.threadId === PARENT_ID),
            ).toHaveLength(1);
            // Still no rework re-dispatch to the coder.
            expect(
              dispatched.filter((c) => c.type === "thread.turn.start" && c.threadId === CODER_ID),
            ).toHaveLength(0);
          }),
      );
    },
  );

  effectIt.effect(
    "suppression: a reviewer idling while the coder holds the open round is never idle-nagged",
    () => {
      const reviewer = shell({
        id: REVIEWER_ID as unknown as string,
        parentThreadId: PARENT_ID,
        planLane: "in_progress",
        routes: gateRoutes,
        gateRounds: 1,
        session: runningSession({ threadId: REVIEWER_ID, status: "ready", activeTurnId: null }),
        latestTurn: latestTurn({ completedAt: epochIso }),
      });
      // The coder is mid-rework (in_progress with the open round) — resumed by
      // an earlier pass whose rework receipt is durable.
      const coder = shell({
        id: CODER_ID as unknown as string,
        parentThreadId: PARENT_ID,
        planLane: "in_progress",
        pendingRework: true,
        session: runningSession({
          threadId: CODER_ID,
          status: "running",
          activeTurnId: "turn-rework" as TurnId,
        }),
      });
      return run(
        [parent, reviewer, coder],
        {
          prefix: "t3-workstream-gate-suppress-",
          receiptIds: new Set([gateCommandId(REVIEWER_ID, 1, "rework")]),
        },
        ({ dispatched, dispatcher }) =>
          Effect.gen(function* () {
            yield* TestClock.adjust(
              Duration.millis(DEFAULT_IDLE_WAKE_GRACE_MS + IDLE_WAKE_REPASS_INTERVAL_MS),
            );
            yield* dispatcher.drain;
            // No idle flag, no idle wake — the reviewer is waiting in the gate.
            expect(dispatched.filter((c) => c.type === "thread.attention.raise")).toHaveLength(0);
            expect(
              dispatched.filter((c) => c.type === "thread.turn.start" && c.threadId === PARENT_ID),
            ).toHaveLength(0);
          }),
      );
    },
  );
});

// Generation-join gating (design §6): a joined generation containing a party of
// an unresolved gate is held back; it releases once the gate source is terminal.
describe("generation join is held back by an unresolved gate (full dispatcher layer)", () => {
  const PARENT_ID = "parent-join-gate" as ThreadId;
  const REVIEWER_ID = "reviewer-join-gate" as ThreadId;
  const CODER_ID = "coder-join-gate" as ThreadId;

  const parent = shell({ id: PARENT_ID as unknown as string, parentThreadId: null, session: null });
  const gateRoutes = [
    { on: ["needs_rework"], kind: "loop", to: CODER_ID, maxRounds: 2 },
    { on: ["clean", "fixed_inline"], kind: "resolve" },
  ] as unknown as OrchestrationThreadShell["routes"];

  const buildLayer = (
    dispatched: Array<OrchestrationCommand>,
    threads: ReadonlyArray<OrchestrationThreadShell>,
    prefix: string,
  ) => {
    const engine = {
      readEvents: () => Stream.empty,
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
      streamDomainEvents: Stream.empty,
      subscribeDomainEvents: Effect.succeed(Stream.empty),
    } as unknown as OrchestrationEngineShape;
    const snapshotQuery = {
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 1,
          goals: [],
          projects: [],
          threads,
          updatedAt: now,
        } satisfies OrchestrationShellSnapshot),
      getPendingTurnStartThreadIds: () => Effect.succeed(new Set<ThreadId>()),
      getActivityFreshnessByThreadId: () =>
        Effect.succeed({ maxCreatedAt: now, maxSequence: 1, heartbeatAt: null }),
      getInFlightToolByThreadId: () => Effect.succeed(null),
    } as unknown as ProjectionSnapshotQueryShape;
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
          WorktreeProvisionerStub,
          ServerConfig.layerTest(process.cwd(), { prefix }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );
  };

  const drainWith = (threads: ReadonlyArray<OrchestrationThreadShell>, prefix: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const dispatched: Array<OrchestrationCommand> = [];
        yield* Effect.gen(function* () {
          const dispatcher = yield* WorkstreamDispatcher;
          yield* dispatcher.start();
          yield* dispatcher.drain;
        }).pipe(Effect.provide(buildLayer(dispatched, threads, prefix)));
        return dispatched;
      }),
    );

  effectIt.effect("holds the coder-only generation while the reviewer can still reopen it", () =>
    Effect.gen(function* () {
      const dispatched = yield* drainWith(
        [
          parent,
          shell({
            id: CODER_ID as unknown as string,
            parentThreadId: PARENT_ID,
            planLane: "done",
            spawnGeneration: "gen-1",
          }),
          shell({
            id: REVIEWER_ID as unknown as string,
            parentThreadId: PARENT_ID,
            planLane: "in_progress",
            routes: gateRoutes,
            session: runningSession({
              threadId: REVIEWER_ID,
              status: "running",
              activeTurnId: "turn-review" as TurnId,
            }),
          }),
        ],
        "t3-workstream-join-held-",
      );
      expect(
        dispatched.filter((c) => c.type === "thread.turn.start" && c.threadId === PARENT_ID),
      ).toHaveLength(0);
    }),
  );

  effectIt.effect("releases the join once the gate source is terminal (resolution)", () =>
    Effect.gen(function* () {
      const dispatched = yield* drainWith(
        [
          parent,
          shell({
            id: CODER_ID as unknown as string,
            parentThreadId: PARENT_ID,
            planLane: "done",
            spawnGeneration: "gen-1",
          }),
          shell({
            id: REVIEWER_ID as unknown as string,
            parentThreadId: PARENT_ID,
            planLane: "done",
            routes: gateRoutes,
            spawnGeneration: "gen-1",
          }),
        ],
        "t3-workstream-join-released-",
      );
      const wakes = dispatched.filter(
        (c) => c.type === "thread.turn.start" && c.threadId === PARENT_ID,
      );
      expect(wakes).toHaveLength(1);
    }),
  );
});

// Cap-breach yield wake (design §6): carries the round count and the
// counterpart's latest round report alongside the yielding reviewer's.
describe("cap-breach yield wake carries both reports (full dispatcher layer)", () => {
  const PARENT_ID = "parent-cap" as ThreadId;
  const REVIEWER_ID = "reviewer-cap" as ThreadId;
  const CODER_ID = "coder-cap" as ThreadId;

  const parent = shell({ id: PARENT_ID as unknown as string, parentThreadId: null, session: null });
  const reviewer = shell({
    id: REVIEWER_ID as unknown as string,
    parentThreadId: PARENT_ID,
    role: "reviewer",
    planLane: "yielded",
    routes: [
      { on: ["needs_rework"], kind: "loop", to: CODER_ID, maxRounds: 2 },
      { on: ["clean", "fixed_inline"], kind: "resolve" },
    ] as unknown as OrchestrationThreadShell["routes"],
    gateRounds: 2,
    reportPath: "/nonexistent/reviewer-cap.md",
    lastOutcome: {
      outcome: "needs_rework",
      decision: "cap-breach",
      round: 2,
      recordedByEventId: "evt-cap-1",
      at: now,
    } as unknown as OrchestrationThreadShell["lastOutcome"],
  });
  const coder = shell({
    id: CODER_ID as unknown as string,
    parentThreadId: PARENT_ID,
    role: "coder",
    planLane: "in_progress",
    reportPath: "/nonexistent/coder-cap.round-2.md",
  });

  const buildLayer = (dispatched: Array<OrchestrationCommand>) => {
    const engine = {
      readEvents: () => Stream.empty,
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
      streamDomainEvents: Stream.empty,
      subscribeDomainEvents: Effect.succeed(Stream.empty),
    } as unknown as OrchestrationEngineShape;
    const snapshotQuery = {
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 1,
          goals: [],
          projects: [],
          threads: [parent, reviewer, coder],
          updatedAt: now,
        } satisfies OrchestrationShellSnapshot),
      getPendingTurnStartThreadIds: () => Effect.succeed(new Set<ThreadId>()),
      getActivityFreshnessByThreadId: () =>
        Effect.succeed({ maxCreatedAt: now, maxSequence: 1, heartbeatAt: null }),
      getInFlightToolByThreadId: () => Effect.succeed(null),
    } as unknown as ProjectionSnapshotQueryShape;
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
          WorktreeProvisionerStub,
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-workstream-cap-breach-" }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );
  };

  effectIt.effect("the yield wake names the exhausted cap and references both reports", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dispatched: Array<OrchestrationCommand> = [];
        yield* Effect.gen(function* () {
          const dispatcher = yield* WorkstreamDispatcher;
          yield* dispatcher.start();
          yield* dispatcher.drain;
          const wakes = dispatched.filter(
            (c): c is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
              c.type === "thread.turn.start" && c.threadId === PARENT_ID,
          );
          expect(wakes).toHaveLength(1);
          const text = wakes[0]!.message.text;
          expect(text).toContain("round cap is exhausted (2/2");
          expect(text).toContain("/nonexistent/reviewer-cap.md");
          expect(text).toContain("coder `coder-cap`");
          expect(text).toContain("/nonexistent/coder-cap.round-2.md");
        }).pipe(Effect.provide(buildLayer(dispatched)));
      }),
    ),
  );
});

// ---------------------------------------------------------------------------
// Re-engagement epoch regression (parent reopen of a done child).
//
// Incident: child submits → done → generation wake delivered (durable receipt)
// → parent reopens the child (`workstream_set_lane` ready) and prompts it →
// child submits again → done, but the second completion's wake was keyed by the
// SAME (parent, spawnGeneration) and deduped forever by the first receipt — the
// parent was never woken. The fix stamps a fresh spawnGeneration on the
// lane-set reopen, so the re-run's completion joins a fresh generation whose
// wake id has no receipt. This drives the REAL decider + projector through the
// full episode loop and checks the wake keying at each step.
// ---------------------------------------------------------------------------
effectIt.layer(NodeServices.layer)("re-engagement epoch (reopened child re-wakes parent)", (it) => {
  const t = "2026-01-01T00:00:00.000Z";
  const PARENT = ThreadId.make("parent-epoch");
  const CHILD = ThreadId.make("child-epoch");

  const applyEvents = (
    readModel: OrchestrationReadModel,
    events: ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
    seqStart: number,
  ) =>
    Effect.gen(function* () {
      let model = readModel;
      for (const [index, event] of events.entries()) {
        model = yield* projectEvent(model, {
          ...event,
          sequence: seqStart + index,
        } as OrchestrationEvent);
      }
      return model;
    });

  const threadCreated = (threadId: ThreadId, parent: ThreadId | null) =>
    ({
      eventId: EventId.make(`evt-${threadId}`),
      aggregateKind: "thread",
      aggregateId: threadId,
      type: "thread.created",
      occurredAt: t,
      commandId: CommandId.make(`cmd-${threadId}`),
      causationEventId: null,
      correlationId: CommandId.make(`cmd-${threadId}`),
      metadata: {},
      payload: {
        threadId,
        projectId: ProjectId.make("project-epoch"),
        ...(parent !== null
          ? {
              parentThreadId: parent,
              role: "coder",
              purpose: "do the thing",
              planLane: "ready",
              spawnGeneration: "gen-epoch-0",
            }
          : {}),
        title: `Thread ${threadId}`,
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: t,
        updatedAt: t,
      },
    }) as Omit<OrchestrationEvent, "sequence">;

  it.effect(
    "second completion after a lane-set reopen joins a FRESH generation whose wake id carries no receipt",
    () =>
      Effect.gen(function* () {
        let model = createEmptyReadModel(t);
        model = yield* projectEvent(model, {
          sequence: 1,
          eventId: EventId.make("evt-project-epoch"),
          aggregateKind: "project",
          aggregateId: ProjectId.make("project-epoch"),
          type: "project.created",
          occurredAt: t,
          commandId: CommandId.make("cmd-project-epoch"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-project-epoch"),
          metadata: {},
          payload: {
            projectId: ProjectId.make("project-epoch"),
            title: "Project",
            workspaceRoot: "/tmp/project-epoch",
            defaultModelSelection: null,
            scripts: [],
            createdAt: t,
            updatedAt: t,
          },
        });
        model = yield* applyEvents(model, [threadCreated(PARENT, null)], 2);
        model = yield* applyEvents(model, [threadCreated(CHILD, PARENT)], 3);

        const decide = (command: OrchestrationCommand) =>
          decideOrchestrationCommand({ command, readModel: model }).pipe(
            Effect.map((decided) => (Array.isArray(decided) ? decided : [decided])),
          );

        // Episode 1: submit → done. The generation joins and its wake id is
        // delivered + durably receipted (simulated receipt set).
        model = yield* applyEvents(
          model,
          yield* decide({
            type: "thread.work.submit",
            commandId: CommandId.make("server:workstream-submit:episode-1"),
            threadId: CHILD,
            reportPath: "/reports/child-epoch.md",
            createdAt: t,
          }),
          10,
        );
        const joined1 = selectJoinedGenerations(model.threads);
        expect(joined1.map((g) => `${g.parentId}::${g.generation}`)).toEqual([
          `${PARENT}::gen-epoch-0`,
        ]);
        const wakeId1 = wakeCommandId(PARENT, joined1[0]!.generation);
        const receipts = new Set([wakeId1]);

        // Parent reopens via the lane-set path (bare/client commandId — the
        // workstream_set_lane tool): the SAME event stamps a fresh generation.
        model = yield* applyEvents(
          model,
          yield* decide({
            type: "thread.plan-lane.set",
            commandId: CommandId.make("11111111-2222-3333-4444-555555555555"),
            threadId: CHILD,
            planLane: "ready",
            createdAt: t,
          }),
          20,
        );
        const reopened = model.threads.find((thread) => thread.id === CHILD)!;
        expect(reopened.spawnGeneration).not.toBe("gen-epoch-0");
        expect(reopened.spawnGeneration).not.toBeNull();
        // The fresh epoch is not terminal yet → nothing joins (no premature wake).
        expect(selectJoinedGenerations(model.threads)).toEqual([]);

        // Episode 2: the re-run submits again → done joins the FRESH generation.
        model = yield* applyEvents(
          model,
          yield* decide({
            type: "thread.work.submit",
            commandId: CommandId.make("server:workstream-submit:episode-2"),
            threadId: CHILD,
            reportPath: "/reports/child-epoch.round-2.md",
            createdAt: t,
          }),
          30,
        );
        const joined2 = selectJoinedGenerations(model.threads);
        expect(joined2).toHaveLength(1);
        const wakeId2 = wakeCommandId(PARENT, joined2[0]!.generation);
        // The regression: with an immutable generation these ids were EQUAL and
        // episode 2 classified as already-woken (silently dropped).
        expect(wakeId2).not.toBe(wakeId1);
        expect(
          classifyGenerationByReceipts({
            wakeDelivered: receipts.has(wakeId2),
            parkBlocked: false,
            parkMarkerPresent: false,
          }),
        ).toEqual({ kind: "deliverable" });
      }),
  );
});

describe("fan-in settlement releases dependents", () => {
  const DEP_ID = "dep-coder" as ThreadId;
  const DEPENDENT_ID = "dependent-coder" as ThreadId;

  // Review finding 2: the dispatcher must re-run its promote pass on a
  // `thread.fanin-set` event. A dependent blocked on an isolated dep that is
  // `done` but not yet fanned in stays gated; once the reactor settles the dep
  // to `completed` (a `thread.fanin-set` event), the dependent is promoted
  // without waiting for the periodic tick.
  effectIt.effect("promotes a dependent once its isolated dependency's fan-in completes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dispatched: Array<OrchestrationCommand> = [];
        const events = yield* PubSub.unbounded<OrchestrationEvent>();
        const threads = yield* Ref.make<ReadonlyArray<OrchestrationThreadShell>>([
          shell({
            id: DEP_ID,
            parentThreadId: "parent-1" as ThreadId,
            isolation: "isolated",
            planLane: "done",
            fanInState: "none",
          }),
          shell({
            id: DEPENDENT_ID,
            parentThreadId: "parent-1" as ThreadId,
            isolation: "isolated",
            planLane: "ready",
            blockedBy: [DEP_ID],
          }),
        ]);
        const shellSnapshot = Effect.map(Ref.get(threads), (current) => ({
          snapshotSequence: 1,
          goals: [],
          projects: [],
          threads: current,
          updatedAt: now,
        }));
        const engine = {
          readEvents: () => Stream.empty,
          dispatch: (command: OrchestrationCommand) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: dispatched.length };
            }),
          streamDomainEvents: Stream.fromPubSub(events),
          subscribeDomainEvents: Effect.succeed(Stream.fromPubSub(events)),
        } satisfies OrchestrationEngineShape;
        const snapshotQuery = {
          getShellSnapshot: () => shellSnapshot,
          getPendingTurnStartThreadIds: () => Effect.succeed(new Set<ThreadId>()),
          getActivityFreshnessByThreadId: () =>
            Effect.succeed({ maxCreatedAt: null, maxSequence: 1, heartbeatAt: null }),
        } as unknown as ProjectionSnapshotQueryShape;
        const receipts = {
          upsert: () => Effect.void,
          getByCommandId: () => Effect.succeed(Option.none()),
        };
        const deps = Layer.mergeAll(
          Layer.succeed(OrchestrationEngineService, engine),
          Layer.succeed(ProjectionSnapshotQuery, snapshotQuery),
          Layer.succeed(OrchestrationCommandReceiptRepository, receipts as never),
          WorktreeProvisionerStub,
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-workstream-fanin-release-" }),
        ).pipe(Layer.provideMerge(NodeServices.layer));
        yield* Effect.gen(function* () {
          const dispatcher = yield* WorkstreamDispatcher;
          yield* dispatcher.start();
          yield* dispatcher.drain;
          // Blocked: the dep is done but its isolated fan-in has not settled.
          expect(
            dispatched.some((c) => c.type === "thread.turn.start" && c.threadId === DEPENDENT_ID),
          ).toBe(false);
          // The reactor settles the fan-in → a `thread.fanin-set` event re-runs the
          // dispatcher pass → the dependent is promoted.
          yield* Ref.update(threads, (current) =>
            current.map((t) => (t.id === DEP_ID ? { ...t, fanInState: "completed" as const } : t)),
          );
          yield* PubSub.publish(events, { type: "thread.fanin-set" } as OrchestrationEvent);
          yield* dispatcher.drain;
          expect(
            dispatched.some((c) => c.type === "thread.turn.start" && c.threadId === DEPENDENT_ID),
          ).toBe(true);
        }).pipe(Effect.provide(WorkstreamDispatcherLive.pipe(Layer.provide(deps))));
      }),
    ),
  );
});
