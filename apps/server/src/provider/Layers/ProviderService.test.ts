// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type {
  ProviderApprovalDecision,
  UserInputResolvedOutcome,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderTurnStartResult,
} from "@t3tools/contracts";
import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionStartInput,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { it, assert, vi } from "@effect/vitest";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderSessionDirectoryPersistenceError,
  ProviderUnsupportedError,
  ProviderValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import {
  userInputContentDelivered,
  type ProviderAdapterShape,
  type UserInputDeliveryResult,
} from "../Services/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import { makeProviderServiceLive } from "./ProviderService.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import { makeAdapterRegistryMock } from "../testUtils/providerAdapterRegistryMock.ts";
import { makeWorkspaceLease, WorkspaceLease } from "../../workspace/WorkspaceLease.ts";

const WorkspaceLeaseTestLive = Layer.effect(WorkspaceLease, makeWorkspaceLease);

const defaultServerSettingsLayer = ServerSettings.ServerSettingsService.layerTest();

const asRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const codexInstanceId = ProviderInstanceId.make("codex");
const claudeAgentInstanceId = ProviderInstanceId.make("claudeAgent");
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_AGENT_DRIVER = ProviderDriverKind.make("claudeAgent");
const CURSOR_DRIVER = ProviderDriverKind.make("cursor");

type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderDriverKind;
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

function makeFakeCodexAdapter(
  provider: ProviderDriverKind = CODEX_DRIVER,
  // Mirrors the real capability: `true` = this driver's `stopSession` produces a
  // `session.exited` (PiDriver/OpenCode/Grok/Claude/Cursor), `false` = it stops
  // silently (Codex). Workspace-hold accounting branches on it, so tests must be
  // able to exercise both.
  options?: { readonly emitsExitOnStop?: boolean },
) {
  const sessions = new Map<ThreadId, ProviderSession>();
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());

  const startSession = vi.fn((input: ProviderSessionStartInput) =>
    Effect.sync(() => {
      const now = "2026-01-01T00:00:00.000Z";
      const session: ProviderSession = {
        provider,
        ...(input.providerInstanceId !== undefined
          ? { providerInstanceId: input.providerInstanceId }
          : {}),
        status: "ready",
        runtimeMode: input.runtimeMode,
        threadId: input.threadId,
        resumeCursor: input.resumeCursor ?? {
          opaque: `resume-${String(input.threadId)}`,
        },
        cwd: input.cwd ?? process.cwd(),
        createdAt: now,
        updatedAt: now,
      };
      sessions.set(session.threadId, session);
      return session;
    }),
  );

  const sendTurn = vi.fn(
    (
      input: ProviderSendTurnInput,
    ): Effect.Effect<ProviderTurnStartResult, ProviderAdapterError> => {
      if (!sessions.has(input.threadId)) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider,
            threadId: input.threadId,
          }),
        );
      }

      return Effect.succeed({
        threadId: input.threadId,
        turnId: TurnId.make(`turn-${String(input.threadId)}`),
      });
    },
  );

  const interruptTurn = vi.fn(
    (_threadId: ThreadId, _turnId?: TurnId): Effect.Effect<void, ProviderAdapterError> =>
      Effect.void,
  );

  const respondToRequest = vi.fn(
    (
      _threadId: ThreadId,
      _requestId: string,
      _decision: ProviderApprovalDecision,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  );

  const respondToUserInput = vi.fn(
    (
      _threadId: ThreadId,
      _requestId: string,
      _answers: Record<string, unknown>,
      _settlement?: { readonly outcome: UserInputResolvedOutcome; readonly message?: string },
    ): Effect.Effect<UserInputDeliveryResult, ProviderAdapterError> =>
      Effect.succeed(userInputContentDelivered),
  );

  const stopSession = vi.fn(
    (threadId: ThreadId): Effect.Effect<void, ProviderAdapterError> =>
      Effect.sync(() => {
        sessions.delete(threadId);
      }),
  );

  const listSessions = vi.fn(
    (): Effect.Effect<ReadonlyArray<ProviderSession>> =>
      Effect.sync(() => Array.from(sessions.values())),
  );

  const hasSession = vi.fn(
    (threadId: ThreadId): Effect.Effect<boolean> => Effect.succeed(sessions.has(threadId)),
  );

  const getSession = vi.fn(
    (threadId: ThreadId): Effect.Effect<ProviderSession | undefined> =>
      Effect.sync(() => sessions.get(threadId)),
  );

  const readThread = vi.fn(
    (
      threadId: ThreadId,
    ): Effect.Effect<
      {
        threadId: ThreadId;
        turns: ReadonlyArray<{ id: TurnId; items: readonly [] }>;
      },
      ProviderAdapterError
    > =>
      Effect.succeed({
        threadId,
        turns: [{ id: asTurnId("turn-1"), items: [] }],
      }),
  );

  const rollbackThread = vi.fn(
    (
      threadId: ThreadId,
      _numTurns: number,
    ): Effect.Effect<{ threadId: ThreadId; turns: readonly [] }, ProviderAdapterError> =>
      Effect.succeed({ threadId, turns: [] }),
  );

  const stopAll = vi.fn(
    (): Effect.Effect<void, ProviderAdapterError> =>
      Effect.sync(() => {
        sessions.clear();
      }),
  );

  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider,
    capabilities: {
      sessionModelSwitch: "in-session",
      emitsExitOnStop: options?.emitsExitOnStop ?? true,
    },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    getSession,
    readThread,
    rollbackThread,
    stopAll,
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event as unknown as ProviderRuntimeEvent));
  };

  // Emit a `session.exited` the way EVERY real driver does: the adapter's live
  // session entry is removed before/as the event is published (`PiDriver.ts:1853`
  // → `:1868`, `ClaudeAdapter.ts:3187`, `CodexAdapter.ts:1741`,
  // `OpenCodeAdapter.ts:1678`, `GrokAdapter.ts:539`, `CursorAdapter.ts:501`).
  // Publishing an exit while `hasSession` still reports true would model a
  // process that died without the driver noticing, which no driver does.
  const emitSessionExited = (event: LegacyProviderRuntimeEvent): void => {
    sessions.delete(event.threadId);
    emit(event);
  };

  const updateSession = (
    threadId: ThreadId,
    update: (session: ProviderSession) => ProviderSession,
  ): void => {
    const existing = sessions.get(threadId);
    if (!existing) {
      return;
    }
    sessions.set(threadId, update(existing));
  };

  return {
    adapter,
    emit,
    updateSession,
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    getSession,
    readThread,
    rollbackThread,
    stopAll,
    emitSessionExited,
  };
}

const advanceTestClock = (ms: number) =>
  TestClock.adjust(`${ms} millis`).pipe(Effect.andThen(Effect.yieldNow));

const hasMetricSnapshot = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
) =>
  snapshots.some(
    (snapshot) =>
      snapshot.id === id &&
      Object.entries(attributes).every(([key, value]) => snapshot.attributes?.[key] === value),
  );

function makeProviderServiceLayer() {
  const codex = makeFakeCodexAdapter();
  const claude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
  const cursor = makeFakeCodexAdapter(CURSOR_DRIVER);
  const registry = makeAdapterRegistryMock({
    [ProviderDriverKind.make("codex")]: codex.adapter,
    [ProviderDriverKind.make("claudeAgent")]: claude.adapter,
    [ProviderDriverKind.make("cursor")]: cursor.adapter,
  });

  const providerAdapterLayer = Layer.succeed(
    ProviderAdapterRegistry.ProviderAdapterRegistry,
    registry,
  );
  const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
  );
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

  const layer = it.layer(
    Layer.mergeAll(
      makeProviderServiceLive().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(WorkspaceLeaseTestLive),
        Layer.provideMerge(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      ),
      directoryLayer,

      runtimeRepositoryLayer,
      NodeServices.layer,
    ),
  );

  return {
    codex,
    claude,
    cursor,
    layer,
  };
}

it.effect("ProviderServiceLive catches stopAll failures during shutdown", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    codex.stopAll.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: String(CODEX_DRIVER),
          method: "stopAll",
          detail: "simulated stopAll failure",
        }),
      ),
    );
    const registry = makeAdapterRegistryMock({
      [CODEX_DRIVER]: codex.adapter,
    });
    const providerAdapterLayer = Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistry,
      registry,
    );
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = Layer.mergeAll(
      makeProviderServiceLive().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(WorkspaceLeaseTestLive),
        Layer.provideMerge(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      ),
      directoryLayer,
      runtimeRepositoryLayer,
      NodeServices.layer,
    );
    const scope = yield* Scope.make();
    const runtimeServices = yield* Layer.build(providerLayer).pipe(Scope.provide(scope));

    yield* ProviderService.ProviderService.pipe(Effect.provide(runtimeServices));
    const closeExit = yield* Scope.close(scope, Exit.void).pipe(Effect.exit);

    assert.equal(Exit.isSuccess(closeExit), true);
    assert.equal(codex.stopAll.mock.calls.length, 1);
  }),
);

it.effect("ProviderServiceLive rejects new sessions for disabled providers", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const claude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
    const registryBase = makeAdapterRegistryMock({
      [CODEX_DRIVER]: codex.adapter,
      [CLAUDE_AGENT_DRIVER]: claude.adapter,
    });
    const registry: ProviderAdapterRegistry.ProviderAdapterRegistry["Service"] = {
      ...registryBase,
      getInstanceInfo: (instanceId) =>
        instanceId === claudeAgentInstanceId
          ? Effect.succeed({
              instanceId,
              driverKind: CLAUDE_AGENT_DRIVER,
              displayName: undefined,
              enabled: false,
              continuationIdentity: {
                driverKind: CLAUDE_AGENT_DRIVER,
                continuationKey: "claudeAgent:instance:claudeAgent",
              },
            })
          : registryBase.getInstanceInfo(instanceId),
    };
    const providerAdapterLayer = Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistry,
      registry,
    );
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(providerAdapterLayer),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(WorkspaceLeaseTestLive),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    const failure = yield* Effect.flip(
      Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        return yield* provider.startSession(asThreadId("thread-disabled"), {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId("thread-disabled"),
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer)),
    );

    assert.instanceOf(failure, ProviderValidationError);
    assert.include(failure.issue, "Provider instance 'claudeAgent' is disabled");
    assert.equal(claude.startSession.mock.calls.length, 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "ProviderServiceLive allows enabled custom instances when legacy driver is disabled",
  () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex_personal");
      const driverKind = CODEX_DRIVER;
      const codex = makeFakeCodexAdapter();
      const unsupported = () =>
        new ProviderUnsupportedError({
          provider: driverKind,
        });
      const registry: ProviderAdapterRegistry.ProviderAdapterRegistry["Service"] = {
        getByInstance: (requestedInstanceId) =>
          requestedInstanceId === instanceId
            ? Effect.succeed(codex.adapter)
            : Effect.fail(unsupported()),
        getInstanceInfo: (requestedInstanceId) =>
          requestedInstanceId === instanceId
            ? Effect.succeed({
                instanceId,
                driverKind,
                displayName: "Codex Personal",
                enabled: true,
                continuationIdentity: {
                  driverKind,
                  continuationKey: "codex:/Users/example/.codex",
                },
              })
            : Effect.fail(unsupported()),
        listInstances: () => Effect.succeed([instanceId]),
        listProviders: () => Effect.succeed([driverKind] as const),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
          PubSub.subscribe(pubsub),
        ),
      };
      const providerAdapterLayer = Layer.succeed(
        ProviderAdapterRegistry.ProviderAdapterRegistry,
        registry,
      );
      const serverSettingsLayer = ServerSettings.ServerSettingsService.layerTest({
        providers: {
          codex: {
            enabled: false,
          },
        },
      });
      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(SqlitePersistenceMemory),
      );
      const directoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const providerLayer = makeProviderServiceLive().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(serverSettingsLayer),
        Layer.provide(WorkspaceLeaseTestLive),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      const session = yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        return yield* provider.startSession(asThreadId("thread-enabled-custom"), {
          provider: driverKind,
          providerInstanceId: instanceId,
          threadId: asThreadId("thread-enabled-custom"),
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer));

      assert.equal(session.providerInstanceId, instanceId);
      assert.equal(codex.startSession.mock.calls.length, 1);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ProviderServiceLive rejects new sessions for disabled custom instances", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("codex_personal");
    const driverKind = ProviderDriverKind.make("codex");
    const codex = makeFakeCodexAdapter();
    const unsupported = () =>
      new ProviderUnsupportedError({
        provider: ProviderDriverKind.make("codex"),
      });
    const registry: ProviderAdapterRegistry.ProviderAdapterRegistry["Service"] = {
      getByInstance: (requestedInstanceId) =>
        requestedInstanceId === instanceId
          ? Effect.succeed(codex.adapter)
          : Effect.fail(unsupported()),
      getInstanceInfo: (requestedInstanceId) =>
        requestedInstanceId === instanceId
          ? Effect.succeed({
              instanceId,
              driverKind,
              displayName: "Codex Personal",
              enabled: false,
              continuationIdentity: {
                driverKind,
                continuationKey: "codex:/Users/example/.codex",
              },
            })
          : Effect.fail(unsupported()),
      listInstances: () => Effect.succeed([instanceId]),
      listProviders: () => Effect.succeed([CODEX_DRIVER] as const),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
        PubSub.subscribe(pubsub),
      ),
    };
    const providerAdapterLayer = Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistry,
      registry,
    );
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(providerAdapterLayer),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(WorkspaceLeaseTestLive),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    const failure = yield* Effect.flip(
      Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        return yield* provider.startSession(asThreadId("thread-disabled-instance"), {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: instanceId,
          threadId: asThreadId("thread-disabled-instance"),
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer)),
    );

    assert.instanceOf(failure, ProviderValidationError);
    assert.include(failure.issue, "Provider instance 'codex_personal' is disabled");
    assert.equal(codex.startSession.mock.calls.length, 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ProviderServiceLive getSession finds an active session with no persisted binding", () =>
  Effect.gen(function* () {
    // `listSessions` derives truth from the adapters, so an adapter-active
    // session is reported even with no binding row. getSession must agree: if a
    // missing binding made a live session invisible, ingestion would lose its
    // expected turn id and the command reactor could start a SECOND session for
    // a thread that already has one.
    const codex = makeFakeCodexAdapter();
    const registry = makeAdapterRegistryMock({
      [ProviderDriverKind.make("codex")]: codex.adapter,
    });
    const threadId = asThreadId("thread-get-session-no-binding");

    let getBindingCalls = 0;
    const directoryLayer = Layer.succeed(ProviderSessionDirectory.ProviderSessionDirectory, {
      upsert: () => Effect.void,
      getProvider: () => Effect.die(new Error("getProvider is not used in this test")),
      getBinding: () =>
        Effect.sync(() => {
          getBindingCalls += 1;
          return Option.none();
        }),
      listThreadIds: () => Effect.succeed([]),
      listBindings: () => Effect.succeed([]),
      removeIfStopped: () => Effect.succeed(true),
    });

    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    const found = yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-get-session-no-binding",
        runtimeMode: "full-access",
      });
      return yield* provider.getSession(threadId);
    }).pipe(Effect.provide(providerLayer));

    assert.equal(getBindingCalls > 0, true);
    assert.equal(found?.threadId, threadId);
    assert.equal(found?.providerInstanceId, codexInstanceId);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "ProviderServiceLive getSession finds an active session when the binding read fails",
  () =>
    Effect.gen(function* () {
      // A directory read FAILURE must degrade to the adapter-derived answer, not
      // to "no session": the failure mode that matters is reporting a live
      // session as absent on the hot path.
      const codex = makeFakeCodexAdapter();
      const registry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("codex")]: codex.adapter,
      });
      const threadId = asThreadId("thread-get-session-binding-read-fails");

      // `startSession` also reads the binding, so only start failing once the
      // session is live — the scenario under test is a read failure at lookup
      // time, not a broken directory throughout.
      let failBindingReads = false;
      const directoryLayer = Layer.succeed(ProviderSessionDirectory.ProviderSessionDirectory, {
        upsert: () => Effect.void,
        getProvider: () => Effect.die(new Error("getProvider is not used in this test")),
        getBinding: () =>
          failBindingReads
            ? Effect.fail(
                new ProviderSessionDirectoryPersistenceError({
                  operation: "ProviderSessionDirectory.getBinding:getByThreadId",
                  detail: "simulated directory read failure",
                }),
              )
            : Effect.succeed(Option.none()),
        listThreadIds: () => Effect.succeed([]),
        listBindings: () => Effect.succeed([]),
        removeIfStopped: () => Effect.succeed(true),
      });

      const providerLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      const found = yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        yield* provider.startSession(threadId, {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId,
          cwd: "/tmp/project-get-session-binding-read-fails",
          runtimeMode: "full-access",
        });
        failBindingReads = true;
        return yield* provider.getSession(threadId);
      }).pipe(Effect.provide(providerLayer));

      assert.equal(found?.threadId, threadId);
      assert.equal(found?.providerInstanceId, codexInstanceId);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "ProviderServiceLive getSession dies when a session is live on a non-binding instance",
  () =>
    Effect.gen(function* () {
      // Live in instance B while the binding names A. `listSessions` treats this
      // as a routing invariant violation; getSession must too, rather than
      // reporting the session as absent (which would hide the inconsistency and
      // let a second session be started).
      const codex = makeFakeCodexAdapter();
      const claude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
      const registry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("codex")]: codex.adapter,
        [ProviderDriverKind.make("claudeAgent")]: claude.adapter,
      });
      const threadId = asThreadId("thread-get-session-wrong-instance");

      const directoryLayer = Layer.succeed(ProviderSessionDirectory.ProviderSessionDirectory, {
        upsert: () => Effect.void,
        getProvider: () => Effect.die(new Error("getProvider is not used in this test")),
        // Binding names the claudeAgent instance...
        getBinding: () =>
          Effect.succeed(
            Option.some({
              threadId,
              provider: CLAUDE_AGENT_DRIVER,
              providerInstanceId: claudeAgentInstanceId,
              status: "running" as const,
              runtimeMode: "full-access" as const,
            }),
          ),
        listThreadIds: () => Effect.succeed([]),
        listBindings: () => Effect.succeed([]),
        removeIfStopped: () => Effect.succeed(true),
      });

      const providerLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      const exit = yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        // ...but the session is actually live on the codex instance.
        yield* provider.startSession(threadId, {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId,
          cwd: "/tmp/project-get-session-wrong-instance",
          runtimeMode: "full-access",
        });
        return yield* Effect.exit(provider.getSession(threadId));
      }).pipe(Effect.provide(providerLayer));

      assert.equal(Exit.hasDies(exit), true);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ProviderServiceLive resolves one session without listing any adapter's sessions", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const claude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
    const registry = makeAdapterRegistryMock({
      [ProviderDriverKind.make("codex")]: codex.adapter,
      [ProviderDriverKind.make("claudeAgent")]: claude.adapter,
    });
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    const result = yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-get-session");
      const started = yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-get-session",
        runtimeMode: "approval-required",
      });
      yield* provider.sendTurn({ threadId, input: "hello", attachments: [] });
      // The fake adapter's sendTurn does not write activeTurnId onto its session
      // (the real drivers do), so set it explicitly: activeTurnId is the field
      // the per-event ingestion path reads, so it must survive this lookup.
      codex.updateSession(threadId, (session) => ({
        ...session,
        activeTurnId: asTurnId("turn-get-session"),
      }));

      codex.listSessions.mockClear();
      claude.listSessions.mockClear();
      codex.getSession.mockClear();
      claude.getSession.mockClear();
      const found = yield* provider.getSession(threadId);
      const codexGetCalls = codex.getSession.mock.calls.length;
      const claudeGetCalls = claude.getSession.mock.calls.length;
      const missing = yield* provider.getSession(asThreadId("thread-get-session-absent"));
      return {
        started,
        found,
        missing,
        codexGetCalls,
        claudeGetCalls,
        codexListCalls: codex.listSessions.mock.calls.length,
        claudeListCalls: claude.listSessions.mock.calls.length,
      } as const;
    }).pipe(Effect.provide(providerLayer));

    // Thread-addressed: no adapter is asked to materialise its session list (for
    // Codex that is a serial read per live runtime, which on the per-event path
    // is the cost being removed).
    assert.equal(result.codexListCalls, 0);
    assert.equal(result.claudeListCalls, 0);

    // And in the steady state the binding orders the adapters so the OWNING one
    // answers first: exactly one keyed adapter read, no walk over the others.
    assert.equal(result.codexGetCalls, 1);
    assert.equal(result.claudeGetCalls, 0);

    // Preserves every field the migrated hot-path callers consume.
    assert.equal(result.found?.threadId, result.started.threadId);
    assert.equal(result.found?.providerInstanceId, codexInstanceId);
    assert.equal(result.found?.provider, "codex");
    assert.equal(result.found?.cwd, "/tmp/project-get-session");
    assert.equal(result.found?.runtimeMode, "approval-required");
    assert.equal(result.found?.activeTurnId, asTurnId("turn-get-session"));

    // Absent thread reports undefined rather than failing.
    assert.equal(result.missing, undefined);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "ProviderServiceLive dies when getSession sees an adapter/binding provider mismatch",
  () =>
    Effect.gen(function* () {
      const codex = makeFakeCodexAdapter();
      const registry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("codex")]: codex.adapter,
      });
      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(SqlitePersistenceMemory),
      );
      const directoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const providerLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
        Layer.provideMerge(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      // The routing invariant `listSessions` enforces is preserved on the
      // single-thread path: callers route turns from this result, so an adapter
      // reporting a driver the persisted binding disagrees with must not be
      // silently tolerated.
      const exit = yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
        const threadId = asThreadId("thread-get-session-mismatch");
        yield* provider.startSession(threadId, {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId,
          cwd: "/tmp/project-get-session-mismatch",
          runtimeMode: "full-access",
        });
        yield* directory.upsert({
          threadId,
          provider: CLAUDE_AGENT_DRIVER,
          providerInstanceId: codexInstanceId,
          runtimeMode: "full-access",
        });
        return yield* Effect.exit(provider.getSession(threadId));
      }).pipe(Effect.provide(providerLayer));

      assert.equal(Exit.hasDies(exit), true);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ProviderServiceLive lists sessions with a constant number of directory reads", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const registry = makeAdapterRegistryMock({
      [ProviderDriverKind.make("codex")]: codex.adapter,
    });

    const bindings = new Map<
      ThreadId,
      ProviderSessionDirectory.ProviderRuntimeBindingWithMetadata
    >();
    for (let index = 0; index < 200; index += 1) {
      const threadId = asThreadId(`thread-stopped-${index}`);
      bindings.set(threadId, {
        threadId,
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        status: "stopped",
        runtimeMode: "full-access",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      });
    }
    const activeThreadId = asThreadId("thread-active");
    bindings.set(activeThreadId, {
      threadId: activeThreadId,
      provider: CODEX_DRIVER,
      providerInstanceId: codexInstanceId,
      status: "running",
      runtimeMode: "approval-required",
      resumeCursor: { opaque: "resume-from-binding" },
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    });

    let getBindingCalls = 0;
    let listBindingsCalls = 0;
    let listThreadIdsCalls = 0;
    const directoryLayer = Layer.succeed(ProviderSessionDirectory.ProviderSessionDirectory, {
      upsert: () => Effect.void,
      getProvider: () => Effect.die(new Error("getProvider is not used in this test")),
      getBinding: (threadId) =>
        Effect.sync(() => {
          getBindingCalls += 1;
          const binding = bindings.get(threadId);
          return binding ? Option.some(binding) : Option.none();
        }),
      listThreadIds: () =>
        Effect.sync(() => {
          listThreadIdsCalls += 1;
          return [...bindings.keys()];
        }),
      listBindings: () =>
        Effect.sync(() => {
          listBindingsCalls += 1;
          return [...bindings.values()];
        }),
      removeIfStopped: () => Effect.succeed(true),
    });

    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    const { sessions, reads } = yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      yield* provider.startSession(activeThreadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId: activeThreadId,
        cwd: "/tmp/project-list-sessions",
        runtimeMode: "full-access",
      });
      getBindingCalls = 0;
      listBindingsCalls = 0;
      listThreadIdsCalls = 0;
      const listed = yield* provider.listSessions();
      // Read the counters before the layer's stopAll finalizer runs.
      return {
        sessions: listed,
        reads: { getBindingCalls, listBindingsCalls, listThreadIdsCalls },
      } as const;
    }).pipe(Effect.provide(providerLayer));

    // O(1) directory reads: one bulk listing, no per-row re-fetch.
    assert.equal(reads.listBindingsCalls, 1);
    assert.equal(reads.getBindingCalls, 0);
    assert.equal(reads.listThreadIdsCalls, 0);

    // The persisted-binding merge is unchanged.
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.threadId, activeThreadId);
    assert.equal(sessions[0]?.runtimeMode, "approval-required");
    assert.equal(sessions[0]?.providerInstanceId, codexInstanceId);
  }).pipe(Effect.provide(NodeServices.layer)),
);

const routing = makeProviderServiceLayer();

it.effect("ProviderServiceLive writes canonical events to the emitting thread segment", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const canonicalEvents: ProviderRuntimeEvent[] = [];
    const canonicalThreadIds: Array<string | null> = [];
    const registry = makeAdapterRegistryMock({
      [ProviderDriverKind.make("codex")]: codex.adapter,
    });
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = makeProviderServiceLive({
      canonicalEventLogger: {
        filePath: "memory://provider-canonical-events",
        write: (event, threadId) => {
          canonicalEvents.push(event as ProviderRuntimeEvent);
          canonicalThreadIds.push(threadId ?? null);
          return Effect.void;
        },
        close: () => Effect.void,
      },
    }).pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(WorkspaceLeaseTestLive),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    yield* Effect.gen(function* () {
      yield* ProviderService.ProviderService;
      yield* advanceTestClock(10);
      codex.emit({
        eventId: asEventId("evt-canonical-thread-segment"),
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-canonical-thread-segment"),
        createdAt: "2026-01-01T00:00:00.000Z",
        type: "turn.completed",
        payload: {
          state: "completed",
        },
      });
      yield* advanceTestClock(20);
    }).pipe(Effect.provide(providerLayer));

    assert.equal(canonicalEvents.length, 1);
    assert.equal(canonicalEvents[0]?.threadId, "thread-canonical-thread-segment");
    assert.deepEqual(canonicalThreadIds, ["thread-canonical-thread-segment"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ProviderServiceLive does not rewrite already-stopped bindings on shutdown", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const registry = makeAdapterRegistryMock({
      [ProviderDriverKind.make("codex")]: codex.adapter,
    });
    // A real file, not `:memory:`: each `Layer.provide(SqlitePersistenceMemory)`
    // builds its own private in-memory database, so the row written before
    // shutdown would not be visible to the reader afterwards.
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-stopall-"));
    const dbPath = NodePath.join(tempDir, "orchestration.sqlite");
    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(persistenceLayer),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const stoppedThreadId = asThreadId("thread-stopall-already-stopped");

    yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      yield* directory.upsert({
        threadId: stoppedThreadId,
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        status: "stopped",
        runtimeMode: "full-access",
      });
    }).pipe(Effect.provide(directoryLayer));

    const before = yield* Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      return yield* repository.getByThreadId({ threadId: stoppedThreadId });
    }).pipe(Effect.provide(runtimeRepositoryLayer));

    // Build and immediately release the provider layer so its scope finalizer
    // (runStopAll) executes.
    yield* Effect.gen(function* () {
      yield* ProviderService.ProviderService;
    }).pipe(
      Effect.provide(
        makeProviderServiceLive().pipe(
          Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
          Layer.provide(directoryLayer),
          Layer.provide(defaultServerSettingsLayer),
          Layer.provide(AnalyticsService.layerTest),
          Layer.provide(
            Layer.succeed(
              ProviderEventLoggers.ProviderEventLoggers,
              ProviderEventLoggers.NoOpProviderEventLoggers,
            ),
          ),
        ),
      ),
    );

    const after = yield* Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      return yield* repository.getByThreadId({ threadId: stoppedThreadId });
    }).pipe(Effect.provide(runtimeRepositoryLayer));

    // The row must be byte-identical: shutdown used to rewrite EVERY binding,
    // which cost ~2 statements per historical row on the single serial SQL
    // connection after the HTTP grace period, and reset `lastSeenAt` on all of
    // them at once. `lastRuntimeEvent: "provider.stopAll"` is the marker
    // runStopAll writes, so its absence proves this row was left alone
    // (`lastSeenAt` alone cannot: a same-instant rewrite is indistinguishable).
    const afterRow = Option.getOrUndefined(after);
    assert.equal(afterRow?.status, "stopped");
    assert.equal(afterRow?.lastSeenAt, Option.getOrUndefined(before)?.lastSeenAt);
    const afterPayload = afterRow?.runtimePayload;
    const stampedByStopAll =
      afterPayload !== null &&
      typeof afterPayload === "object" &&
      !Array.isArray(afterPayload) &&
      "lastRuntimeEvent" in afterPayload &&
      afterPayload.lastRuntimeEvent === "provider.stopAll";
    assert.equal(stampedByStopAll, false);

    NodeFS.rmSync(tempDir, { recursive: true, force: true });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ProviderServiceLive keeps persisted resumable sessions on startup", () =>
  Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-service-"));
    const dbPath = NodePath.join(tempDir, "orchestration.sqlite");

    const codex = makeFakeCodexAdapter();
    const registry = makeAdapterRegistryMock({
      [ProviderDriverKind.make("codex")]: codex.adapter,
    });

    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(persistenceLayer),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

    yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      yield* directory.upsert({
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: ThreadId.make("thread-stale"),
      });
    }).pipe(Effect.provide(directoryLayer));

    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(WorkspaceLeaseTestLive),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    yield* ProviderService.ProviderService.pipe(Effect.provide(providerLayer));

    const persistedProvider = yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      return yield* directory.getProvider(asThreadId("thread-stale"));
    }).pipe(Effect.provide(directoryLayer));
    assert.equal(persistedProvider, "codex");

    const runtime = yield* Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      return yield* repository.getByThreadId({
        threadId: asThreadId("thread-stale"),
      });
    }).pipe(Effect.provide(runtimeRepositoryLayer));
    assert.equal(Option.isSome(runtime), true);

    const legacyTableRows = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'provider_sessions'
      `;
    }).pipe(Effect.provide(persistenceLayer));
    assert.equal(legacyTableRows.length, 0);

    NodeFS.rmSync(tempDir, { recursive: true, force: true });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "ProviderServiceLive restores rollback routing after restart using persisted thread mapping",
  () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-provider-service-restart-"),
      );
      const dbPath = NodePath.join(tempDir, "orchestration.sqlite");
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(persistenceLayer),
      );

      const firstCodex = makeFakeCodexAdapter();
      const firstRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("codex")]: firstCodex.adapter,
      });

      const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const firstProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, firstRegistry),
        ),
        Layer.provide(firstDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(WorkspaceLeaseTestLive),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );
      const updatedResumeCursor = {
        threadId: asThreadId("thread-1"),
        resume: "resume-session-1",
        resumeSessionAt: "assistant-message-1",
        turnCount: 1,
      };

      const startedSession = yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        const threadId = asThreadId("thread-1");
        const session = yield* provider.startSession(threadId, {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: "/tmp/project",
          runtimeMode: "full-access",
          threadId,
        });
        firstCodex.updateSession(threadId, (existing) => ({
          ...existing,
          status: "ready",
          resumeCursor: updatedResumeCursor,
          updatedAt: "2026-01-01T00:00:01.000Z",
        }));
        return session;
      }).pipe(Effect.provide(firstProviderLayer));

      const persistedAfterStopAll = yield* Effect.gen(function* () {
        const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
        return yield* repository.getByThreadId({
          threadId: startedSession.threadId,
        });
      }).pipe(Effect.provide(runtimeRepositoryLayer));
      assert.equal(Option.isSome(persistedAfterStopAll), true);
      if (Option.isSome(persistedAfterStopAll)) {
        assert.equal(persistedAfterStopAll.value.status, "stopped");
        assert.deepEqual(persistedAfterStopAll.value.resumeCursor, updatedResumeCursor);
      }

      const secondCodex = makeFakeCodexAdapter();
      const secondRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("codex")]: secondCodex.adapter,
      });
      const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const secondProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, secondRegistry),
        ),
        Layer.provide(secondDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(WorkspaceLeaseTestLive),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      secondCodex.startSession.mockClear();
      secondCodex.rollbackThread.mockClear();

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        yield* provider.rollbackConversation({
          threadId: startedSession.threadId,
          numTurns: 1,
        });
      }).pipe(Effect.provide(secondProviderLayer));

      assert.equal(secondCodex.startSession.mock.calls.length, 1);
      const resumedStartInput = secondCodex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project");
        assert.deepEqual(startPayload.resumeCursor, updatedResumeCursor);
        assert.equal(startPayload.threadId, startedSession.threadId);
      }
      assert.equal(secondCodex.rollbackThread.mock.calls.length, 1);
      const rollbackCall = secondCodex.rollbackThread.mock.calls[0];
      assert.equal(typeof rollbackCall?.[0], "string");
      assert.equal(rollbackCall?.[1], 1);

      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
);

routing.layer("ProviderServiceLive routing", (it) => {
  it.effect("routes provider operations and rollback conversation", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      assert.equal(session.provider, "codex");

      const sessions = yield* provider.listSessions();
      assert.equal(sessions.length, 1);

      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);

      yield* provider.interruptTurn({ threadId: session.threadId });
      assert.deepEqual(routing.codex.interruptTurn.mock.calls, [[session.threadId, undefined]]);

      yield* provider.respondToRequest({
        threadId: session.threadId,
        requestId: asRequestId("req-1"),
        decision: "accept",
      });
      assert.deepEqual(routing.codex.respondToRequest.mock.calls, [
        [session.threadId, asRequestId("req-1"), "accept"],
      ]);

      yield* provider.respondToUserInput({
        threadId: session.threadId,
        requestId: asRequestId("req-user-input-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
      });
      // The settlement the adapter must hand its waiting tool call. Absent on the
      // wire means `answered`, and the default is applied here so an adapter never
      // has to re-derive it.
      assert.deepEqual(routing.codex.respondToUserInput.mock.calls, [
        [
          session.threadId,
          asRequestId("req-user-input-1"),
          {
            sandbox_mode: "workspace-write",
          },
          { outcome: "answered" },
        ],
      ]);

      yield* provider.rollbackConversation({
        threadId: session.threadId,
        numTurns: 0,
      });

      yield* provider.stopSession({ threadId: session.threadId });
      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "after-stop",
        attachments: [],
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project");
        assert.deepEqual(startPayload.resumeCursor, session.resumeCursor);
        assert.equal(startPayload.threadId, session.threadId);
      }
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("recovers stale persisted sessions for rollback by resuming thread identity", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      yield* routing.codex.stopSession(initial.threadId);
      routing.codex.startSession.mockClear();
      routing.codex.rollbackThread.mockClear();

      yield* provider.rollbackConversation({
        threadId: initial.threadId,
        numTurns: 1,
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.codex.rollbackThread.mock.calls.length, 1);
      const rollbackCall = routing.codex.rollbackThread.mock.calls[0];
      assert.equal(rollbackCall?.[1], 1);
    }),
  );

  it.effect("preserves the persisted binding when stopping a session", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

      const initial = yield* provider.startSession(asThreadId("thread-reap-preserve"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-reap-preserve"),
        cwd: "/tmp/project-reap-preserve",
        runtimeMode: "full-access",
      });

      yield* provider.stopSession({ threadId: initial.threadId });

      const persistedAfterStop = yield* runtimeRepository.getByThreadId({
        threadId: initial.threadId,
      });
      assert.equal(Option.isSome(persistedAfterStop), true);
      if (Option.isSome(persistedAfterStop)) {
        assert.equal(persistedAfterStop.value.status, "stopped");
        assert.deepEqual(persistedAfterStop.value.resumeCursor, initial.resumeCursor);
      }

      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume after reap",
        attachments: [],
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project-reap-preserve");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("routes explicit claudeAgent provider session starts to the claude adapter", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-claude"), {
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        threadId: asThreadId("thread-claude"),
        cwd: "/tmp/project-claude",
        runtimeMode: "full-access",
      });

      assert.equal(session.provider, "claudeAgent");
      assert.equal(routing.claude.startSession.mock.calls.length, 1);
      const startInput = routing.claude.startSession.mock.calls[0]?.[0];
      assert.equal(typeof startInput === "object" && startInput !== null, true);
      if (startInput && typeof startInput === "object") {
        const startPayload = startInput as {
          provider?: string;
          providerInstanceId?: ProviderInstanceId;
          cwd?: string;
        };
        assert.equal(startPayload.provider, "claudeAgent");
        assert.equal(startPayload.providerInstanceId, claudeAgentInstanceId);
        assert.equal(startPayload.cwd, "/tmp/project-claude");
      }
    }),
  );

  it.effect("dies when an active session conflicts with its persisted binding", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const threadId = asThreadId("thread-binding-mismatch");

      yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-binding-mismatch",
        runtimeMode: "full-access",
      });
      yield* directory.upsert({
        threadId,
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        runtimeMode: "full-access",
      });

      const exit = yield* Effect.exit(provider.listSessions());
      assert.equal(Exit.hasDies(exit), true);
      yield* directory.upsert({
        threadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        runtimeMode: "full-access",
      });
    }),
  );

  it.effect("stops stale sessions in other providers after a successful replacement start", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const threadId = asThreadId("thread-provider-replacement");

      const codexSession = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-provider-replacement",
        runtimeMode: "full-access",
      });

      routing.codex.stopSession.mockClear();
      routing.claude.stopSession.mockClear();

      const claudeSession = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        threadId,
        cwd: "/tmp/project-provider-replacement",
        runtimeMode: "full-access",
      });

      assert.equal(codexSession.provider, "codex");
      assert.equal(claudeSession.provider, "claudeAgent");
      assert.deepEqual(routing.codex.stopSession.mock.calls, [[threadId]]);
      assert.equal(routing.claude.stopSession.mock.calls.length, 0);

      const sessions = yield* provider.listSessions();
      assert.deepEqual(
        sessions
          .filter((session) => session.threadId === threadId)
          .map((session) => session.provider),
        ["claudeAgent"],
      );
    }),
  );

  it.effect("recovers stale sessions for sendTurn using persisted cwd", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project-send-turn",
        runtimeMode: "full-access",
      });

      yield* routing.codex.stopAll();
      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume",
        attachments: [],
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project-send-turn");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("recovers stale claudeAgent sessions for sendTurn using persisted cwd", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-claude-send-turn"), {
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        threadId: asThreadId("thread-claude-send-turn"),
        cwd: "/tmp/project-claude-send-turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "effort", value: "max" }],
        ),
        runtimeMode: "full-access",
      });

      yield* routing.claude.stopAll();
      routing.claude.startSession.mockClear();
      routing.claude.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume with claude",
        attachments: [],
      });

      assert.equal(routing.claude.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.claude.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          modelSelection?: unknown;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "claudeAgent");
        assert.equal(startPayload.cwd, "/tmp/project-claude-send-turn");
        assert.deepEqual(
          startPayload.modelSelection,
          createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-opus-4-6", [
            { id: "effort", value: "max" },
          ]),
        );
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.claude.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("lists no sessions after adapter runtime clears", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });
      yield* provider.startSession(asThreadId("thread-2"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-2"),
        runtimeMode: "full-access",
      });

      yield* routing.codex.stopAll();
      yield* routing.claude.stopAll();

      const remaining = yield* provider.listSessions();
      assert.equal(remaining.length, 0);
    }),
  );

  it.effect("persists runtime status transitions in provider_session_runtime", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

      const threadId = asThreadId("thread-runtime-status");
      const session = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      const runningRuntime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runningRuntime), true);
      if (Option.isSome(runningRuntime)) {
        assert.equal(runningRuntime.value.status, "running");
        assert.deepEqual(runningRuntime.value.resumeCursor, session.resumeCursor);
        const payload = runningRuntime.value.runtimePayload;
        assert.equal(payload !== null && typeof payload === "object", true);
        if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
          const runtimePayload = payload as {
            cwd: string;
            model: string | null;
            activeTurnId: string | null;
            lastError: string | null;
            lastRuntimeEvent: string | null;
          };
          assert.equal(runtimePayload.cwd, session.cwd);
          assert.equal(runtimePayload.model, null);
          assert.equal(runtimePayload.activeTurnId, `turn-${String(session.threadId)}`);
          assert.equal(runtimePayload.lastError, null);
          assert.equal(runtimePayload.lastRuntimeEvent, "provider.sendTurn");
        }
      }
    }),
  );

  it.effect("reuses persisted resume cursor when startSession is called after a restart", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-provider-service-start-"),
      );
      const dbPath = NodePath.join(tempDir, "orchestration.sqlite");
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
        Layer.provide(persistenceLayer),
      );

      const firstClaude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
      const firstRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("claudeAgent")]: firstClaude.adapter,
      });
      const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const firstProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, firstRegistry),
        ),
        Layer.provide(firstDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(WorkspaceLeaseTestLive),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      const initial = yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        return yield* provider.startSession(asThreadId("thread-claude-start"), {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId("thread-claude-start"),
          cwd: "/tmp/project-claude-start",
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(firstProviderLayer));

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        yield* provider.listSessions();
      }).pipe(Effect.provide(firstProviderLayer));

      const secondClaude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
      const secondRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("claudeAgent")]: secondClaude.adapter,
      });
      const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const secondProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(
          Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, secondRegistry),
        ),
        Layer.provide(secondDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(WorkspaceLeaseTestLive),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      );

      secondClaude.startSession.mockClear();

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        yield* provider.startSession(initial.threadId, {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: initial.threadId,
          cwd: "/tmp/project-claude-start",
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(secondProviderLayer));

      assert.equal(secondClaude.startSession.mock.calls.length, 1);
      const resumedStartInput = secondClaude.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "claudeAgent");
        assert.equal(startPayload.cwd, "/tmp/project-claude-start");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }

      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "reuses persisted cwd when startSession resumes a claude session without cwd input",
    () =>
      Effect.gen(function* () {
        const tempDir = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "t3-provider-service-cwd-"),
        );
        const dbPath = NodePath.join(tempDir, "orchestration.sqlite");
        const persistenceLayer = makeSqlitePersistenceLive(dbPath);
        const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
          Layer.provide(persistenceLayer),
        );

        const firstClaude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
        const firstRegistry = makeAdapterRegistryMock({
          [ProviderDriverKind.make("claudeAgent")]: firstClaude.adapter,
        });
        const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
          Layer.provide(runtimeRepositoryLayer),
        );
        const firstProviderLayer = makeProviderServiceLive().pipe(
          Layer.provide(
            Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, firstRegistry),
          ),
          Layer.provide(firstDirectoryLayer),
          Layer.provide(defaultServerSettingsLayer),
          Layer.provide(WorkspaceLeaseTestLive),
          Layer.provide(AnalyticsService.layerTest),
          Layer.provide(
            Layer.succeed(
              ProviderEventLoggers.ProviderEventLoggers,
              ProviderEventLoggers.NoOpProviderEventLoggers,
            ),
          ),
        );

        const initial = yield* Effect.gen(function* () {
          const provider = yield* ProviderService.ProviderService;
          return yield* provider.startSession(asThreadId("thread-claude-cwd"), {
            provider: ProviderDriverKind.make("claudeAgent"),
            providerInstanceId: claudeAgentInstanceId,
            threadId: asThreadId("thread-claude-cwd"),
            cwd: "/tmp/project-claude-cwd",
            runtimeMode: "full-access",
          });
        }).pipe(Effect.provide(firstProviderLayer));

        const secondClaude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
        const secondRegistry = makeAdapterRegistryMock({
          [ProviderDriverKind.make("claudeAgent")]: secondClaude.adapter,
        });
        const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
          Layer.provide(runtimeRepositoryLayer),
        );
        const secondProviderLayer = makeProviderServiceLive().pipe(
          Layer.provide(
            Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, secondRegistry),
          ),
          Layer.provide(secondDirectoryLayer),
          Layer.provide(defaultServerSettingsLayer),
          Layer.provide(WorkspaceLeaseTestLive),
          Layer.provide(AnalyticsService.layerTest),
          Layer.provide(
            Layer.succeed(
              ProviderEventLoggers.ProviderEventLoggers,
              ProviderEventLoggers.NoOpProviderEventLoggers,
            ),
          ),
        );

        secondClaude.startSession.mockClear();

        yield* Effect.gen(function* () {
          const provider = yield* ProviderService.ProviderService;
          yield* provider.startSession(initial.threadId, {
            provider: ProviderDriverKind.make("claudeAgent"),
            providerInstanceId: claudeAgentInstanceId,
            threadId: initial.threadId,
            runtimeMode: "full-access",
          });
        }).pipe(Effect.provide(secondProviderLayer));

        assert.equal(secondClaude.startSession.mock.calls.length, 1);
        const resumedStartInput = secondClaude.startSession.mock.calls[0]?.[0];
        assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
        if (resumedStartInput && typeof resumedStartInput === "object") {
          const startPayload = resumedStartInput as {
            provider?: string;
            cwd?: string;
            resumeCursor?: unknown;
            threadId?: string;
          };
          assert.equal(startPayload.provider, "claudeAgent");
          assert.equal(startPayload.cwd, "/tmp/project-claude-cwd");
          assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
          assert.equal(startPayload.threadId, initial.threadId);
        }

        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

const fanout = makeProviderServiceLayer();
fanout.layer("ProviderServiceLive fanout", (it) => {
  it.effect("fans out adapter turn completion events", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });

      const eventsRef = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.runForEach(provider.streamEvents, (event) =>
        Ref.update(eventsRef, (current) => [...current, event]),
      ).pipe(Effect.forkChild);
      yield* advanceTestClock(50);

      const completedEvent: LegacyProviderRuntimeEvent = {
        type: "turn.completed",
        eventId: asEventId("evt-1"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        status: "completed",
      };

      fanout.codex.emit(completedEvent);
      yield* advanceTestClock(50);

      const events = yield* Ref.get(eventsRef);
      yield* Fiber.interrupt(consumer);

      assert.equal(
        events.some((entry) => entry.type === "turn.completed"),
        true,
      );
      assert.equal(
        events.some(
          (entry) =>
            entry.type === "turn.completed" && entry.providerInstanceId === codexInstanceId,
        ),
        true,
      );
    }),
  );

  it.effect("fans out canonical runtime events in emission order", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-seq"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-seq"),
        runtimeMode: "full-access",
      });

      const receivedRef = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.take(provider.streamEvents, 3).pipe(
        Stream.runForEach((event) => Ref.update(receivedRef, (current) => [...current, event])),
        Effect.forkChild,
      );
      yield* advanceTestClock(50);

      fanout.codex.emit({
        type: "tool.started",
        eventId: asEventId("evt-seq-1"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        toolKind: "command",
        title: "Ran command",
      });
      fanout.codex.emit({
        type: "tool.completed",
        eventId: asEventId("evt-seq-2"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        toolKind: "command",
        title: "Ran command",
      });
      fanout.codex.emit({
        type: "turn.completed",
        eventId: asEventId("evt-seq-3"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        status: "completed",
      });

      yield* Fiber.join(consumer);
      const received = yield* Ref.get(receivedRef);
      assert.deepEqual(
        received.map((event) => event.eventId),
        [asEventId("evt-seq-1"), asEventId("evt-seq-2"), asEventId("evt-seq-3")],
      );
    }),
  );

  it.effect("keeps subscriber delivery ordered and isolates failing subscribers", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });

      const receivedByHealthy: string[] = [];
      const expectedEventIds = new Set<string>(["evt-ordered-1", "evt-ordered-2", "evt-ordered-3"]);
      const healthyFiber = yield* Stream.take(provider.streamEvents, 3).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            receivedByHealthy.push(event.eventId);
          }),
        ),
        Effect.forkChild,
      );
      const failingFiber = yield* Stream.take(provider.streamEvents, 1).pipe(
        Stream.runForEach(() => Effect.fail("listener crash")),
        Effect.forkChild,
      );
      yield* advanceTestClock(50);

      const events: ReadonlyArray<LegacyProviderRuntimeEvent> = [
        {
          type: "tool.completed",
          eventId: asEventId("evt-ordered-1"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.000Z",
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          toolKind: "command",
          title: "Ran command",
          detail: "echo one",
        },
        {
          type: "message.delta",
          eventId: asEventId("evt-ordered-2"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.000Z",
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          delta: "hello",
        },
        {
          type: "turn.completed",
          eventId: asEventId("evt-ordered-3"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.000Z",
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          status: "completed",
        },
      ];

      for (const event of events) {
        fanout.codex.emit(event);
      }
      const failingResult = yield* Effect.result(Fiber.join(failingFiber));
      assert.equal(failingResult._tag, "Failure");
      yield* Fiber.join(healthyFiber);

      assert.deepEqual(
        receivedByHealthy.filter((eventId) => expectedEventIds.has(eventId)).slice(0, 3),
        ["evt-ordered-1", "evt-ordered-2", "evt-ordered-3"],
      );
    }),
  );

  it.effect("records provider metrics with the routed provider label", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-metrics"), {
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        threadId: asThreadId("thread-metrics"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      yield* provider.interruptTurn({ threadId: session.threadId });
      yield* provider.respondToRequest({
        threadId: session.threadId,
        requestId: asRequestId("req-metrics-1"),
        decision: "accept",
      });
      yield* provider.respondToUserInput({
        threadId: session.threadId,
        requestId: asRequestId("req-metrics-2"),
        answers: {
          sandbox_mode: "workspace-write",
        },
      });
      yield* provider.rollbackConversation({
        threadId: session.threadId,
        numTurns: 1,
      });
      yield* provider.stopSession({ threadId: session.threadId });

      const snapshots = yield* Metric.snapshot;

      assert.equal(
        hasMetricSnapshot(snapshots, "t3_provider_turns_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "interrupt",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_provider_turns_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "approval-response",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_provider_turns_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "user-input-response",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_provider_turns_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "rollback",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_provider_sessions_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "stop",
          outcome: "success",
        }),
        true,
      );
    }),
  );

  it.effect(
    "records sendTurn metrics with the resolved provider when modelSelection is omitted",
    () =>
      Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;

        const session = yield* provider.startSession(asThreadId("thread-send-metrics"), {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId("thread-send-metrics"),
          cwd: "/tmp/project-send-metrics",
          runtimeMode: "full-access",
        });

        yield* provider.sendTurn({
          threadId: session.threadId,
          input: "hello",
          attachments: [],
        });

        const snapshots = yield* Metric.snapshot;

        assert.equal(
          hasMetricSnapshot(snapshots, "t3_provider_turns_total", {
            provider: ProviderDriverKind.make("claudeAgent"),
            operation: "send",
            outcome: "success",
          }),
          true,
        );
        assert.equal(
          hasMetricSnapshot(snapshots, "t3_provider_turn_duration", {
            provider: ProviderDriverKind.make("claudeAgent"),
            operation: "send",
          }),
          true,
        );
      }),
  );
});

const validation = makeProviderServiceLayer();
validation.layer("ProviderServiceLive validation", (it) => {
  it.effect("rejects session starts without an explicit provider instance id", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      validation.codex.startSession.mockClear();
      const failure = yield* Effect.flip(
        provider.startSession(asThreadId("thread-missing-instance-id"), {
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-missing-instance-id"),
          runtimeMode: "full-access",
        }),
      );

      assert.instanceOf(failure, ProviderValidationError);
      assert.include(failure.issue, "Provider instance id is required for provider 'codex'.");
      assert.equal(validation.codex.startSession.mock.calls.length, 0);
    }),
  );

  it.effect("rejects mismatched provider kind and provider instance id", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      validation.codex.startSession.mockClear();
      validation.claude.startSession.mockClear();
      const failure = yield* Effect.flip(
        provider.startSession(asThreadId("thread-instance-mismatch"), {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId("thread-instance-mismatch"),
          runtimeMode: "full-access",
        }),
      );

      assert.instanceOf(failure, ProviderValidationError);
      assert.include(
        failure.issue,
        "Provider instance 'claudeAgent' belongs to driver 'claudeAgent', not 'codex'.",
      );
      assert.equal(validation.codex.startSession.mock.calls.length, 0);
      assert.equal(validation.claude.startSession.mock.calls.length, 0);
    }),
  );

  it.effect("returns ProviderValidationError for invalid input payloads", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      const failure = yield* Effect.result(
        provider.startSession(asThreadId("thread-validation"), {
          threadId: asThreadId("thread-validation"),
          provider: "invalid-provider",
          runtimeMode: "full-access",
        } as never),
      );

      assert.equal(failure._tag, "Failure");
      if (failure._tag !== "Failure") {
        return;
      }
      assert.equal(failure.failure._tag, "ProviderValidationError");
      if (failure.failure._tag !== "ProviderValidationError") {
        return;
      }
      assert.equal(failure.failure.operation, "ProviderService.startSession");
      assert.equal(failure.failure.issue.includes("invalid-provider"), true);
    }),
  );

  it.effect("accepts startSession when adapter has not emitted provider thread id yet", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

      validation.codex.startSession.mockImplementationOnce((input: ProviderSessionStartInput) =>
        Effect.sync(() => {
          const now = "2026-01-01T00:00:00.000Z";
          return {
            provider: ProviderDriverKind.make("codex"),
            status: "ready",
            threadId: input.threadId,
            runtimeMode: input.runtimeMode,
            cwd: input.cwd ?? process.cwd(),
            createdAt: now,
            updatedAt: now,
          } satisfies ProviderSession;
        }),
      );

      const session = yield* provider.startSession(asThreadId("thread-missing"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-missing"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      assert.equal(session.threadId, asThreadId("thread-missing"));

      const runtime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.threadId, session.threadId);
      }
    }),
  );
});

// Capability: occupancy outlives projection staleness (plan §7.4, test 6).
//
// The bug: when a provider process dies, the driver removes its in-memory entry
// and emits `session.exited`, but nothing persisted the stop — ten
// `provider_session_runtime` rows were observed reading `running` against zero
// live pi processes. Occupancy built on those rows would have traded a
// destructive race for a permanent worktree leak, so the exit must release the
// lease AND reconcile the row, in the same breath.
it.effect("a process death without clean shutdown releases the lease and reconciles the row", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const registry = makeAdapterRegistryMock({
      [ProviderDriverKind.make("codex")]: codex.adapter,
    });
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const lease = yield* makeWorkspaceLease;
    const workspace = NodePath.join(NodeOS.tmpdir(), "t3-lease-workspace");
    // One persistence instance shared by the service and the row assertion:
    // `SqlitePersistenceMemory` builds a fresh database per layer construction.
    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
      Layer.provideMerge(Layer.mergeAll(directoryLayer, runtimeRepositoryLayer)),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(Layer.succeed(WorkspaceLease, lease)),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    const threadId = asThreadId("thread-lease-death");
    const resolvedWorkspace = NodePath.resolve(workspace);

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      // Let the adapter event subscription attach before anything is emitted.
      yield* advanceTestClock(10);
      yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: workspace,
        runtimeMode: "full-access",
      });

      // The session start took the hold, so no remover can delete this tree.
      assert.equal((yield* lease.occupiedPaths).has(resolvedWorkspace), true);
      assert.equal(Option.isNone(yield* lease.withExclusive(workspace, Effect.void)), true);

      // The process dies. No stopSession, no clean shutdown — just the exit
      // event the driver emits from its process `exit` handler (which, as in
      // every real driver, has already dropped the live session entry).
      codex.emitSessionExited({
        eventId: asEventId("evt-lease-death"),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        createdAt: "2026-01-01T00:00:00.000Z",
        type: "session.exited",
        payload: { reason: "Pi RPC process exited.", recoverable: false, exitKind: "error" },
      });
      yield* advanceTestClock(20);

      // Lease released: the workspace is collectable again, so a crash cannot
      // make a worktree immortal.
      assert.equal((yield* lease.occupiedPaths).has(resolvedWorkspace), false);
      assert.equal(Option.isSome(yield* lease.withExclusive(workspace, Effect.void)), true);

      // Row reconciled at death, not merely at the next startup sweep.
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const runtime = yield* repository.getByThreadId({ threadId });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.status, "stopped");
      }
    }).pipe(Effect.provide(providerLayer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

// Round-1 review finding 2: a stale exit event for a SUPERSEDED launch must not
// release the live launch's hold. `PiDriver` guards exactly this with
// `replacedProcesses` (a swapped-out process's exit must not tear down its
// replacement); the lease needs the same launch-scoped identity, because a
// restart on model/instance/runtime-mode change re-launches into the SAME cwd
// (`ProviderCommandReactor` restarts without requiring `cwdChanged`).
it.effect("a superseded launch's exit event does not release the live launch's hold", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const registry = makeAdapterRegistryMock({
      [ProviderDriverKind.make("codex")]: codex.adapter,
    });
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const lease = yield* makeWorkspaceLease;
    const workspace = NodePath.join(NodeOS.tmpdir(), "t3-lease-superseded");
    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
      Layer.provideMerge(Layer.mergeAll(directoryLayer, runtimeRepositoryLayer)),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(Layer.succeed(WorkspaceLease, lease)),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    const threadId = asThreadId("thread-lease-superseded");

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      yield* advanceTestClock(10);

      const start = () =>
        provider.startSession(threadId, {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          threadId,
          cwd: workspace,
          runtimeMode: "full-access",
        });

      // Launch 1, then a restart into the SAME cwd — launch 2 is now the live
      // process holding this workspace.
      yield* start();
      yield* start();

      // Launch 1's process finally dies; its exit event lands late.
      codex.emitSessionExited({
        eventId: asEventId("evt-superseded-exit"),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        createdAt: "2026-01-01T00:00:00.000Z",
        type: "session.exited",
        payload: { reason: "superseded process exited.", recoverable: false, exitKind: "error" },
      });
      yield* advanceTestClock(20);

      // Launch 2 is still live, so the workspace must stay protected.
      assert.equal(
        Option.isNone(yield* lease.withExclusive(workspace, Effect.void)),
        true,
        "a superseded launch's exit released the live launch's hold",
      );

      // Absorbing the predecessor's exit must not make the live launch's hold
      // un-releasable: when launch 2 itself dies, the workspace is collectable.
      // (Otherwise finding 2's fix would trade a deletion race for a leak.)
      codex.emitSessionExited({
        eventId: asEventId("evt-live-exit"),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        createdAt: "2026-01-01T00:00:01.000Z",
        type: "session.exited",
        payload: { reason: "live process exited.", recoverable: false, exitKind: "error" },
      });
      yield* advanceTestClock(20);
      assert.equal(
        Option.isSome(yield* lease.withExclusive(workspace, Effect.void)),
        true,
        "the live launch's own exit failed to release its hold",
      );
    }).pipe(Effect.provide(providerLayer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

// Round-2 review (residual of finding 2): an explicit stop ALSO produces an
// asynchronous `session.exited` — PiDriver's `stopSession` does not add the
// process to `replacedProcesses`, so its `child.once("exit")` handler emits
// (`PiDriver.ts:2424-2438` → `:1846-1876`), and `OpenCodeAdapter.stopSession`
// emits directly (`:1682-1690`). So a stop supersedes its launch exactly as a
// restart does, and must record the same absorption debt: otherwise a
// stop→restart→late-exit ordering releases the LIVE launch's hold.
it.effect("a stopped launch's late exit does not release the next launch's hold", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const registry = makeAdapterRegistryMock({
      [ProviderDriverKind.make("codex")]: codex.adapter,
    });
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const lease = yield* makeWorkspaceLease;
    const workspace = NodePath.join(NodeOS.tmpdir(), "t3-lease-stop-restart");
    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
      Layer.provideMerge(Layer.mergeAll(directoryLayer, runtimeRepositoryLayer)),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(Layer.succeed(WorkspaceLease, lease)),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    const threadId = asThreadId("thread-lease-stop-restart");
    const exited = (eventId: string, at: string) =>
      codex.emitSessionExited({
        eventId: asEventId(eventId),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        createdAt: at,
        type: "session.exited",
        payload: { reason: "process exited.", recoverable: false, exitKind: "graceful" },
      });

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      yield* advanceTestClock(10);

      const start = () =>
        provider.startSession(threadId, {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          threadId,
          cwd: workspace,
          runtimeMode: "full-access",
        });

      // 1. Launch 1 holds the workspace.
      yield* start();
      // 2. The human stops the thread. The adapter's exit event is NOT delivered
      //    yet — that is the whole point of the ordering.
      yield* provider.stopSession({ threadId });
      // 3. The human sends a new message: launch 2 spawns into the same cwd.
      yield* start();
      // 4. Launch 1's exit finally lands.
      exited("evt-stopped-late-exit", "2026-01-01T00:00:00.000Z");
      yield* advanceTestClock(20);

      // Launch 2's pi process is live, so the workspace must stay protected.
      assert.equal(
        Option.isNone(yield* lease.withExclusive(workspace, Effect.void)),
        true,
        "a stopped launch's late exit released the live launch's hold",
      );

      // And the debt must not outlive its purpose: launch 2's own exit still
      // releases, or the fix trades a deletion race for a permanent leak.
      exited("evt-live-exit-after-stop", "2026-01-01T00:00:01.000Z");
      yield* advanceTestClock(20);
      assert.equal(
        Option.isSome(yield* lease.withExclusive(workspace, Effect.void)),
        true,
        "the live launch's own exit failed to release its hold",
      );
    }).pipe(Effect.provide(providerLayer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

// The failure mode the stop-path debt could introduce: a debt that outlives its
// purpose would absorb a LATER real exit and immortalise the workspace. Guards
// the stop→exit→start→exit ordering, i.e. the stop's exit arrives (spending the
// debt) before the next launch, whose own exit must then still release.
it.effect("a stop's absorption debt does not survive to swallow a later launch's exit", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const registry = makeAdapterRegistryMock({
      [ProviderDriverKind.make("codex")]: codex.adapter,
    });
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const lease = yield* makeWorkspaceLease;
    const workspace = NodePath.join(NodeOS.tmpdir(), "t3-lease-stop-exit-start");
    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
      Layer.provideMerge(Layer.mergeAll(directoryLayer, runtimeRepositoryLayer)),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(Layer.succeed(WorkspaceLease, lease)),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    const threadId = asThreadId("thread-lease-stop-exit-start");
    const exited = (eventId: string, at: string) =>
      codex.emitSessionExited({
        eventId: asEventId(eventId),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        createdAt: at,
        type: "session.exited",
        payload: { reason: "process exited.", recoverable: false, exitKind: "graceful" },
      });

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      yield* advanceTestClock(10);

      const start = () =>
        provider.startSession(threadId, {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          threadId,
          cwd: workspace,
          runtimeMode: "full-access",
        });

      yield* start();
      yield* provider.stopSession({ threadId });
      // The stopped launch's exit lands BEFORE any new launch, spending the debt.
      exited("evt-stop-exit-first", "2026-01-01T00:00:00.000Z");
      yield* advanceTestClock(20);
      // Nothing is live, so the workspace is collectable.
      assert.equal(Option.isSome(yield* lease.withExclusive(workspace, Effect.void)), true);

      // A fresh launch now holds it, and its own exit must still release: a
      // stale debt here would leave the workspace permanently un-removable.
      yield* start();
      assert.equal(Option.isNone(yield* lease.withExclusive(workspace, Effect.void)), true);
      exited("evt-fresh-launch-exit", "2026-01-01T00:00:02.000Z");
      yield* advanceTestClock(20);
      assert.equal(
        Option.isSome(yield* lease.withExclusive(workspace, Effect.void)),
        true,
        "a stale absorption debt swallowed the live launch's exit (immortal workspace)",
      );
    }).pipe(Effect.provide(providerLayer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

// ---------------------------------------------------------------------------
// The invariant, asserted directly rather than inferred from whether a removal
// happens to be refused: AT MOST ONE live hold per thread at any time, and ZERO
// once the thread has no live process.
//
// Every defect found across review rounds 0-2 was a violation of one half of
// this: a permit leak, a superseded launch's exit releasing the live launch's
// hold, and a debt that swallowed a real exit (leaving a hold forever). Rather
// than one regression test per ordering discovered, this drives every ordering
// now known and checks the invariant after each step, so a future ordering that
// breaks it fails here even if nobody thought to write its scenario.
// ---------------------------------------------------------------------------
it.effect("holds obey at-most-one-live-per-thread across every launch ordering", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const registry = makeAdapterRegistryMock({
      [ProviderDriverKind.make("codex")]: codex.adapter,
    });
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const lease = yield* makeWorkspaceLease;
    const workspace = NodePath.join(NodeOS.tmpdir(), "t3-lease-invariant");
    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
      Layer.provideMerge(Layer.mergeAll(directoryLayer, runtimeRepositoryLayer)),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(Layer.succeed(WorkspaceLease, lease)),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    const threadId = asThreadId("thread-lease-invariant");

    // Liveness is tracked by the test rather than read from the fake adapter: the
    // fake keeps ONE session slot per thread, so a predecessor's exit clears the
    // slot even when a successor launch is genuinely live (a real driver's
    // `startSession` re-registers the successor). `expectLive` is the test's own
    // model of "is a process running for this thread", which is what the second
    // half of the invariant is about.
    const assertInvariant = (label: string, expectLive: boolean) =>
      Effect.gen(function* () {
        const holders = yield* lease.holdersOf(workspace);
        assert.isAtMost(holders.length, 1, `${label}: more than one live hold (${holders.length})`);
        if (!expectLive) {
          assert.equal(holders.length, 0, `${label}: hold leaked with no live process`);
        } else {
          assert.equal(holders.length, 1, `${label}: live process is not protected by a hold`);
        }
      });

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      yield* advanceTestClock(10);

      const start = () =>
        provider.startSession(threadId, {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          threadId,
          cwd: workspace,
          runtimeMode: "full-access",
        });
      const exit = (id: string) =>
        codex.emitSessionExited({
          eventId: asEventId(id),
          provider: ProviderDriverKind.make("codex"),
          threadId,
          createdAt: "2026-01-01T00:00:00.000Z",
          type: "session.exited",
          payload: { reason: "exited.", recoverable: false, exitKind: "graceful" },
        });

      yield* assertInvariant("initial", false);

      // 1. plain start, then death.
      yield* start();
      yield* assertInvariant("after start", true);
      exit("inv-1");
      yield* advanceTestClock(20);
      yield* assertInvariant("after death", false);

      // 2. restart into the same cwd (launch superseded while live), then the
      //    predecessor's late exit, then the live launch's own exit.
      yield* start();
      yield* start();
      yield* assertInvariant("after restart", true);
      exit("inv-2-late");
      yield* advanceTestClock(20);
      yield* assertInvariant("after superseded late exit", true);
      // The live launch's own exit now releases (one launch, one exit owed).
      exit("inv-2-live");
      yield* advanceTestClock(20);
      yield* assertInvariant("after live exit", false);

      // 3. stop that DOES emit an exit, with a restart in between.
      yield* start();
      yield* provider.stopSession({ threadId });
      yield* assertInvariant("after stop", false);
      yield* start();
      exit("inv-3-late");
      yield* advanceTestClock(20);
      yield* assertInvariant("after stopped launch's late exit", true);
      exit("inv-3-live");
      yield* advanceTestClock(20);
      yield* assertInvariant("after live exit post-stop", false);

      // 4. stop on a driver that DOES emit, restarted well within the straggler
      //    window: the stopped launch's exit is genuinely owed, so it must be
      //    absorbed rather than release the new launch's hold.
      yield* start();
      yield* provider.stopSession({ threadId });
      yield* start();
      yield* assertInvariant("after emitting stop + sub-window restart", true);
      exit("inv-4-straggler");
      yield* advanceTestClock(20);
      yield* assertInvariant("after stopped launch's straggler", true);
      exit("inv-4-live");
      yield* advanceTestClock(20);
      yield* assertInvariant("after live exit", false);

      // 5. runStopAll (shutdown finalizer) leaves nothing held.
      yield* start();
      yield* provider.stopSession({ threadId });
      yield* assertInvariant("after final stop", false);
    }).pipe(Effect.provide(providerLayer));

    // Scope closed ⇒ the stopAll finalizer has run; nothing may remain held.
    assert.deepEqual(yield* lease.holdersOf(workspace), []);
  }).pipe(Effect.provide(NodeServices.layer)),
);

// MUST-FIX 1 (round-2 review): a start can fail AFTER spawning a process, and that
// process still emits `session.exited` — `PiDriver.ts:2159-2162` stops it when
// `applyModelSelection` fails, which routes through the exit handler
// (`:1850-1876`). The failed launch must therefore leave an attribution token, or
// its straggler exit releases the RETRY's hold and exposes a live process.
//
// Isolated fixture on purpose: in a longer sequence an earlier token can already
// have lapsed, leaving `endedLaunches` empty and making the assertion pass whether
// or not the failed start records a token.
it.effect("a failed start's straggler exit does not release the retry's hold", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const registry = makeAdapterRegistryMock({
      [ProviderDriverKind.make("codex")]: codex.adapter,
    });
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const lease = yield* makeWorkspaceLease;
    const workspace = NodePath.join(NodeOS.tmpdir(), "t3-lease-failed-start");
    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
      Layer.provideMerge(Layer.mergeAll(directoryLayer, runtimeRepositoryLayer)),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(Layer.succeed(WorkspaceLease, lease)),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    const threadId = asThreadId("thread-lease-failed-start");

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      yield* advanceTestClock(10);

      const start = () =>
        provider.startSession(threadId, {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          threadId,
          cwd: workspace,
          runtimeMode: "full-access",
        });

      // The launch spawns a process and then fails.
      codex.startSession.mockImplementationOnce(
        () =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: CODEX_DRIVER,
              method: "startSession",
              detail: "failed after spawn",
            }),
          ) as never,
      );
      const failed = yield* Effect.result(start());
      assert.equal(failed._tag, "Failure", "setup: the start did not fail");
      assert.deepEqual(yield* lease.holdersOf(workspace), [], "a failed start kept its hold");

      // The turn is retried and its process is now live in the same workspace.
      yield* start();
      const retryHolders = yield* lease.holdersOf(workspace);
      assert.equal(retryHolders.length, 1);

      // The failed launch's process now emits, INSIDE the straggler window. It must
      // not disturb the retry's hold.
      codex.emitSessionExited({
        eventId: asEventId("evt-failed-start-straggler"),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        createdAt: "2026-01-01T00:00:00.000Z",
        type: "session.exited",
        payload: { reason: "failed launch exited.", recoverable: false, exitKind: "error" },
      });
      yield* advanceTestClock(20);
      assert.deepEqual(
        yield* lease.holdersOf(workspace),
        retryHolders,
        "a failed start's straggler exit released the retry's hold",
      );
    }).pipe(Effect.provide(providerLayer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

// Round-3 review finding (MF2, the ordering that was still broken): a driver whose
// `stopSession` emits NOTHING (`CodexAdapter`) leaves no exit owed, so a stop must
// record no attribution token. If it does record one, the next launch's GENUINE
// exit is absorbed by that stale token and the hold is leaked permanently — the
// workspace can never be reaped, and there is no backstop for that direction.
//
// The restart happens 2s after the stop: deliberately INSIDE the straggler window,
// because that is the ordinary interaction (stop a thread, send a new message
// seconds later) and the previous design was correct only after the window lapsed.
it.effect("a silent-stop driver leaks no hold when restarted within the window", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter(CODEX_DRIVER, { emitsExitOnStop: false });
    const registry = makeAdapterRegistryMock({
      [ProviderDriverKind.make("codex")]: codex.adapter,
    });
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const lease = yield* makeWorkspaceLease;
    const workspace = NodePath.join(NodeOS.tmpdir(), "t3-lease-silent-subwindow");
    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
      Layer.provideMerge(Layer.mergeAll(directoryLayer, runtimeRepositoryLayer)),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(Layer.succeed(WorkspaceLease, lease)),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    const threadId = asThreadId("thread-lease-silent-subwindow");

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      yield* advanceTestClock(10);

      const start = () =>
        provider.startSession(threadId, {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          threadId,
          cwd: workspace,
          runtimeMode: "full-access",
        });

      yield* start();
      // Silent stop: the adapter tears the session down without emitting.
      yield* provider.stopSession({ threadId });
      // The user sends a new message seconds later — well inside the window.
      yield* advanceTestClock(2_000);
      yield* start();
      assert.equal((yield* lease.holdersOf(workspace)).length, 1, "the retry holds the workspace");

      // This launch genuinely dies. Its exit must release the hold, not be eaten.
      codex.emitSessionExited({
        eventId: asEventId("evt-silent-subwindow"),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        createdAt: "2026-01-01T00:00:00.000Z",
        type: "session.exited",
        payload: { reason: "process exited.", recoverable: false, exitKind: "error" },
      });
      yield* advanceTestClock(20);
      assert.deepEqual(
        yield* lease.holdersOf(workspace),
        [],
        "the live launch's exit was absorbed by a stale token — hold leaked",
      );

      // And the leak is not merely deferred: ten minutes on, still released.
      yield* advanceTestClock(10 * 60_000);
      assert.deepEqual(yield* lease.holdersOf(workspace), []);
    }).pipe(Effect.provide(providerLayer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

// The reviewer's round-2 MF2 scenario, verbatim in shape and timing: silent stop,
// restart at the default 20ms event spacing (no clock advance between stop and
// start), then the live launch genuinely dies. This is the repro that still failed
// after round 3 — it passed only when a >30s wait was inserted, i.e. only when the
// straggler window had lapsed. It must now pass with no wait at all.
it.effect("MF2 repro: silent stop then immediate restart, live exit still releases", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter(CODEX_DRIVER, { emitsExitOnStop: false });
    const registry = makeAdapterRegistryMock({
      [ProviderDriverKind.make("codex")]: codex.adapter,
    });
    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const lease = yield* makeWorkspaceLease;
    const workspace = NodePath.join(NodeOS.tmpdir(), "t3-lease-mf2-repro");
    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
      Layer.provideMerge(Layer.mergeAll(directoryLayer, runtimeRepositoryLayer)),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(Layer.succeed(WorkspaceLease, lease)),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    const threadId = asThreadId("thread-lease-mf2-repro");

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      yield* advanceTestClock(10);

      const start = () =>
        provider.startSession(threadId, {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          threadId,
          cwd: workspace,
          runtimeMode: "full-access",
        });

      yield* start();
      yield* provider.stopSession({ threadId });
      yield* start();
      codex.emitSessionExited({
        eventId: asEventId("evt-mf2-repro"),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        createdAt: "2026-01-01T00:00:00.000Z",
        type: "session.exited",
        payload: { reason: "process exited.", recoverable: false, exitKind: "error" },
      });
      yield* advanceTestClock(20);

      assert.deepEqual(
        yield* lease.holdersOf(workspace),
        [],
        "MF2: the live launch's exit was absorbed by the silent stop's stale token",
      );
      assert.equal(Option.isSome(yield* lease.withExclusive(workspace, Effect.void)), true);
    }).pipe(Effect.provide(providerLayer));
  }).pipe(Effect.provide(NodeServices.layer)),
);
