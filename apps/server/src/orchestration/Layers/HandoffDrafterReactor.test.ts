import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  GoalId,
  ProjectId,
  ProviderInstanceId,
  type OrchestrationCommand,
  type HandoffDestination,
  type OrchestrationEvent,
  type OrchestrationLatestTurn,
  type OrchestrationSession,
  type OrchestrationThreadLeanShell,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";

import {
  HANDOFF_HUNG_GRACE_MS,
  HandoffDrafterReactorLive,
  classifyHandoffSettlement,
} from "./HandoffDrafterReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { ServerConfig } from "../../config.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { HandoffDrafterReactor } from "../Services/HandoffDrafterReactor.ts";
import { HANDOFF_DRAFTER_ROLE } from "../../loom/handoffDraft.ts";

const NOW = "2026-07-19T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
// Fixed “now” for the TestClock-driven awaiting-stop grace tests (computed at
// module scope so no Date access happens inside Effect code).
const STUCK_NOW_MS = Date.parse("2026-07-19T13:00:00.000Z");

const runningSession: OrchestrationSession = {
  threadId: "drafter" as ThreadId,
  status: "running",
  providerName: "pi",
  runtimeMode: "full-access",
  activeTurnId: "turn-1" as TurnId,
  lastError: null,
  queuedMessages: { steering: [], followUp: [] },
  updatedAt: NOW,
};

const readySession = (lastError: string | null = null): OrchestrationSession => ({
  threadId: "drafter" as ThreadId,
  status: "ready",
  providerName: "pi",
  runtimeMode: "full-access",
  activeTurnId: null,
  lastError,
  queuedMessages: { steering: [], followUp: [] },
  updatedAt: NOW,
});

const turn = (state: OrchestrationLatestTurn["state"]): OrchestrationLatestTurn => ({
  turnId: "turn-1" as TurnId,
  state,
  requestedAt: NOW,
  startedAt: NOW,
  completedAt: state === "running" ? null : NOW,
  assistantMessageId: null,
});

/** N placed handoff destinations — the drafter settlement gate reads the length. */
const placed = (count: number): ReadonlyArray<HandoffDestination> =>
  Array.from({ length: count }, (_, index) => ({
    goalId: GoalId.make(`goal-${index}`),
    threadId: `dest-${index}` as ThreadId,
  }));

const makeDrafter = (
  overrides: Partial<OrchestrationThreadLeanShell> = {},
): OrchestrationThreadLeanShell => ({
  id: "drafter" as ThreadId,
  projectId: ProjectId.make("project"),
  goalId: null,
  parentThreadId: null,
  role: HANDOFF_DRAFTER_ROLE,
  purpose: null,
  graphKey: null,
  kickoffBriefPath: null,
  planLaneSince: null,
  dependenciesSince: null,
  faninSince: null,
  planLane: "in_progress",
  attention: [],
  blockedBy: [],
  spawnGeneration: null,
  forkFromThreadId: "source" as ThreadId,
  continuesThreadId: null,
  reportPath: null,
  routes: [],
  gateRounds: 0,
  pendingRework: false,
  lastOutcome: null,
  isolation: "shared",
  fanInState: "none",
  toolUses: null,
  usedTokens: null,
  maxTokens: null,
  diffAdditions: null,
  diffDeletions: null,
  handoffDestinations: [],
  title: "Handoff: something",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: turn("completed"),
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: readySession(),
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  ...overrides,
});

describe("classifyHandoffSettlement", () => {
  it("does NOT settle the initial ready session-set before turn.started (turn still running)", () => {
    const drafter = makeDrafter({
      latestTurn: turn("running"),
      session: readySession(),
      handoffDestinations: [],
    });
    expect(classifyHandoffSettlement(drafter, NOW_MS)).toEqual({ kind: "none" });
  });

  it("does NOT settle while the session is still running", () => {
    const drafter = makeDrafter({ latestTurn: turn("running"), session: runningSession });
    expect(classifyHandoffSettlement(drafter, NOW_MS)).toEqual({ kind: "none" });
  });

  it("settles a COMPLETED turn with a recorded handoff into the success sequence", () => {
    const drafter = makeDrafter({ latestTurn: turn("completed"), handoffDestinations: placed(1) });
    expect(classifyHandoffSettlement(drafter, NOW_MS)).toEqual({
      kind: "success",
      turnId: "turn-1",
    });
  });

  it("settles an ERRORED turn with a recorded handoff into the success sequence", () => {
    const drafter = makeDrafter({
      latestTurn: turn("error"),
      session: readySession("boom"),
      handoffDestinations: placed(2),
    });
    expect(classifyHandoffSettlement(drafter, NOW_MS)).toEqual({
      kind: "success",
      turnId: "turn-1",
    });
  });

  it("raises needs_guidance when a terminal turn recorded ZERO handoffs", () => {
    const drafter = makeDrafter({ latestTurn: turn("completed"), handoffDestinations: [] });
    expect(classifyHandoffSettlement(drafter, NOW_MS)).toEqual({
      kind: "guidance",
      reasonKey: "zero:turn-1",
    });
  });

  it("raises needs_guidance immediately on a turn-start failure (no turn, session lastError)", () => {
    const drafter = makeDrafter({ latestTurn: null, session: readySession("fork refused") });
    expect(classifyHandoffSettlement(drafter, NOW_MS)).toEqual({
      kind: "guidance",
      reasonKey: "turn-start-failed",
    });
  });

  it("waits while a kickoff is genuinely in flight within the grace window", () => {
    const drafter = makeDrafter({ latestTurn: null, session: null, createdAt: NOW });
    expect(classifyHandoffSettlement(drafter, NOW_MS)).toEqual({ kind: "none" });
  });

  it("raises needs_guidance for a never-started kickoff hung past the grace window", () => {
    const drafter = makeDrafter({ latestTurn: null, session: null, createdAt: NOW });
    const later = NOW_MS + HANDOFF_HUNG_GRACE_MS + 1;
    expect(classifyHandoffSettlement(drafter, later)).toEqual({
      kind: "guidance",
      reasonKey: "kickoff-hung",
    });
  });

  it("waits while a RUNNING kickoff turn is within the grace window", () => {
    const drafter = makeDrafter({ latestTurn: turn("running"), session: runningSession });
    expect(classifyHandoffSettlement(drafter, NOW_MS)).toEqual({ kind: "none" });
  });

  it("raises needs_guidance for a RUNNING kickoff turn hung past the grace window (finding 2)", () => {
    const drafter = makeDrafter({ latestTurn: turn("running"), session: runningSession });
    const later = NOW_MS + HANDOFF_HUNG_GRACE_MS + 1;
    expect(classifyHandoffSettlement(drafter, later)).toEqual({
      kind: "guidance",
      reasonKey: "kickoff-hung",
    });
  });

  it("does not re-settle an archived drafter", () => {
    const drafter = makeDrafter({
      archivedAt: NOW,
      handoffDestinations: [],
      latestTurn: turn("completed"),
    });
    expect(classifyHandoffSettlement(drafter, NOW_MS)).toEqual({ kind: "none" });
  });

  it("does not re-raise guidance once already surfaced", () => {
    const drafter = makeDrafter({
      latestTurn: turn("completed"),
      handoffDestinations: [],
      attention: ["needs_guidance"],
    });
    expect(classifyHandoffSettlement(drafter, NOW_MS)).toEqual({ kind: "none" });
  });
});

// Reactor-backed test (stubbed engine records dispatched commands + stubbed
// projection feeds a controlled shell snapshot), the same style the
// WorkstreamFanInReactor suite uses. Exercises the startup reconciliation pass
// and proves archive never precedes the projected provider stop (finding 1).
const runReactorOnce = (drafter: OrchestrationThreadLeanShell) =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);

    const engineLayer = Layer.succeed(OrchestrationEngineService, {
      readEvents: () => Stream.empty,
      streamDomainEvents: Stream.empty,
      subscribeDomainEvents: Effect.succeed(Stream.empty),
      dispatch: (command: OrchestrationCommand) =>
        Ref.update(dispatched, (xs) => [...xs, command]).pipe(Effect.as({ sequence: 0 })),
    } as never);

    const projectionLayer = Layer.succeed(ProjectionSnapshotQuery, {
      // Honours the `role` quarry the reactor now pushes into the query — a mock
      // that ignored it would return the drafter even when the real query would
      // not, masking exactly the class of bug the filter could introduce.
      getLeanShellSnapshot: (options?: { readonly role: string }) =>
        Effect.succeed({
          snapshotSequence: 0,
          projects: [],
          threads: [drafter].filter(
            (thread) => options === undefined || thread.role === options.role,
          ),
          updatedAt: "1970-01-01T00:00:00.000Z",
        }),
    } as never);

    const layer = HandoffDrafterReactorLive.pipe(
      Layer.provide(engineLayer),
      Layer.provide(projectionLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    yield* Effect.gen(function* () {
      const reactor = yield* HandoffDrafterReactor;
      yield* reactor.start();
      yield* reactor.drain;
    }).pipe(Effect.scoped, Effect.provide(layer));

    return yield* Ref.get(dispatched);
  });

const types = (commands: ReadonlyArray<OrchestrationCommand>) => commands.map((c) => c.type);

describe("HandoffDrafterReactor settlement sequence (reactor-backed)", () => {
  effectIt.effect(
    "with a LIVE session: dispatches done + session.stop and does NOT archive yet",
    () =>
      Effect.gen(function* () {
        const drafter = makeDrafter({
          latestTurn: turn("completed"),
          handoffDestinations: placed(1),
          session: readySession(),
        });
        const dispatched = yield* runReactorOnce(drafter);
        expect(types(dispatched)).toContain("thread.plan-lane.set");
        expect(types(dispatched)).toContain("thread.session.stop");
        // Archive must NOT precede the projected provider stop (finding 1).
        expect(types(dispatched)).not.toContain("thread.archive");
      }),
  );

  effectIt.effect("once the session is STOPPED: archives (and issues no further stop)", () =>
    Effect.gen(function* () {
      const drafter = makeDrafter({
        latestTurn: turn("completed"),
        handoffDestinations: placed(1),
        session: { ...readySession(), status: "stopped" },
      });
      const dispatched = yield* runReactorOnce(drafter);
      expect(types(dispatched)).toContain("thread.plan-lane.set");
      expect(types(dispatched)).toContain("thread.archive");
      expect(types(dispatched)).not.toContain("thread.session.stop");
    }),
  );

  effectIt.effect("zero-handoff terminal turn raises needs_guidance (no archive, no stop)", () =>
    Effect.gen(function* () {
      const drafter = makeDrafter({ latestTurn: turn("completed"), handoffDestinations: [] });
      const dispatched = yield* runReactorOnce(drafter);
      const raise = dispatched.find((c) => c.type === "thread.attention.raise");
      expect(raise).toBeDefined();
      expect((raise as { reason?: string } | undefined)?.reason).toBe("needs_guidance");
      expect(types(dispatched)).not.toContain("thread.archive");
    }),
  );

  const stopCommandId = (commands: ReadonlyArray<OrchestrationCommand>) =>
    commands.find((c) => c.type === "thread.session.stop")?.commandId;

  // round-2 MF-1: each reconciliation pass over a still-live session must issue a
  // FRESH stop command id. A fixed/deterministic id would, after the engine
  // accepts it once, make every retry a receipt no-op that never re-publishes the
  // provider stop — so a failed/lost stop side effect would strand the drafter
  // forever. Distinct ids across passes prove the retry actually redelivers.
  effectIt.effect("re-attempts the stop with a FRESH id on each pass (redelivery)", () =>
    Effect.gen(function* () {
      const drafter = makeDrafter({
        latestTurn: turn("completed"),
        handoffDestinations: placed(1),
        session: readySession(),
      });
      const first = yield* runReactorOnce(drafter);
      const second = yield* runReactorOnce(drafter);
      const id1 = stopCommandId(first);
      const id2 = stopCommandId(second);
      expect(id1).toBeDefined();
      expect(id2).toBeDefined();
      expect(id1).not.toBe(id2);
    }),
  );

  // round-2 MF-1: a stop stuck past the grace window (a failing/lost side effect
  // that never reaches `stopped`) must be SURFACED with needs_guidance, not
  // silently retried out of sight — while still re-attempting the stop and never
  // archiving.
  // The stop-stuck clock is only meaningful once the input snapshot ALREADY
  // reads `done` (a re-arm after a prior pass set the lane) — then `planLaneSince`
  // is a durable settlement-start stamp.
  effectIt.effect("surfaces a persistently stuck stop after the grace window", () =>
    Effect.gen(function* () {
      // Settlement (lane `done`) began an hour before “now” ⇒ well past the grace.
      yield* TestClock.setTime(STUCK_NOW_MS);
      const drafter = makeDrafter({
        latestTurn: turn("completed"),
        handoffDestinations: placed(1),
        session: readySession(),
        planLane: "done",
        planLaneSince: "2026-07-19T12:00:00.000Z",
      });
      const dispatched = yield* runReactorOnce(drafter);
      expect(types(dispatched)).toContain("thread.session.stop");
      const raise = dispatched.find((c) => c.type === "thread.attention.raise");
      expect((raise as { reason?: string } | undefined)?.reason).toBe("needs_guidance");
      expect(types(dispatched)).not.toContain("thread.archive");
    }),
  );

  // A within-grace settlement wait does NOT surface (no premature needs_guidance
  // while the stop is still landing).
  effectIt.effect("does not surface a stop that is still within the grace window", () =>
    Effect.gen(function* () {
      // Settlement (lane `done`) began only a minute before “now” ⇒ within grace.
      yield* TestClock.setTime(STUCK_NOW_MS);
      const drafter = makeDrafter({
        latestTurn: turn("completed"),
        handoffDestinations: placed(1),
        session: readySession(),
        planLane: "done",
        planLaneSince: "2026-07-19T12:59:00.000Z",
      });
      const dispatched = yield* runReactorOnce(drafter);
      expect(types(dispatched)).toContain("thread.session.stop");
      expect(types(dispatched)).not.toContain("thread.attention.raise");
    }),
  );

  // Regression (final MF): a healthy but LONG drafting turn — lane still
  // `in_progress` with a kickoff `planLaneSince` older than the grace window —
  // must NOT be flagged broken on its first settlement pass. The stop is
  // requested; NO needs_guidance is raised (the stuck clock only ages a `done`
  // snapshot). Preserves the invisible-when-healthy contract.
  effectIt.effect("does not surface on the first (in_progress) pass of a long healthy turn", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(STUCK_NOW_MS);
      const drafter = makeDrafter({
        latestTurn: turn("completed"),
        handoffDestinations: placed(1),
        session: readySession(),
        // Kickoff lane transition an hour ago, but the lane is still in_progress
        // (this is the first settlement pass) — aging against it would be wrong.
        planLane: "in_progress",
        planLaneSince: "2026-07-19T12:00:00.000Z",
      });
      const dispatched = yield* runReactorOnce(drafter);
      expect(types(dispatched)).toContain("thread.plan-lane.set");
      expect(types(dispatched)).toContain("thread.session.stop");
      expect(types(dispatched)).not.toContain("thread.attention.raise");
      expect(types(dispatched)).not.toContain("thread.archive");
    }),
  );
});

// Real-engine test (real OrchestrationEngine + receipt store + projection over
// in-memory SQLite): proves the mechanism the round-2 MF-1 fix depends on — a
// DETERMINISTIC command id is deduped by the receipt store (a lost side effect
// is never re-published), whereas a FRESH id per attempt re-publishes the
// provider stop, so reconciliation genuinely re-attempts it.
const realEngineLayer = OrchestrationEngineLive.pipe(
  Layer.provide(OrchestrationProjectionSnapshotQueryLive),
  Layer.provide(OrchestrationProjectionPipelineLive),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-handoff-conv-" })),
  Layer.provide(NodeServices.layer),
);

const stopCommand = (id: string): OrchestrationCommand => ({
  type: "thread.session.stop",
  commandId: CommandId.make(id),
  threadId: "drafter-1" as ThreadId,
  createdAt: NOW,
});

describe("HandoffDrafterReactor stop redelivery (real engine receipt store)", () => {
  effectIt.effect("a deterministic stop id is deduped; fresh ids each re-publish the stop", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-create"),
        projectId: ProjectId.make("project-1"),
        title: "Project 1",
        workspaceRoot: "/tmp/project-1",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt: NOW,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create"),
        threadId: "drafter-1" as ThreadId,
        projectId: ProjectId.make("project-1"),
        role: HANDOFF_DRAFTER_ROLE,
        title: "Handoff: fix retry",
        titleProvenance: "curated",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
      });

      const countStops = engine.readEvents(0, 10_000).pipe(
        Stream.filter(
          (event: OrchestrationEvent) => event.type === "thread.session-stop-requested",
        ),
        Stream.runCount,
      );

      // A DETERMINISTIC id dispatched twice (a lost side effect would retry) —
      // the second is a receipt no-op, so only ONE stop event is published.
      yield* engine.dispatch(stopCommand("server:handoff-settle:stop:drafter-1:turn-1"));
      yield* engine.dispatch(stopCommand("server:handoff-settle:stop:drafter-1:turn-1"));
      expect(yield* countStops).toBe(1);

      // FRESH ids per attempt re-publish the stop, so reconciliation genuinely
      // re-attempts the provider stop.
      yield* engine.dispatch(stopCommand("server:handoff-settle:stop:drafter-1:turn-1:nonce-a"));
      yield* engine.dispatch(stopCommand("server:handoff-settle:stop:drafter-1:turn-1:nonce-b"));
      expect(yield* countStops).toBe(3);
    }).pipe(Effect.provide(realEngineLayer)),
  );
});
