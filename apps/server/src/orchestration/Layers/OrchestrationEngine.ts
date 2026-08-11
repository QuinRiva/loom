import type {
  GoalId,
  OrchestrationEvent,
  OrchestrationReadModel,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { OrchestrationCommand } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  metricAttributes,
  orchestrationCommandAckDuration,
  orchestrationCommandsTotal,
  orchestrationCommandDuration,
} from "../../observability/Metrics.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import {
  OrchestrationCommandDeferredError,
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  type OrchestrationDispatchError,
  type OrchestrationProjectorDecodeError,
} from "../Errors.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import { isThreadIdle } from "../threadIdle.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
const isOrchestrationCommandPreviouslyRejectedError = Schema.is(
  OrchestrationCommandPreviouslyRejectedError,
);
const isOrchestrationCommandInvariantError = Schema.is(OrchestrationCommandInvariantError);

/**
 * Slow-command telemetry threshold. The command worker is a single serial fiber
 * (`Effect.forever(Queue.take >>= processEnvelope)`), so a slow command at the
 * head of the queue stalls every other thread's commands behind it. The web UI
 * observed `orchestration.dispatchCommand` waits >15s with zero server-side
 * trace; warn-logging any command whose total handling crosses this threshold
 * (splitting queue-wait from processing time) surfaces those stalls and gives
 * the structural DB-lane work the queue-wait-vs-processing evidence it needs.
 */
const SLOW_COMMAND_LOG_THRESHOLD_MS = 3_000;
const SLOW_COMMAND_PROCESSING_LOG_THRESHOLD_MS = 250;
const COMMAND_QUEUE_LOG_INTERVAL_MS = 60_000;
const COMMAND_QUEUE_WAIT_BUCKETS_MS = [
  0,
  1,
  2,
  5,
  10,
  20,
  50,
  100,
  250,
  500,
  1_000,
  3_000,
  10_000,
  30_000,
  Number.POSITIVE_INFINITY,
] as const;

type CommandAttribution = ReturnType<typeof commandToAggregateRef> & {
  readonly commandType: OrchestrationCommand["type"];
  readonly commandId: OrchestrationCommand["commandId"];
};

interface CommandQueueInterval {
  commandCount: number;
  queueWaitBuckets: number[];
  queueWaitMaxMs: number;
  maxQueueWaitCommand: CommandAttribution | null;
  processingMaxMs: number;
  maxProcessingCommand: CommandAttribution | null;
}

const makeCommandQueueInterval = (): CommandQueueInterval => ({
  commandCount: 0,
  queueWaitBuckets: COMMAND_QUEUE_WAIT_BUCKETS_MS.map(() => 0),
  queueWaitMaxMs: 0,
  maxQueueWaitCommand: null,
  processingMaxMs: 0,
  maxProcessingCommand: null,
});

const queueWaitPercentile = (interval: CommandQueueInterval, percentile: number): number => {
  if (interval.commandCount === 0) return 0;
  const target = Math.ceil(interval.commandCount * percentile);
  let observed = 0;
  for (const [index, count] of interval.queueWaitBuckets.entries()) {
    observed += count;
    if (observed >= target) {
      const upperBound = COMMAND_QUEUE_WAIT_BUCKETS_MS[index];
      return upperBound === undefined || !Number.isFinite(upperBound)
        ? interval.queueWaitMaxMs
        : upperBound;
    }
  }
  return interval.queueWaitMaxMs;
};

interface CommandEnvelope {
  command: OrchestrationCommand;
  result: Deferred.Deferred<{ sequence: number }, OrchestrationDispatchError>;
  startedAtMs: number;
}

function commandToAggregateRef(command: OrchestrationCommand): {
  readonly aggregateKind: "project" | "goal" | "thread";
  readonly aggregateId: ProjectId | GoalId | ThreadId;
} {
  switch (command.type) {
    case "project.create":
    case "project.meta.update":
    case "project.delete":
      return {
        aggregateKind: "project",
        aggregateId: command.projectId,
      };
    case "goal.create":
    case "goal.meta.update":
    case "goal.archive":
    case "goal.unarchive":
    case "goal.delete":
    case "goal.task.create":
    case "goal.task.update":
    case "goal.task.delete":
      return {
        aggregateKind: "goal",
        aggregateId: command.goalId,
      };
    case "thread.scaffold":
      // A scaffold has no single threadId; attribute it to the parent thread
      // whose child graph it creates (telemetry/receipt only — the committed
      // receipt uses the last emitted event's aggregate id).
      return {
        aggregateKind: "thread",
        aggregateId: command.parentThreadId,
      };
    default:
      return {
        aggregateKind: "thread",
        aggregateId: command.threadId,
      };
  }
}

const makeOrchestrationEngine = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventStore = yield* OrchestrationEventStore;
  const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository;
  const projectionPipeline = yield* OrchestrationProjectionPipeline;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  let commandReadModel = createEmptyReadModel(yield* nowIso);

  const commandQueue = yield* Queue.unbounded<CommandEnvelope>();
  const eventPubSub = yield* PubSub.unbounded<OrchestrationEvent>();
  let commandQueueInterval = makeCommandQueueInterval();

  const recordCommandQueueTelemetry = (input: {
    readonly attribution: CommandAttribution;
    readonly queueWaitMs: number;
    readonly processingMs: number;
  }): void => {
    commandQueueInterval.commandCount += 1;
    const bucketIndex = COMMAND_QUEUE_WAIT_BUCKETS_MS.findIndex(
      (upperBound) => input.queueWaitMs <= upperBound,
    );
    commandQueueInterval.queueWaitBuckets[
      bucketIndex < 0 ? commandQueueInterval.queueWaitBuckets.length - 1 : bucketIndex
    ]! += 1;
    if (input.queueWaitMs >= commandQueueInterval.queueWaitMaxMs) {
      commandQueueInterval.queueWaitMaxMs = input.queueWaitMs;
      commandQueueInterval.maxQueueWaitCommand = input.attribution;
    }
    if (input.processingMs >= commandQueueInterval.processingMaxMs) {
      commandQueueInterval.processingMaxMs = input.processingMs;
      commandQueueInterval.maxProcessingCommand = input.attribution;
    }
  };

  const logCommandQueueInterval = Effect.sync(() => {
    const interval = commandQueueInterval;
    commandQueueInterval = makeCommandQueueInterval();
    return interval;
  }).pipe(
    Effect.flatMap((interval) =>
      Effect.logInfo("orchestration command queue interval", {
        intervalMs: COMMAND_QUEUE_LOG_INTERVAL_MS,
        commandCount: interval.commandCount,
        queueWaitP50Ms: queueWaitPercentile(interval, 0.5),
        queueWaitP95Ms: queueWaitPercentile(interval, 0.95),
        queueWaitP99Ms: queueWaitPercentile(interval, 0.99),
        queueWaitMaxMs: interval.queueWaitMaxMs,
        processingMaxMs: interval.processingMaxMs,
        ...(interval.maxQueueWaitCommand === null
          ? {}
          : {
              maxQueueWaitCommandType: interval.maxQueueWaitCommand.commandType,
              maxQueueWaitCommandId: interval.maxQueueWaitCommand.commandId,
              maxQueueWaitAggregateKind: interval.maxQueueWaitCommand.aggregateKind,
              maxQueueWaitAggregateId: interval.maxQueueWaitCommand.aggregateId,
            }),
        ...(interval.maxProcessingCommand === null
          ? {}
          : {
              maxProcessingCommandType: interval.maxProcessingCommand.commandType,
              maxProcessingCommandId: interval.maxProcessingCommand.commandId,
              maxProcessingAggregateKind: interval.maxProcessingCommand.aggregateKind,
              maxProcessingAggregateId: interval.maxProcessingCommand.aggregateId,
            }),
      }),
    ),
  );

  const projectEventsOntoReadModel = (
    baseReadModel: OrchestrationReadModel,
    events: ReadonlyArray<OrchestrationEvent>,
  ): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError, never> =>
    Effect.gen(function* () {
      let nextReadModel = baseReadModel;
      for (const event of events) {
        nextReadModel = yield* projectEvent(nextReadModel, event);
      }
      return nextReadModel;
    });

  const processEnvelope = (envelope: CommandEnvelope): Effect.Effect<void> => {
    const dispatchStartSequence = commandReadModel.snapshotSequence;
    let processingStartedAtMs = 0;
    const aggregateRef = commandToAggregateRef(envelope.command);
    const baseMetricAttributes = {
      commandType: envelope.command.type,
      aggregateKind: aggregateRef.aggregateKind,
    } as const;
    const reconcileReadModelAfterDispatchFailure = Effect.gen(function* () {
      const persistedEvents = yield* Stream.runCollect(
        // loom: reconciliation must observe every event persisted since the
        // dispatch started; an implicit page bound could silently omit some and
        // leave the read model diverged from the store.
        eventStore.readFromSequence(dispatchStartSequence, Number.MAX_SAFE_INTEGER),
      ).pipe(Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)));
      if (persistedEvents.length === 0) {
        return;
      }

      commandReadModel = yield* projectEventsOntoReadModel(commandReadModel, persistedEvents);

      for (const persistedEvent of persistedEvents) {
        yield* PubSub.publish(eventPubSub, persistedEvent);
      }
    });

    return Effect.exit(
      Effect.gen(function* () {
        processingStartedAtMs = yield* Clock.currentTimeMillis;
        yield* Effect.annotateCurrentSpan({
          "orchestration.command_id": envelope.command.commandId,
          "orchestration.command_type": envelope.command.type,
          "orchestration.aggregate_kind": aggregateRef.aggregateKind,
          "orchestration.aggregate_id": aggregateRef.aggregateId,
        });

        const existingReceipt = yield* commandReceiptRepository.getByCommandId({
          commandId: envelope.command.commandId,
        });
        if (Option.isSome(existingReceipt)) {
          if (existingReceipt.value.status === "accepted") {
            return {
              sequence: existingReceipt.value.resultSequence,
            };
          }
          return yield* new OrchestrationCommandPreviouslyRejectedError({
            commandId: envelope.command.commandId,
            detail: existingReceipt.value.error ?? "Previously rejected.",
          });
        }

        // Atomic idle gate (D-notify decision 3): a dispatcher-injected wake
        // (`requireIdle`) must only land on an idle parent. The dispatcher's
        // pre-filter checks idleness at snapshot-read time, but a real prompt
        // can be committed in the serialized queue between that read and this
        // command. Re-check here against the just-committed state (read-model
        // session/active-turn + the durable pending-turn-start projection) so
        // the wake cannot clobber an in-flight or just-requested parent turn.
        // A busy parent is *deferred*, not rejected: we fail without writing a
        // receipt, so the deterministic wake command id stays redeliverable
        // when the parent next goes idle (drained on `thread.session-set`).
        if (
          envelope.command.type === "thread.turn.start" &&
          envelope.command.requireIdle === true
        ) {
          const idleCommand = envelope.command;
          const pendingTurnStartThreadIds =
            yield* projectionSnapshotQuery.getPendingTurnStartThreadIds();
          const target = commandReadModel.threads.find(
            (thread) => thread.id === idleCommand.threadId,
          );
          if (target === undefined || !isThreadIdle(target, pendingTurnStartThreadIds)) {
            return yield* new OrchestrationCommandDeferredError({
              commandType: idleCommand.type,
              detail: `Idle-gated turn-start for thread '${idleCommand.threadId}' deferred: target is not idle.`,
            });
          }
          // notify_thread (D3/D4): a peer-message delivery must NEVER re-engage a
          // terminal or archived target. The handler/dispatcher shell checks are
          // best-effort (a target can go done/cancelled/archived between that
          // read and this serial boundary); this makes liveness part of the same
          // atomic decision as idleness. Deferring (not rejecting) keeps the
          // durable pending row intact so the dispatcher rail marks it expired on
          // its next pass. Scoped to `origin: "notify"` so ordinary control-plane
          // wakes keep their sticky-terminal re-engagement semantics.
          if (
            idleCommand.message.origin === "notify" &&
            (target.planLane === "done" ||
              target.planLane === "cancelled" ||
              target.archivedAt !== null)
          ) {
            return yield* new OrchestrationCommandDeferredError({
              commandType: idleCommand.type,
              detail: `notify_thread delivery for thread '${idleCommand.threadId}' deferred: target became ${target.archivedAt !== null ? "archived" : target.planLane} before delivery (the pending row will be expired).`,
            });
          }
        }

        const eventBase = yield* decideOrchestrationCommand({
          command: envelope.command,
          readModel: commandReadModel,
        }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.mapError((cause) =>
            isOrchestrationCommandInvariantError(cause)
              ? cause
              : new OrchestrationCommandInvariantError({
                  commandType: envelope.command.type,
                  detail: "Failed to generate an event identifier.",
                  cause,
                }),
          ),
        );
        const eventBases = Array.isArray(eventBase) ? eventBase : [eventBase];
        // loom: a decider may legitimately decide a command is a NO-OP and emit
        // nothing — the unchanged-value guards (e.g. raising an attention flag
        // that is already up, whose event is a dispatcher trigger and so bought a
        // full pass per redundant raise). Acknowledge at the current sequence:
        // nothing was written, so there is no receipt to record and no read-model
        // change to publish, and an idempotent caller must not see a failure.
        if (eventBases.length === 0) {
          return { sequence: commandReadModel.snapshotSequence };
        }
        const committedCommand = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const committedEvents: OrchestrationEvent[] = [];
              let nextCommandReadModel = commandReadModel;

              for (const nextEvent of eventBases) {
                const savedEvent = yield* eventStore.append(nextEvent);
                nextCommandReadModel = yield* projectEvent(nextCommandReadModel, savedEvent);
                yield* projectionPipeline.projectEvent(savedEvent);
                committedEvents.push(savedEvent);
              }

              const lastSavedEvent = committedEvents.at(-1) ?? null;
              if (lastSavedEvent === null) {
                return yield* new OrchestrationCommandInvariantError({
                  commandType: envelope.command.type,
                  detail: "Command produced no events.",
                });
              }

              yield* commandReceiptRepository.upsert({
                commandId: envelope.command.commandId,
                aggregateKind: lastSavedEvent.aggregateKind,
                aggregateId: lastSavedEvent.aggregateId,
                acceptedAt: lastSavedEvent.occurredAt,
                resultSequence: lastSavedEvent.sequence,
                status: "accepted",
                error: null,
              });

              return {
                committedEvents,
                lastSequence: lastSavedEvent.sequence,
                nextCommandReadModel,
              } as const;
            }),
          )
          .pipe(
            Effect.catchTag("SqlError", (sqlError) =>
              Effect.fail(
                toPersistenceSqlError("OrchestrationEngine.processEnvelope:transaction")(sqlError),
              ),
            ),
          );

        commandReadModel = committedCommand.nextCommandReadModel;
        for (const [index, event] of committedCommand.committedEvents.entries()) {
          yield* PubSub.publish(eventPubSub, event);
          if (index === 0) {
            yield* Metric.update(
              Metric.withAttributes(
                orchestrationCommandAckDuration,
                metricAttributes({
                  ...baseMetricAttributes,
                  ackEventType: event.type,
                }),
              ),
              Duration.millis(Math.max(0, (yield* Clock.currentTimeMillis) - envelope.startedAtMs)),
            );
          }
        }
        return { sequence: committedCommand.lastSequence };
      }).pipe(Effect.withSpan(`orchestration.command.${envelope.command.type}`)),
    ).pipe(
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          const outcome = Exit.isSuccess(exit)
            ? "success"
            : Cause.hasInterruptsOnly(exit.cause)
              ? "interrupt"
              : "failure";
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandDuration,
              metricAttributes(baseMetricAttributes),
            ),
            Duration.millis(Math.max(0, (yield* Clock.currentTimeMillis) - processingStartedAtMs)),
          );
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandsTotal,
              metricAttributes({
                ...baseMetricAttributes,
                outcome,
              }),
            ),
            1,
          );

          const finishedAtMs = yield* Clock.currentTimeMillis;
          const queueWaitMs = Math.max(0, processingStartedAtMs - envelope.startedAtMs);
          const processingMs = Math.max(0, finishedAtMs - processingStartedAtMs);
          const totalMs = Math.max(0, finishedAtMs - envelope.startedAtMs);
          const attribution = {
            commandType: envelope.command.type,
            commandId: envelope.command.commandId,
            ...aggregateRef,
          };
          recordCommandQueueTelemetry({ attribution, queueWaitMs, processingMs });
          if (processingMs >= SLOW_COMMAND_PROCESSING_LOG_THRESHOLD_MS) {
            yield* Effect.logWarning("orchestration command processing slow", {
              ...attribution,
              outcome,
              queueWaitMs,
              processingMs,
              totalMs,
            });
          }
          if (totalMs >= SLOW_COMMAND_LOG_THRESHOLD_MS) {
            yield* Effect.logWarning("orchestration command slow", {
              commandType: envelope.command.type,
              commandId: envelope.command.commandId,
              aggregateKind: aggregateRef.aggregateKind,
              aggregateId: aggregateRef.aggregateId,
              outcome,
              queueWaitMs,
              processingMs,
              totalMs,
            });
          }

          if (Exit.isSuccess(exit)) {
            yield* Deferred.succeed(envelope.result, exit.value);
            return;
          }

          const error = Cause.squash(exit.cause) as OrchestrationDispatchError;
          if (!isOrchestrationCommandPreviouslyRejectedError(error)) {
            yield* reconcileReadModelAfterDispatchFailure.pipe(
              Effect.catch(() =>
                Effect.logWarning(
                  "failed to reconcile orchestration read model after dispatch failure",
                ).pipe(
                  Effect.annotateLogs({
                    commandId: envelope.command.commandId,
                    snapshotSequence: commandReadModel.snapshotSequence,
                  }),
                ),
              ),
            );

            // Idempotent project.create (invariant: at most one active project
            // per workspace_root). If the create failed but an active project now
            // exists for this path, resolve it to a benign success that reuses the
            // existing project instead of surfacing a dispatch failure to the
            // caller. This covers both a cross-engine race (another engine won and
            // the partial unique index rolled our duplicate back) and a same-engine
            // duplicate (the in-memory decider guard rejected it). Either way the
            // failed transaction already rolled back, so no duplicate event was
            // committed, and the reconcile above has synced the winning project
            // into commandReadModel so subsequent commands resolve it.
            if (envelope.command.type === "project.create") {
              const command = envelope.command;
              const existingProject = commandReadModel.projects.find(
                (project) =>
                  project.deletedAt === null && project.workspaceRoot === command.workspaceRoot,
              );
              if (existingProject !== undefined) {
                yield* commandReceiptRepository
                  .upsert({
                    commandId: command.commandId,
                    aggregateKind: "project",
                    aggregateId: existingProject.id,
                    acceptedAt: yield* nowIso,
                    resultSequence: commandReadModel.snapshotSequence,
                    status: "accepted",
                    error: null,
                  })
                  .pipe(Effect.catch(() => Effect.void));
                yield* Deferred.succeed(envelope.result, {
                  sequence: commandReadModel.snapshotSequence,
                });
                return;
              }
            }

            if (isOrchestrationCommandInvariantError(error)) {
              yield* commandReceiptRepository
                .upsert({
                  commandId: envelope.command.commandId,
                  aggregateKind: aggregateRef.aggregateKind,
                  aggregateId: aggregateRef.aggregateId,
                  acceptedAt: yield* nowIso,
                  resultSequence: commandReadModel.snapshotSequence,
                  status: "rejected",
                  error: error.message,
                })
                .pipe(Effect.catch(() => Effect.void));
            }
          }

          yield* Deferred.fail(envelope.result, error);
        }),
      ),
    );
  };

  yield* projectionPipeline.bootstrap;
  commandReadModel = yield* projectionSnapshotQuery.getCommandReadModel();

  const worker = Effect.forever(Queue.take(commandQueue).pipe(Effect.flatMap(processEnvelope)));
  yield* Effect.forkScoped(worker);
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.sleep(COMMAND_QUEUE_LOG_INTERVAL_MS).pipe(Effect.andThen(logCommandQueueInterval)),
    ),
  );
  yield* Effect.logDebug("orchestration engine started").pipe(
    Effect.annotateLogs({ sequence: commandReadModel.snapshotSequence }),
  );

  const readEvents: OrchestrationEngineShape["readEvents"] = (fromSequenceExclusive, limit) =>
    eventStore.readFromSequence(fromSequenceExclusive, limit);

  // loom: per-aggregate replay (see the Service docs for why this exists).
  const readStreamEvents: OrchestrationEngineShape["readStreamEvents"] =
    eventStore.readStreamFromSequence;

  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.gen(function* () {
      const result = yield* Deferred.make<{ sequence: number }, OrchestrationDispatchError>();
      yield* Queue.offer(commandQueue, {
        command,
        result,
        startedAtMs: yield* Clock.currentTimeMillis,
      });
      return yield* Deferred.await(result);
    });

  return {
    readEvents,
    readStreamEvents,
    dispatch,
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (wsServer, ProviderRuntimeIngestion, CheckpointReactor, etc.)
    // each independently receive all domain events.
    get streamDomainEvents(): OrchestrationEngineShape["streamDomainEvents"] {
      return Stream.fromPubSub(eventPubSub);
    },
    // Eager, scoped subscription: attaches to `eventPubSub` the moment the
    // effect runs so events published during a subsequent snapshot fetch are
    // buffered in the subscription queue instead of being lost in the
    // connect-gap. Returns a Stream over that already-attached subscription.
    subscribeDomainEvents: Effect.map(PubSub.subscribe(eventPubSub), (subscription) =>
      Stream.fromSubscription(subscription),
    ),
    // The command read model's snapshotSequence tracks the latest committed
    // event sequence (updated on the worker fiber). A plain property read is a
    // consistent, committed value — reassignment of `commandReadModel` is
    // atomic on the single-threaded event loop.
    latestSequence: Effect.sync(() => commandReadModel.snapshotSequence),
  } satisfies OrchestrationEngineShape;
});

export const OrchestrationEngineLive = Layer.effect(
  OrchestrationEngineService,
  makeOrchestrationEngine,
);
