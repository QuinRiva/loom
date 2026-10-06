/**
 * The Loom substrate's test layer (plans/upstream-pull9-phase2-substrate/plan.mdx
 * §7): V2's real orchestrator, event sink, SQL projection (with the Loom fold)
 * and receipts over `SqlitePersistence.layerMemory` — which runs every migration, so
 * the `loom_*` tables exist — with a stub provider adapter whose `openSession`
 * opens an inert session (nothing runs; an interrupt is accepted) only when a
 * test asks for one (`seedRunningRun({ live: true })`). Nothing mocks the
 * engine; a "running" thread is seeded through the real `EventSinkV2`.
 *
 * Usage: `it.layer(LoomOrchestratorTestLayer)("…", (it) => …)`, then the
 * helpers below inside `it.effect`.
 *
 * @module loom/testkit/loomOrchestratorLayer
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  type LoomDomainEvent,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type WorkstreamRoute,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../../config.ts";
import * as McpSessionRegistryTestkit from "../../mcp/McpSessionRegistry.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "../../orchestration-v2/ProviderAdapter.ts";
import { ProviderSessionManagerV2 } from "../../orchestration-v2/ProviderSessionManager.ts";
import * as ProviderTurnStartServiceTestkit from "../../orchestration-v2/ProviderTurnStartService.testkit.ts";
import * as CommandReceiptStore from "../../orchestration-v2/CommandReceiptStore.ts";
import * as RuntimeLayer from "../../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import type { ProviderInstance } from "../../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as SourceControlProviderRegistry from "../../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as LoomStore from "../projection/LoomStore.ts";

export const testDriver = ProviderDriverKind.make("codex");
export const testModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const PlatformTestLayer = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);
const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-loom-substrate-" });
const CheckpointStoreTestLayer = CheckpointStore.layer.pipe(
  Layer.provide(VcsDriverRegistry.layer),
  Layer.provide(VcsProcess.layer),
  Layer.provide(ServerConfigLayer),
  Layer.provide(PlatformTestLayer),
);

const orchestrationAdapter = {
  instanceId: testModelSelection.instanceId,
  driver: testDriver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  // An inert live session: tests that need upstream's real interrupt path open one; nothing runs.
  openSession: (input) =>
    Effect.map(DateTime.now, (now) => ({
      instanceId: testModelSelection.instanceId,
      driver: testDriver,
      providerSessionId: input.providerSessionId,
      providerSession: {
        id: input.providerSessionId,
        driver: testDriver,
        providerInstanceId: testModelSelection.instanceId,
        status: "ready" as const,
        cwd: "/workspace/loom-test",
        model: testModelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
      events: Stream.never,
      ensureThread: () => Effect.die("inert Loom test session"),
      resumeThread: () => Effect.die("inert Loom test session"),
      startTurn: () => Effect.die("inert Loom test session"),
      steerTurn: () => Effect.die("inert Loom test session"),
      interruptTurn: () => Effect.void,
      respondToRuntimeRequest: () => Effect.die("inert Loom test session"),
      readThreadSnapshot: () => Effect.die("inert Loom test session"),
      rollbackThread: () => Effect.die("inert Loom test session"),
      forkThread: () => Effect.die("inert Loom test session"),
    })),
} as ProviderAdapterV2Shape;
const providerInstance = {
  instanceId: testModelSelection.instanceId,
  driverKind: testDriver,
  continuationIdentity: { driverKind: testDriver, continuationKey: "codex:loom-test" },
  displayName: "Codex (Loom test)",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

/** Orchestrator + event sink + project service + LoomStoreV2 + command receipts on one in-memory database. */
export const LoomOrchestratorTestLayer = Layer.mergeAll(
  RuntimeLayer.layer,
  RuntimeLayer.layerEventSink,
  LoomStore.layer,
  CommandReceiptStore.layerFromApplicationReceipts.pipe(
    Layer.provide(RuntimeLayer.layerEventInfrastructure),
  ),
).pipe(
  Layer.provideMerge(RuntimeLayer.layerProjectService),
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provide(ProviderTurnStartServiceTestkit.layer),
  Layer.provide(
    Layer.succeed(ProjectEnrichmentService.ProjectEnrichmentService, {
      peek: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      request: () => Effect.void,
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      invalidate: () => Effect.void,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(CheckpointStoreTestLayer),
  Layer.provide(ServerConfigLayer),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (instanceId) =>
        Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
      listInstances: Effect.succeed([providerInstance]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(PlatformTestLayer),
);

/** Creates the project (idempotently by id) and a root thread through the real services. */
export const seedThread = Effect.fn("loom.testkit.seedThread")(function* (input: {
  readonly threadId: ThreadId;
  readonly projectId?: ProjectId;
  readonly title?: string;
}) {
  const projectId = input.projectId ?? ProjectId.make("project:loom-test");
  const projects = yield* ProjectService.ProjectService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* projects.create({
    commandId: CommandId.make(`command:seed-project:${projectId}`),
    projectId,
    title: "Loom test project",
    workspaceRoot: `/workspace/${projectId}`,
  });
  yield* orchestrator.dispatch({
    type: "thread.create",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make(`command:seed-thread:${input.threadId}`),
    threadId: input.threadId,
    projectId,
    title: input.title ?? `Thread ${input.threadId}`,
    modelSelection: testModelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  });
  return { threadId: input.threadId, projectId };
});

/** Ids of the run `seedRunningRun` writes, derived from the thread and ordinal. */
export const seededRunIds = (threadId: ThreadId, ordinal = 1) => ({
  runId: RunId.make(`run:${threadId}:${ordinal}`),
  attemptId: RunAttemptId.make(`attempt:${threadId}:${ordinal}`),
  nodeId: NodeId.make(`node:${threadId}:${ordinal}`),
  providerThreadId: ProviderThreadId.make(`provider-thread:${threadId}`),
  providerTurnId: ProviderTurnId.make(`provider-turn:${threadId}:${ordinal}`),
  messageId: MessageId.make(`message:${threadId}:${ordinal}`),
});

/**
 * A running run (provider thread, run, attempt, root node, running provider turn
 * and its user message) written through the real `EventSinkV2.writeWithEffects`,
 * so the thread has a blocking run exactly as a live turn would leave it. With
 * `live`, the provider thread is bound to an open (inert) provider session, so
 * upstream's `run.interrupt` takes its real path and enqueues
 * `provider-turn.interrupt`; without it upstream refuses the interrupt.
 */
export const seedRunningRun = Effect.fn("loom.testkit.seedRunningRun")(function* (input: {
  readonly threadId: ThreadId;
  readonly ordinal?: number;
  readonly live?: boolean;
  /** The provider thread's driver (default the test driver; `pi` for the drafter guards). */
  readonly driver?: ProviderDriverKind;
}) {
  const sink = yield* EventSink.EventSinkV2;
  const driver = input.driver ?? testDriver;
  const now = yield* DateTime.now;
  const ordinal = input.ordinal ?? 1;
  const ids = seededRunIds(input.threadId, ordinal);
  const { threadId } = input;
  const providerSessionId = input.live
    ? ProviderSessionId.make(`provider-session:${threadId}`)
    : null;
  if (providerSessionId !== null) {
    yield* (yield* ProviderSessionManagerV2).open({
      threadId,
      providerSessionId,
      modelSelection: testModelSelection,
      runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
    });
  }
  const providerInstanceId = testModelSelection.instanceId;
  const base = { threadId, occurredAt: now };
  yield* sink.writeWithEffects({
    effects: [],
    events: [
      {
        ...base,
        id: EventId.make(`event:seed-provider-thread:${threadId}:${ordinal}`),
        type: "provider-thread.updated",
        payload: {
          id: ids.providerThreadId,
          driver,
          providerInstanceId,
          providerSessionId,
          appThreadId: threadId,
          ownerNodeId: null,
          nativeThreadRef: {
            driver,
            nativeId: `native:${threadId}`,
            strength: "strong",
          },
          nativeConversationHeadRef: null,
          status: "active",
          firstRunOrdinal: 1,
          lastRunOrdinal: ordinal,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      },
      {
        ...base,
        id: EventId.make(`event:seed-run:${threadId}:${ordinal}`),
        type: "run.created",
        runId: ids.runId,
        payload: {
          id: ids.runId,
          threadId,
          ordinal,
          providerInstanceId,
          modelSelection: testModelSelection,
          providerThreadId: ids.providerThreadId,
          userMessageId: ids.messageId,
          rootNodeId: ids.nodeId,
          activeAttemptId: ids.attemptId,
          status: "running",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      },
      {
        ...base,
        id: EventId.make(`event:seed-attempt:${threadId}:${ordinal}`),
        type: "run-attempt.created",
        runId: ids.runId,
        payload: {
          id: ids.attemptId,
          runId: ids.runId,
          attemptOrdinal: 1,
          rootNodeId: ids.nodeId,
          providerInstanceId,
          providerThreadId: ids.providerThreadId,
          providerTurnId: ids.providerTurnId,
          reason: "initial",
          status: "running",
          startedAt: now,
          completedAt: null,
        },
      },
      {
        ...base,
        id: EventId.make(`event:seed-node:${threadId}:${ordinal}`),
        type: "node.updated",
        runId: ids.runId,
        nodeId: ids.nodeId,
        payload: {
          id: ids.nodeId,
          threadId,
          runId: ids.runId,
          parentNodeId: null,
          rootNodeId: ids.nodeId,
          kind: "root_turn",
          status: "running",
          countsForRun: true,
          providerThreadId: ids.providerThreadId,
          providerTurnId: ids.providerTurnId,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: null,
        },
      },
      {
        ...base,
        id: EventId.make(`event:seed-turn:${threadId}:${ordinal}`),
        type: "provider-turn.updated",
        runId: ids.runId,
        nodeId: ids.nodeId,
        payload: {
          id: ids.providerTurnId,
          providerThreadId: ids.providerThreadId,
          nodeId: ids.nodeId,
          runAttemptId: ids.attemptId,
          nativeTurnRef: {
            driver: testDriver,
            nativeId: `native-turn:${threadId}:${ordinal}`,
            strength: "strong",
          },
          ordinal,
          status: "running",
          startedAt: now,
          completedAt: null,
        },
      },
      {
        ...base,
        id: EventId.make(`event:seed-message:${threadId}:${ordinal}`),
        type: "message.updated",
        runId: ids.runId,
        payload: {
          id: ids.messageId,
          threadId,
          runId: ids.runId,
          nodeId: ids.nodeId,
          role: "user",
          text: "Seeded running turn.",
          attachments: [],
          streaming: false,
          createdBy: "user",
          creationSource: "web",
          createdAt: now,
          updatedAt: now,
        },
      },
    ],
  });
  return ids;
});

/** Ends a run seeded by `seedRunningRun` (run and provider turn completed). */
export const completeSeededRun = Effect.fn("loom.testkit.completeSeededRun")(function* (input: {
  readonly threadId: ThreadId;
  readonly ordinal?: number;
}) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const ordinal = input.ordinal ?? 1;
  const ids = seededRunIds(input.threadId, ordinal);
  const projection = yield* orchestrator.getThreadProjection(input.threadId);
  const run = projection.runs.find((entry) => entry.id === ids.runId)!;
  const turn = projection.providerTurns.find((entry) => entry.id === ids.providerTurnId)!;
  yield* sink.writeWithEffects({
    effects: [],
    events: [
      {
        id: EventId.make(`event:seed-turn-completed:${input.threadId}:${ordinal}`),
        type: "provider-turn.updated",
        threadId: input.threadId,
        runId: ids.runId,
        nodeId: ids.nodeId,
        occurredAt: now,
        payload: { ...turn, status: "completed", completedAt: now },
      },
      {
        id: EventId.make(`event:seed-run-completed:${input.threadId}:${ordinal}`),
        type: "run.updated",
        threadId: input.threadId,
        runId: ids.runId,
        occurredAt: now,
        payload: { ...run, status: "completed", completedAt: now },
      },
    ],
  });
});

/**
 * Completes every blocking run on the thread (orchestrator-started runs never
 * progress on the inert session), optionally recording a last assistant
 * message on the latest; returns that run.
 */
export const completeOpenRuns = Effect.fn("loom.testkit.completeOpenRuns")(function* (
  threadId: ThreadId,
  lastAssistantText?: string,
) {
  const now = yield* DateTime.now;
  const runs = (yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(
    threadId,
  )).runs.filter((run) => ["preparing", "starting", "running", "waiting"].includes(run.status));
  const events: Array<OrchestrationV2DomainEvent> = runs.map((run) => ({
    id: EventId.make(`event:complete-open-run:${run.id}`),
    type: "run.updated",
    threadId,
    runId: run.id,
    occurredAt: now,
    payload: { ...run, status: "completed", completedAt: now },
  }));
  const last = runs.at(-1);
  if (last !== undefined && lastAssistantText !== undefined) {
    events.unshift({
      id: EventId.make(`event:last-assistant:${last.id}`),
      type: "turn-item.updated",
      threadId,
      runId: last.id,
      occurredAt: now,
      payload: {
        id: TurnItemId.make(`turn-item:last-assistant:${last.id}`),
        threadId,
        runId: last.id,
        nodeId: last.rootNodeId ?? NodeId.make(`node:${last.id}`),
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 10,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "assistant_message",
        messageId: MessageId.make(`message:last-assistant:${last.id}`),
        text: lastAssistantText,
        streaming: false,
      },
    });
  }
  yield* (yield* EventSink.EventSinkV2).write({ events });
  return last;
});

/**
 * A run that failed on a usage limit whose reset time has passed, with upstream's
 * limit recovery armed (auto-resume): the state in which upstream's
 * `UsageLimitRecoveryWorker` sends its limit-resume `message.dispatch`
 * (`createdBy: "user"`, `creationSource: "server"`, `usageLimitContinuationOfRunId`).
 */
export const seedUsageLimitedRun = Effect.fn("loom.testkit.seedUsageLimitedRun")(function* (input: {
  readonly threadId: ThreadId;
}) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sink = yield* EventSink.EventSinkV2;
  const ids = yield* seedRunningRun({ threadId: input.threadId });
  const projection = yield* orchestrator.getThreadProjection(input.threadId);
  const run = projection.runs.find((entry) => entry.id === ids.runId)!;
  const turn = projection.providerTurns.find((entry) => entry.id === ids.providerTurnId)!;
  const now = yield* DateTime.now;
  const resetAt = DateTime.formatIso(DateTime.subtract(now, { minutes: 1 }));
  const base = { threadId: input.threadId, runId: ids.runId, occurredAt: now };
  yield* sink.writeWithEffects({
    effects: [],
    events: [
      {
        ...base,
        id: EventId.make(`event:seed-limit-item:${input.threadId}`),
        type: "turn-item.updated",
        nodeId: ids.nodeId,
        payload: {
          id: TurnItemId.make(`turn-item:seed-limit:${input.threadId}`),
          threadId: input.threadId,
          runId: ids.runId,
          nodeId: ids.nodeId,
          providerThreadId: ids.providerThreadId,
          providerTurnId: ids.providerTurnId,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 0,
          status: "failed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "error",
          failure: {
            class: "usage_limit",
            message: "Usage limit reached.",
            code: null,
            retryable: true,
            resetAt,
          },
        },
      },
      {
        ...base,
        id: EventId.make(`event:seed-limit-turn:${input.threadId}`),
        type: "provider-turn.updated",
        nodeId: ids.nodeId,
        payload: { ...turn, status: "failed", completedAt: now },
      },
      {
        ...base,
        id: EventId.make(`event:seed-limit-run:${input.threadId}`),
        type: "run.updated",
        payload: { ...run, status: "failed", completedAt: now },
      },
      {
        id: EventId.make(`event:seed-limit-recovery:${input.threadId}`),
        type: "thread.metadata-updated",
        threadId: input.threadId,
        occurredAt: now,
        payload: {
          ...projection.thread,
          limitRecovery: { runId: ids.runId, resetAt, autoResume: true },
        },
      },
    ],
  });
  return ids;
});

type LoomEventOf<Type extends LoomDomainEvent["type"]> = Extract<LoomDomainEvent, { type: Type }>;

let loomEventCounter = 0;

/** A Loom domain event with a fresh id, stamped now unless `occurredAt` is given. */
export const loomEvent = <Type extends LoomDomainEvent["type"]>(
  type: Type,
  threadId: ThreadId,
  payload: LoomEventOf<Type>["payload"],
  options: { readonly id?: EventId; readonly occurredAt?: DateTime.Utc } = {},
) =>
  Effect.map(
    options.occurredAt === undefined ? DateTime.now : Effect.succeed(options.occurredAt),
    (occurredAt) =>
      ({
        id: options.id ?? EventId.make(`event:loom-test:${++loomEventCounter}`),
        type,
        threadId,
        occurredAt,
        payload,
      }) as unknown as OrchestrationV2DomainEvent,
  );

/** Commits events through the real sink (so the Loom fold runs in the commit transaction). */
export const writeEvents = Effect.fn("loom.testkit.writeEvents")(function* (
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
) {
  const sink = yield* EventSink.EventSinkV2;
  return yield* sink.write({ events });
});

/** Dispatches through the real orchestrator (receipt, lock, commit). */
export const dispatch = Effect.fn("loom.testkit.dispatch")(function* (
  command: Parameters<Orchestrator.OrchestratorV2["Service"]["dispatch"]>[0],
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  return yield* orchestrator.dispatch(command);
});

/** Spawns a Loom child through the arm (`thread.spawn`, locked on the parent). */
export const spawnChild = Effect.fn("loom.testkit.spawnChild")(function* (input: {
  readonly parentThreadId: ThreadId | null;
  readonly threadId: ThreadId;
  readonly projectId?: ProjectId;
  readonly graphKey?: string;
  readonly blockedBy?: ReadonlyArray<ThreadId>;
  readonly routes?: ReadonlyArray<WorkstreamRoute>;
  readonly held?: boolean;
  readonly role?: string;
  readonly forkFromThreadId?: ThreadId;
  readonly kickoffBriefPath?: string;
}) {
  return yield* dispatch({
    type: "thread.spawn",
    commandId: CommandId.make(`server:test-spawn:${input.threadId}`),
    threadId: input.threadId,
    createdAt: DateTime.formatIso(yield* DateTime.now),
    createdBy: "agent",
    creationSource: "mcp",
    parentThreadId: input.parentThreadId,
    projectId: input.projectId ?? ProjectId.make("project:loom-test"),
    title: `Child ${input.threadId}`,
    modelSelection: testModelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    role: input.role ?? "coder",
    purpose: "Loom substrate test child",
    goalId: null,
    ...(input.graphKey === undefined ? {} : { graphKey: input.graphKey }),
    ...(input.blockedBy === undefined ? {} : { blockedBy: input.blockedBy }),
    ...(input.routes === undefined ? {} : { routes: input.routes }),
    ...(input.held === undefined ? {} : { held: input.held }),
    ...(input.forkFromThreadId === undefined ? {} : { forkFromThreadId: input.forkFromThreadId }),
    ...(input.kickoffBriefPath === undefined ? {} : { kickoffBriefPath: input.kickoffBriefPath }),
  });
});

/** The first stored event after `afterSequence` matching `predicate` (tails live; no sleeps). */
export const awaitStoredEvent = Effect.fn("loom.testkit.awaitStoredEvent")(function* (input: {
  readonly afterSequence: number;
  readonly threadId?: ThreadId;
  readonly predicate: (event: OrchestrationV2DomainEvent) => boolean;
}) {
  const sink = yield* EventSink.EventSinkV2;
  const found = yield* sink
    .stream({
      afterSequence: input.afterSequence,
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
    })
    .pipe(
      Stream.filter((stored) => input.predicate(stored.event)),
      Stream.take(1),
      Stream.runHead,
    );
  return Option.getOrThrow(found).event;
});
