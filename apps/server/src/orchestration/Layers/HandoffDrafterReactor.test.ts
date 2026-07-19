import {
  ProjectId,
  ProviderInstanceId,
  type OrchestrationCommand,
  type OrchestrationLatestTurn,
  type OrchestrationSession,
  type OrchestrationThreadShell,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";

import {
  HANDOFF_HUNG_GRACE_MS,
  HandoffDrafterReactorLive,
  classifyHandoffSettlement,
} from "./HandoffDrafterReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { HandoffDrafterReactor } from "../Services/HandoffDrafterReactor.ts";
import { HANDOFF_DRAFTER_ROLE } from "../../loom/handoffDraft.ts";

const NOW = "2026-07-19T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);

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

const makeDrafter = (
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell => ({
  id: "drafter" as ThreadId,
  projectId: ProjectId.make("project"),
  goalId: null,
  parentThreadId: null,
  role: HANDOFF_DRAFTER_ROLE,
  purpose: null,
  brief: null,
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
  handoffCount: 0,
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
  session: readySession(),
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  lastActivityPreview: null,
  consults: [],
  ...overrides,
});

describe("classifyHandoffSettlement", () => {
  it("does NOT settle the initial ready session-set before turn.started (turn still running)", () => {
    const drafter = makeDrafter({
      latestTurn: turn("running"),
      session: readySession(),
      handoffCount: 0,
    });
    expect(classifyHandoffSettlement(drafter, NOW_MS)).toEqual({ kind: "none" });
  });

  it("does NOT settle while the session is still running", () => {
    const drafter = makeDrafter({ latestTurn: turn("running"), session: runningSession });
    expect(classifyHandoffSettlement(drafter, NOW_MS)).toEqual({ kind: "none" });
  });

  it("settles a COMPLETED turn with a recorded handoff into the success sequence", () => {
    const drafter = makeDrafter({ latestTurn: turn("completed"), handoffCount: 1 });
    expect(classifyHandoffSettlement(drafter, NOW_MS)).toEqual({
      kind: "success",
      turnId: "turn-1",
    });
  });

  it("settles an ERRORED turn with a recorded handoff into the success sequence", () => {
    const drafter = makeDrafter({
      latestTurn: turn("error"),
      session: readySession("boom"),
      handoffCount: 2,
    });
    expect(classifyHandoffSettlement(drafter, NOW_MS)).toEqual({
      kind: "success",
      turnId: "turn-1",
    });
  });

  it("raises needs_guidance when a terminal turn recorded ZERO handoffs", () => {
    const drafter = makeDrafter({ latestTurn: turn("completed"), handoffCount: 0 });
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
      handoffCount: 0,
      latestTurn: turn("completed"),
    });
    expect(classifyHandoffSettlement(drafter, NOW_MS)).toEqual({ kind: "none" });
  });

  it("does not re-raise guidance once already surfaced", () => {
    const drafter = makeDrafter({
      latestTurn: turn("completed"),
      handoffCount: 0,
      attention: ["needs_guidance"],
    });
    expect(classifyHandoffSettlement(drafter, NOW_MS)).toEqual({ kind: "none" });
  });
});

// Reactor-backed test (stubbed engine records dispatched commands + stubbed
// projection feeds a controlled shell snapshot), the same style the
// WorkstreamFanInReactor suite uses. Exercises the startup reconciliation pass
// and proves archive never precedes the projected provider stop (finding 1).
const runReactorOnce = (drafter: OrchestrationThreadShell) =>
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
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 0,
          projects: [],
          threads: [drafter],
          goals: [],
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
          handoffCount: 1,
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
        handoffCount: 1,
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
      const drafter = makeDrafter({ latestTurn: turn("completed"), handoffCount: 0 });
      const dispatched = yield* runReactorOnce(drafter);
      const raise = dispatched.find((c) => c.type === "thread.attention.raise");
      expect(raise).toBeDefined();
      expect((raise as { reason?: string } | undefined)?.reason).toBe("needs_guidance");
      expect(types(dispatched)).not.toContain("thread.archive");
    }),
  );
});
