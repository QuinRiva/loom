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
import { makeEnvironmentShellState, ShellSnapshotLoader } from "./shell.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};

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
  forkFromThreadId: null,
  reportPath: null,
  graphKey: null,
  kickoffBriefPath: null,
  planLaneSince: null,
  dependenciesSince: null,
  faninSince: null,
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
        prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
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
        loadServerConfig: () => Effect.succeed(Option.none()),
        saveServerConfig: () => Effect.void,
        loadVcsRefs: () => Effect.succeed(Option.none()),
        saveVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });
      // Cold cache with no HTTP snapshot available → falls back to the
      // socket-embedded snapshot.
      const snapshotLoader = ShellSnapshotLoader.of({
        load: () => Effect.succeed(Option.none()),
      });
      const shellState = yield* makeEnvironmentShellState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        Effect.provideService(ShellSnapshotLoader, snapshotLoader),
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
  // Conformed to #3719: the shell now establishes a base snapshot before the
  // live subscription, so this test provides a ShellSnapshotLoader (returning
  // none, i.e. cold cache falls through to the socket-embedded snapshot) and
  // exercises the coalescing on the resulting live leg.
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
        prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
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
        loadServerConfig: () => Effect.succeed(Option.none()),
        saveServerConfig: () => Effect.void,
        loadVcsRefs: () => Effect.succeed(Option.none()),
        saveVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });
      // Cold cache falls through to this loader; returning none makes the shell
      // fall back to the socket-embedded snapshot (seeded below).
      const snapshotLoader = ShellSnapshotLoader.of({
        load: () => Effect.succeed(Option.none()),
      });
      const shellState = yield* makeEnvironmentShellState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        Effect.provideService(ShellSnapshotLoader, snapshotLoader),
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

  it.effect("resumes a warm shell cache via afterSequence without an HTTP fetch", () =>
    Effect.gen(function* () {
      const cachedSnapshot: OrchestrationShellSnapshot = {
        snapshotSequence: 5,
        goals: [],
        projects: [],
        threads: [],
        updatedAt: "2026-06-06T00:00:00.000Z",
      };
      const events = yield* Queue.unbounded<OrchestrationShellStreamItem>();
      const capturedAfterSequence = yield* SubscriptionRef.make<number | undefined>(undefined);
      const loaderCalls = yield* SubscriptionRef.make(0);
      const client = {
        [ORCHESTRATION_WS_METHODS.subscribeShell]: (input: { readonly afterSequence?: number }) =>
          Stream.unwrap(
            SubscriptionRef.set(capturedAfterSequence, input.afterSequence).pipe(
              Effect.as(Stream.fromQueue(events)),
            ),
          ),
      } as unknown as WsRpcProtocolClient;
      const supervisorState = yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE);
      const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
        Option.some(session(client)),
      );
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: supervisorState,
        session: activeSession,
        prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeed(Option.some(cachedSnapshot)),
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeed(Option.none()),
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        loadServerConfig: () => Effect.succeed(Option.none()),
        saveServerConfig: () => Effect.void,
        loadVcsRefs: () => Effect.succeed(Option.none()),
        saveVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });
      const snapshotLoader = ShellSnapshotLoader.of({
        load: () =>
          SubscriptionRef.update(loaderCalls, (count) => count + 1).pipe(Effect.as(Option.none())),
      });
      yield* makeEnvironmentShellState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        Effect.provideService(ShellSnapshotLoader, snapshotLoader),
      );

      // Wait until the subscription is established from the warm cache.
      yield* SubscriptionRef.changes(capturedAfterSequence).pipe(
        Stream.filter((value) => value !== undefined),
        Stream.runHead,
      );

      expect(yield* SubscriptionRef.get(capturedAfterSequence)).toBe(5);
      expect(yield* SubscriptionRef.get(loaderCalls)).toBe(0);
    }),
  );

  // Regression: a warm IndexedDB cache whose afterSequence resume fails (e.g.
  // the offline gap spans a schema migration that makes a stored event
  // undecodable server-side, so the catch-up replay errors) must NOT wedge on
  // the stale list forever. The client discards the poisoned cache, self-heals
  // via the cold-path full snapshot over HTTP, and re-persists it.
  it.effect("self-heals to the cold path when a warm-cache resume fails", () =>
    Effect.gen(function* () {
      const cachedSnapshot: OrchestrationShellSnapshot = {
        snapshotSequence: 5,
        goals: [],
        projects: [],
        threads: [],
        updatedAt: "2026-06-06T00:00:00.000Z",
      };
      // The fresh snapshot loaded over HTTP once the cache is discarded.
      const freshSnapshot: OrchestrationShellSnapshot = {
        snapshotSequence: 42,
        goals: [STUB_GOAL],
        projects: [],
        threads: [STUB_THREAD],
        updatedAt: "2026-06-07T00:00:00.000Z",
      };
      const coldEvents = yield* Queue.unbounded<OrchestrationShellStreamItem>();
      const subscribeSequences = yield* SubscriptionRef.make<ReadonlyArray<number | undefined>>([]);
      const loaderCalls = yield* SubscriptionRef.make(0);
      const savedSnapshots = yield* SubscriptionRef.make<ReadonlyArray<OrchestrationShellSnapshot>>(
        [],
      );
      const client = {
        [ORCHESTRATION_WS_METHODS.subscribeShell]: (input: { readonly afterSequence?: number }) =>
          Stream.unwrap(
            SubscriptionRef.update(subscribeSequences, (calls) => [
              ...calls,
              input.afterSequence,
            ]).pipe(
              Effect.as(
                // The warm-cache resume (afterSequence === 5) errors, standing
                // in for the poison event in the catch-up replay window. The
                // cold-path resubscribe streams normally.
                input.afterSequence === cachedSnapshot.snapshotSequence
                  ? Stream.fail(new Error("undecodable shell event in catch-up replay"))
                  : Stream.fromQueue(coldEvents),
              ),
            ),
          ),
      } as unknown as WsRpcProtocolClient;
      const supervisorState = yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE);
      const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
        Option.some(session(client)),
      );
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: supervisorState,
        session: activeSession,
        prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeed(Option.some(cachedSnapshot)),
        saveShell: (_environmentId, snapshot) =>
          SubscriptionRef.update(savedSnapshots, (saved) => [...saved, snapshot]),
        loadThread: () => Effect.succeed(Option.none()),
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        loadServerConfig: () => Effect.succeed(Option.none()),
        saveServerConfig: () => Effect.void,
        loadVcsRefs: () => Effect.succeed(Option.none()),
        saveVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });
      const snapshotLoader = ShellSnapshotLoader.of({
        load: () =>
          SubscriptionRef.update(loaderCalls, (count) => count + 1).pipe(
            Effect.as(Option.some(freshSnapshot)),
          ),
      });
      const shellState = yield* makeEnvironmentShellState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        Effect.provideService(ShellSnapshotLoader, snapshotLoader),
      );

      // Drive the warm-cache failure → cold-path fallback, then flush the
      // coalescing window and the debounced persistence.
      for (let index = 0; index < 20; index += 1) {
        yield* Effect.yieldNow;
      }
      yield* TestClock.adjust("20 millis");
      for (let index = 0; index < 20; index += 1) {
        yield* Effect.yieldNow;
      }
      yield* TestClock.adjust("500 millis");
      for (let index = 0; index < 20; index += 1) {
        yield* Effect.yieldNow;
      }

      // The poisoned cache was discarded and the cold-path HTTP loader used.
      expect(yield* SubscriptionRef.get(loaderCalls)).toBe(1);
      // First subscribe resumed from the warm cache (5); after it failed the
      // client resubscribed from the fresh cold snapshot (42).
      expect(yield* SubscriptionRef.get(subscribeSequences)).toEqual([5, 42]);
      // The fresh snapshot replaced the stale cache and is live — no wedge.
      const state = yield* SubscriptionRef.get(shellState);
      expect(state.status).toBe("live");
      expect(Option.getOrThrow(state.snapshot)).toEqual(freshSnapshot);
      expect((yield* SubscriptionRef.get(savedSnapshots)).at(-1)).toEqual(freshSnapshot);
    }),
  );
});
