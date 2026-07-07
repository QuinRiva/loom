import {
  EnvironmentId,
  GoalId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import * as RpcSession from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { makeEnvironmentShellState } from "./shell.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const LIVE_SHELL_SNAPSHOT: OrchestrationShellSnapshot = {
  snapshotSequence: 1,
  goals: [],
  projects: [],
  threads: [],
  updatedAt: "2026-06-06T00:00:00.000Z",
};

const STUB_GOAL = {
  id: GoalId.make("goal-1"),
  projectId: ProjectId.make("project-1"),
  slug: "goal-1",
  title: "Test Goal",
  description: "",
  tasks: [],
  createdAt: "2026-06-06T00:00:00.000Z",
  updatedAt: "2026-06-06T00:00:00.000Z",
  archivedAt: null,
} as const;

const STUB_THREAD = {
  id: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  goalId: GoalId.make("goal-1"),
  parentThreadId: null,
  role: null,
  purpose: null,
  brief: null,
  planLane: "planned" as const,
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
  title: "Test Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  latestTurn: null,
  cumulativeCostUsd: 0,
  toolUses: null,
  usedTokens: null,
  maxTokens: null,
  diffAdditions: null,
  diffDeletions: null,
  createdAt: "2026-06-06T00:00:00.000Z",
  updatedAt: "2026-06-06T00:00:00.000Z",
  archivedAt: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  lastActivityPreview: null,
  consults: [],
  session: null,
} as const;

function session(client: WsRpcProtocolClient): RpcSession.RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

describe("environment shell synchronization", () => {
  it.effect("publishes live state before persistence and preserves it when ready", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<OrchestrationShellStreamItem>();
      const client = {
        [ORCHESTRATION_WS_METHODS.subscribeShell]: () => Stream.fromQueue(events),
      } as unknown as WsRpcProtocolClient;
      const supervisorState = yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE);
      const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
        Option.some(session(client)),
      );
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: supervisorState,
        session: activeSession,
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeed(Option.none()),
        saveShell: () => Effect.never,
        loadThread: () => Effect.succeed(Option.none()),
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        clear: () => Effect.void,
      });
      const shellState = yield* makeEnvironmentShellState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
      );

      yield* SubscriptionRef.set(supervisorState, {
        desired: true,
        network: "online",
        phase: "connecting",
        stage: "synchronizing",
        attempt: 1,
        generation: 0,
        lastFailure: null,
        retryAt: null,
      });
      yield* Queue.offer(events, {
        kind: "snapshot",
        snapshot: LIVE_SHELL_SNAPSHOT,
      });
      // The shell stream coalesces bursts within a short window; let the
      // subscription pull the item, then advance the test clock so the group
      // flushes.
      for (let index = 0; index < 10; index += 1) {
        yield* Effect.yieldNow;
      }
      yield* TestClock.adjust("20 millis");
      yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter((state) => state.status === "live"),
        Stream.runHead,
      );

      yield* SubscriptionRef.set(supervisorState, {
        desired: true,
        network: "online",
        phase: "connected",
        stage: null,
        attempt: 1,
        generation: 1,
        lastFailure: null,
        retryAt: null,
      });
      for (let index = 0; index < 10; index += 1) {
        yield* Effect.yieldNow;
      }

      const state = yield* SubscriptionRef.get(shellState);
      expect(state.status).toBe("live");
      expect(Option.getOrThrow(state.snapshot)).toEqual(LIVE_SHELL_SNAPSHOT);
    }),
  );

  // Regression: a command cascade (thread.archive → goal.archived) streams as
  // a burst of individual events. Applied one at a time, the intermediate
  // state — goal present but thread gone — renders as a flash of an empty goal
  // header in the sidebar. The stream coalesces bursts into ONE state update.
  it.effect("applies a cascade burst as a single state update with no intermediate state", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<OrchestrationShellStreamItem>();
      const client = {
        [ORCHESTRATION_WS_METHODS.subscribeShell]: () => Stream.fromQueue(events),
      } as unknown as WsRpcProtocolClient;
      const supervisorState = yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE);
      const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
        Option.some(session(client)),
      );
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: supervisorState,
        session: activeSession,
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeed(Option.none()),
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeed(Option.none()),
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        clear: () => Effect.void,
      });
      const shellState = yield* makeEnvironmentShellState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
      );

      const observedSnapshots: OrchestrationShellSnapshot[] = [];
      yield* SubscriptionRef.changes(shellState).pipe(
        Stream.runForEach((state) =>
          Effect.sync(() => {
            if (Option.isSome(state.snapshot)) observedSnapshots.push(state.snapshot.value);
          }),
        ),
        Effect.forkScoped,
      );

      const seededSnapshot: OrchestrationShellSnapshot = {
        snapshotSequence: 1,
        goals: [STUB_GOAL],
        projects: [],
        threads: [STUB_THREAD],
        updatedAt: "2026-06-06T00:00:00.000Z",
      };
      yield* Queue.offer(events, { kind: "snapshot", snapshot: seededSnapshot });
      for (let index = 0; index < 10; index += 1) {
        yield* Effect.yieldNow;
      }
      yield* TestClock.adjust("20 millis");
      yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter((state) => state.status === "live"),
        Stream.runHead,
      );

      // The cascade burst: thread archived + its goal archived, back to back.
      yield* Queue.offerAll(events, [
        { kind: "thread-removed", sequence: 2, threadId: STUB_THREAD.id },
        { kind: "goal-removed", sequence: 3, goalId: STUB_GOAL.id },
      ]);
      for (let index = 0; index < 10; index += 1) {
        yield* Effect.yieldNow;
      }
      yield* TestClock.adjust("20 millis");
      for (let index = 0; index < 10; index += 1) {
        yield* Effect.yieldNow;
      }

      const finalSnapshot = observedSnapshots.at(-1);
      expect(finalSnapshot?.threads).toEqual([]);
      expect(finalSnapshot?.goals).toEqual([]);
      expect(finalSnapshot?.snapshotSequence).toBe(3);
      // No intermediate state was ever published: nothing observed between the
      // seeded snapshot and the fully-applied cascade (goal gone WITH thread).
      const intermediate = observedSnapshots.filter(
        (snapshot) => snapshot.threads.length === 0 && snapshot.goals.length > 0,
      );
      expect(intermediate).toEqual([]);
    }),
  );
});
