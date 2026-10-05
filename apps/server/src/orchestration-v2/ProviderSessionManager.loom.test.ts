// loom: the open-session composer hook (driver plan §4, DR-6/DR-7): ProviderSessionManager.open
// asks LoomSessionComposer for the thread's fields before the MCP credential exists, hands them
// to the adapter as `loom`, and maps a composer failure to ProviderSessionOpenError.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { HttpServer } from "effect/unstable/http";
import * as NetAddress from "effect/unstable/net/NetAddress";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  EMPTY_LOOM_OPEN_SESSION_FIELDS,
  LoomSessionComposer,
  LoomSessionComposerError,
  type LoomOpenSessionFields,
} from "../loom/prompt/sessionComposer.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type {
  ProviderAdapterV2OpenSessionInput,
  ProviderAdapterV2SessionRuntime,
  ProviderAdapterV2Shape,
} from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" };
const runtimePolicy = {
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: process.cwd(),
} as const;

const stores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provide(SqlitePersistenceMemory),
);
const eventSink = EventSink.layer.pipe(
  Layer.provide(Layer.mergeAll(stores, SqlitePersistenceMemory)),
);
const mcpRegistry = Layer.effect(
  McpSessionRegistry.McpSessionRegistry,
  McpSessionRegistry.__testing.make(),
).pipe(
  Layer.provide(
    Layer.succeed(
      HttpServer.HttpServer,
      HttpServer.HttpServer.of({
        address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43124),
        serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
      }),
    ),
  ),
  Layer.provide(
    Layer.succeed(
      ServerEnvironment.ServerEnvironment,
      ServerEnvironment.ServerEnvironment.of({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-loom-composer")),
        getDescriptor: Effect.die("unused"),
      }),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

/** An adapter that records every open-session input it receives. */
const recordingAdapter = (opens: Ref.Ref<ReadonlyArray<ProviderAdapterV2OpenSessionInput>>) =>
  ({
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: (input) =>
      Effect.gen(function* () {
        yield* Ref.update(opens, (all) => [...all, input]);
        const now = yield* DateTime.now;
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd: process.cwd(),
            model: null,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.never,
        } as unknown as ProviderAdapterV2SessionRuntime;
      }),
  }) as ProviderAdapterV2Shape;

const openWith = (composer: Layer.Layer<never> | undefined) =>
  Effect.gen(function* () {
    const opens = yield* Ref.make<ReadonlyArray<ProviderAdapterV2OpenSessionInput>>([]);
    const registry = ProviderAdapterRegistry.makeSingleLayer(recordingAdapter(opens));
    const ingestor = ProviderEventIngestor.layer.pipe(
      Layer.provide(
        Layer.mergeAll(eventSink, IdAllocator.layer, stores, ThreadCommandExecutor.layer),
      ),
    );
    const manager = ProviderSessionManager.layerWithOptions({ idleTimeoutMs: 60_000 }).pipe(
      Layer.provide(
        Layer.mergeAll(
          registry,
          eventSink,
          IdAllocator.layer,
          ingestor,
          mcpRegistry,
          stores,
          ...(composer === undefined ? [] : [composer]),
        ),
      ),
    );
    const exit = yield* Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const ids = yield* IdAllocator.IdAllocatorV2;
      const threadId = ThreadId.make("thread-loom-composer");
      const now = yield* DateTime.now;
      const thread: OrchestrationV2AppThread = {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: yield* ids.allocate.project({ fixtureName: "loom-composer" }),
        title: "Composer",
        providerInstanceId: instanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      yield* sink.write({
        events: [
          {
            id: yield* ids.allocate.event({ threadId }),
            type: "thread.created",
            threadId,
            occurredAt: now,
            payload: thread,
          },
        ],
      });
      return yield* (yield* ProviderSessionManager.ProviderSessionManagerV2).open({
        threadId,
        providerSessionId: yield* ids.allocate.providerSession({
          providerInstanceId: instanceId,
          threadId,
        }),
        modelSelection,
        runtimePolicy,
      });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(manager, eventSink, IdAllocator.layer).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
      Effect.exit,
    );
    return { exit, opens: yield* Ref.get(opens) };
  }).pipe(Effect.scoped);

it.effect("opens with the empty default composer when none is provided", () =>
  Effect.gen(function* () {
    const { exit, opens } = yield* openWith(undefined);
    assert.isTrue(Exit.isSuccess(exit));
    assert.deepEqual(opens[0]?.loom, EMPTY_LOOM_OPEN_SESSION_FIELDS);
  }),
);

it.effect("hands a provided composer's fields to the adapter", () =>
  Effect.gen(function* () {
    const fields: LoomOpenSessionFields = {
      appendSystemPrompt: "role overlay",
      skills: ["/s/SKILL.md"],
      extensions: ["/e/loom.ts"],
    };
    const { opens } = yield* openWith(
      Layer.succeed(LoomSessionComposer, { compose: () => Effect.succeed(fields) }),
    );
    assert.deepEqual(opens[0]?.loom, fields);
  }),
);

it.effect("fails the open, before the adapter runs, when composition fails", () =>
  Effect.gen(function* () {
    const { exit, opens } = yield* openWith(
      Layer.succeed(LoomSessionComposer, {
        compose: (threadId) =>
          Effect.fail(new LoomSessionComposerError({ threadId, cause: "overlay unreadable" })),
      }),
    );
    assert.isTrue(Exit.isFailure(exit));
    const error = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined;
    assert.equal(error?._tag, "Fail");
    const failure = error?._tag === "Fail" ? error.error : undefined;
    assert.instanceOf(failure, ProviderSessionManager.ProviderSessionOpenError);
    assert.instanceOf(
      (failure as ProviderSessionManager.ProviderSessionOpenError).cause,
      LoomSessionComposerError,
    );
    assert.lengthOf(opens, 0);
  }),
);
