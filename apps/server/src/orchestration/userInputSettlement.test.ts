/**
 * The settlement guarantee, verified on the paths the forensic audit found
 * broken.
 *
 * Two incidents, one test each:
 *  - incident 1 (thread `57fbb002`, wedged 22 hours): a cancellation emitted into
 *    a shut-down event queue, present in the canonical log and absent from the
 *    database, leaving `pending_user_input_count = 1` forever and 16 answer
 *    attempts changing nothing;
 *  - incident 2 (thread `13653de6`): two plain Slack replies queued as steers
 *    against a turn blocked inside the tool call, so they were never consumed.
 *
 * Plus the fold invariant as a genuine truncate-and-rebuild replay over
 * pathological activity orderings — not live interleavings, because the bug class
 * is precisely "the rebuilt state disagrees with the live state".
 */
import {
  CommandId,
  CorrelationId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type UserInputResolvedOutcome,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import {
  ORCHESTRATION_PROJECTOR_NAMES,
  OrchestrationProjectionPipelineLive,
} from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionPipeline } from "./Services/ProjectionPipeline.ts";
import {
  dispatchUserInputResolutions,
  ALREADY_SETTLED_REJECTION_MARKER,
  isAlreadySettledRejection,
  registerUserInputSettlementReporter,
  registerUserInputSettlementSink,
  settleUserInputRequestsDurably,
  userInputResolvedActivity,
} from "./userInputSettlement.ts";
import {
  cancelPiAskUserQuestions,
  openPiAskUserQuestion,
  registerPiAskUserEmitter,
  waitForPiAskUserQuestion,
} from "../provider/Drivers/Pi/askUserBroker.ts";

const TestLayer = OrchestrationProjectionPipelineLive.pipe(
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-user-input-settle-" })),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

// One thread per test: the layer (and therefore the in-memory database) is shared
// across this file, and the whole point of the fold assertions is a per-thread
// count, so tests must not see each other's requests.
const INCIDENT_THREAD = ThreadId.make("thread-settlement-incident");
const REPLAY_THREAD = ThreadId.make("thread-settlement-replay");
const PROJECT = ProjectId.make("project-settlement");
const AT = "2026-07-27T06:42:17.283Z";

// The layer (and therefore the in-memory database) is shared across the tests in
// this file, so ids must be globally unique, not per-test.
let sequence = 0;
const nextEvent = (
  event: Omit<OrchestrationEvent, "sequence" | "commandId" | "causationEventId" | "correlationId">,
): OrchestrationEvent => {
  sequence += 1;
  const commandId = CommandId.make(`cmd-settlement-${sequence}`);
  return {
    ...event,
    sequence,
    commandId,
    causationEventId: null,
    correlationId: CorrelationId.make(commandId),
  } as OrchestrationEvent;
};

const requestedActivityEvent = (input: {
  readonly threadId: ThreadId;
  readonly activityId: string;
  readonly requestId: string;
  readonly createdAt: string;
}) =>
  nextEvent({
    type: "thread.activity-appended",
    eventId: EventId.make(`evt-${input.activityId}`),
    aggregateKind: "thread",
    aggregateId: input.threadId,
    occurredAt: input.createdAt,
    metadata: {},
    payload: {
      threadId: input.threadId,
      activity: {
        id: EventId.make(input.activityId),
        tone: "info",
        kind: "user-input.requested",
        summary: "User input requested",
        payload: {
          requestId: input.requestId,
          questions: [
            {
              id: `${input.requestId}:1`,
              header: "Choice",
              question: "Continue?",
              options: [{ label: "Yes", description: "Continue" }],
            },
          ],
        },
        turnId: null,
        createdAt: input.createdAt,
      },
    },
  } as never);

const resolvedActivityEvent = (input: {
  readonly threadId: ThreadId;
  readonly activityId: string;
  readonly requestId: string;
  readonly outcome: UserInputResolvedOutcome;
  readonly createdAt: string;
}) =>
  nextEvent({
    type: "thread.activity-appended",
    eventId: EventId.make(`evt-${input.activityId}`),
    aggregateKind: "thread",
    aggregateId: input.threadId,
    occurredAt: input.createdAt,
    metadata: {},
    payload: {
      threadId: input.threadId,
      activity: userInputResolvedActivity({
        activityId: EventId.make(input.activityId),
        resolution: { requestId: input.requestId, outcome: input.outcome },
        turnId: null,
        createdAt: input.createdAt,
      }),
    },
  } as never);

const seedThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const eventStore = yield* OrchestrationEventStore;
    const pipeline = yield* OrchestrationProjectionPipeline;
    const append = (event: OrchestrationEvent) =>
      eventStore
        .append(event)
        .pipe(Effect.flatMap((saved) => pipeline.projectEvent(saved)))
        .pipe(Effect.asVoid);

    yield* append(
      nextEvent({
        type: "project.created",
        eventId: EventId.make(`evt-settlement-project-${sequence + 1}`),
        aggregateKind: "project",
        aggregateId: PROJECT,
        occurredAt: AT,
        metadata: {},
        payload: {
          projectId: PROJECT,
          title: "Settlement",
          workspaceRoot: "/tmp/settlement",
          defaultModelSelection: null,
          scripts: [],
          createdAt: AT,
          updatedAt: AT,
        },
      } as never),
    );
    yield* append(
      nextEvent({
        type: "thread.created",
        eventId: EventId.make(`evt-settlement-thread-${sequence + 1}`),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: AT,
        metadata: {},
        payload: {
          threadId,
          projectId: PROJECT,
          title: "Settlement",
          modelSelection: { instanceId: ProviderInstanceId.make("pi"), model: "pi" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: AT,
          updatedAt: AT,
        },
      } as never),
    );
    return append;
  });

const pendingCount = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly count: number }>`
      SELECT pending_user_input_count AS "count"
      FROM projection_threads
      WHERE thread_id = ${threadId}
    `;
    return rows[0]?.count ?? -1;
  });

const resolvedOutcomes = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{ readonly requestId: string; readonly outcome: string | null }>`
      SELECT
        json_extract(payload_json, '$.requestId') AS "requestId",
        json_extract(payload_json, '$.outcome') AS "outcome"
      FROM projection_thread_activities
      WHERE thread_id = ${threadId} AND kind = 'user-input.resolved'
      ORDER BY created_at ASC, activity_id ASC
    `;
  });

it.layer(TestLayer)("user-input settlement guarantee", (it) => {
  // INCIDENT 1. The pi process dies with its event queue already shut down, so
  // the cancellation cannot ride the queue. The forensic signature of the bug is
  // "cancellation in the canonical log, absent from the database"; here the
  // durable command-path fallback must produce the DB row regardless, and the
  // blocked poll must still be released.
  it.effect("persists a cancellation the session event queue could not carry", () =>
    Effect.gen(function* () {
      const append = yield* seedThread(INCIDENT_THREAD);
      const eventStore = yield* OrchestrationEventStore;
      const pipeline = yield* OrchestrationProjectionPipeline;

      // The REAL sink: it dispatches through the same helper the ingestion layer
      // registers, against the real event store and projection. The chain under
      // test is therefore unbroken — pi process exit → broker → registered sink →
      // command path → DB — which is the whole point: incident 1's cancellation
      // existed in the canonical log and never reached the database.
      const settlementServices = yield* Effect.context<never>();
      const sinkTags: Array<string> = [];
      let nextSettlementId = 0;
      const unregisterSink = registerUserInputSettlementSink((sinkInput) => {
        sinkTags.push(sinkInput.tag);
        return Effect.runPromiseWith(settlementServices)(
          dispatchUserInputResolutions({
            dispatch: (command) =>
              eventStore
                .append(
                  nextEvent({
                    type: "thread.activity-appended",
                    eventId: EventId.make(`evt-${command.activity.id}`),
                    aggregateKind: "thread",
                    aggregateId: command.threadId,
                    occurredAt: command.createdAt,
                    metadata: {},
                    payload: { threadId: command.threadId, activity: command.activity },
                  } as never),
                )
                .pipe(Effect.flatMap((saved) => pipeline.projectEvent(saved))),
            newId: Effect.sync(() => {
              nextSettlementId += 1;
              return `act-settlement-${nextSettlementId}`;
            }),
            threadId: sinkInput.threadId,
            resolutions: sinkInput.resolutions,
            createdAt: "2026-07-27T07:07:05.964Z",
            tag: sinkInput.tag,
          }),
        );
      });

      // The emitter is registered, but its queue is gone: `offer` resolves
      // without delivering, exactly as it does mid-shutdown.
      const unregisterEmitter = registerPiAskUserEmitter(INCIDENT_THREAD, async () => false);
      const opened = yield* Effect.promise(() =>
        openPiAskUserQuestion(INCIDENT_THREAD, (id) => [
          {
            id: `${id}:1`,
            header: "Choice",
            question: "Continue?",
            options: [{ label: "Yes", description: "Continue" }],
            multiSelect: false,
          },
        ]),
      );
      if ("outcome" in opened) throw new Error("Expected a registered emitter.");

      // The durable `requested` row exists (ingestion persisted it before the
      // process died), so the thread reads as blocked on a human.
      yield* append(
        requestedActivityEvent({
          threadId: INCIDENT_THREAD,
          activityId: "act-incident-1",
          requestId: opened.requestId,
          createdAt: AT,
        }),
      );
      assert.strictEqual(yield* pendingCount(INCIDENT_THREAD), 1);

      const poll = waitForPiAskUserQuestion(INCIDENT_THREAD, opened.requestId, 5_000);

      // The process-exit path, verbatim.
      yield* Effect.promise(() => cancelPiAskUserQuestions(INCIDENT_THREAD));

      // The blocked tool call is released…
      expect(yield* Effect.promise(() => poll)).toEqual({
        pending: false,
        outcome: "cancelled",
        requestId: opened.requestId,
      });

      // …the durable resolution IS in the database, written by the sink itself —
      // the half that was missing…
      const outcomes = yield* resolvedOutcomes(INCIDENT_THREAD);
      expect(outcomes).toContainEqual({ requestId: opened.requestId, outcome: "cancelled" });
      // …the shell count is clear, which is the state that stayed stuck at 1…
      assert.strictEqual(yield* pendingCount(INCIDENT_THREAD), 0);
      // …and the tag discriminates D1's two mechanisms, which the forensic log
      // could not (queue-shutdown here, since an emitter was registered).
      expect(sinkTags).toEqual(["pi-queue-shutdown-cancel"]);

      unregisterEmitter();
      unregisterSink();
    }),
  );

  // The sink is a backstop; a backstop that throws when nothing is listening is
  // not one. (A process-exit handler firing after shutdown has no sink.)
  it.effect("never throws when no settlement sink is registered, and says so loudly", () =>
    Effect.gen(function* () {
      const reported: Array<string> = [];
      const unregisterReporter = registerUserInputSettlementReporter((message) => {
        reported.push(message);
      });

      // A backstop that throws is not one — but a backstop that reports success
      // while persisting nothing is worse. This is the case the forensic audit
      // could not distinguish from success.
      const report = yield* Effect.promise(() =>
        settleUserInputRequestsDurably({
          threadId: INCIDENT_THREAD,
          resolutions: [{ requestId: "orphan", outcome: "cancelled" }],
          tag: "no-sink",
        }),
      );
      expect(report).toEqual({ persisted: 0, failed: 1 });
      expect(reported).toHaveLength(1);
      expect(reported[0]).toContain("NOT persisted");
      expect(reported[0]).toContain("orphan:cancelled");

      unregisterReporter();
    }),
  );

  // A sink that rejects must be reported as unpersisted, not swallowed: a
  // transient command-path failure reproduces incident 1 exactly (canonical
  // cancellation, no durable resolution), so it must never read as done.
  it.effect("reports a rejecting sink as unpersisted rather than swallowing it", () =>
    Effect.gen(function* () {
      const reported: Array<string> = [];
      const unregisterReporter = registerUserInputSettlementReporter((message) => {
        reported.push(message);
      });
      const unregisterSink = registerUserInputSettlementSink(() =>
        Promise.reject(new Error("engine queue closed")),
      );

      const report = yield* Effect.promise(() =>
        settleUserInputRequestsDurably({
          threadId: INCIDENT_THREAD,
          resolutions: [{ requestId: "rejected-write", outcome: "cancelled" }],
          tag: "sink-rejects",
        }),
      );
      expect(report).toEqual({ persisted: 0, failed: 1 });
      expect(reported[0]).toContain("engine queue closed");

      unregisterSink();
      unregisterReporter();
    }),
  );

  // The dispatch helper's own contract: `persisted` counts CONFIRMED writes, so a
  // caller (the startup scan) cannot log success over a still-wedged thread.
  // The dispatch helper's own contract: `persisted` counts CONFIRMED writes, so a
  // caller (the startup scan) cannot log success over a still-wedged thread. The
  // effect is run against the default (real-clock) runtime because the retry
  // backoff sleeps, and the layer's test clock never advances them.
  it.effect("counts only confirmed writes when the command path keeps failing", () =>
    Effect.gen(function* () {
      const attempts: Array<string> = [];
      const report = yield* Effect.promise(() =>
        Effect.runPromise(
          dispatchUserInputResolutions({
            dispatch: () =>
              Effect.sync(() => attempts.push("try")).pipe(
                Effect.andThen(
                  Effect.fail(
                    new OrchestrationCommandInvariantError({
                      commandType: "thread.activity.append",
                      detail: "command rejected",
                    }),
                  ),
                ),
              ),
            newId: Effect.succeed("act-never-persisted"),
            threadId: INCIDENT_THREAD,
            resolutions: [{ requestId: "never-persisted", outcome: "cancelled" }],
            createdAt: AT,
            tag: "always-fails",
          }),
        ),
      );
      expect(report).toEqual({ persisted: 0, failed: 1 });
      // It really did retry before giving up, rather than failing once quietly.
      expect(attempts.length).toBeGreaterThan(1);
    }),
  );

  // EXACTLY-ONCE under an ambiguous commit-then-error. The resolution id is
  // allocated ONCE, outside the retry, so a retry after a write that actually
  // landed reuses the same command id and the engine's receipt makes it a no-op.
  // Generating the id inside the retry (as it originally was, despite a comment
  // claiming otherwise) gave every attempt a fresh id and wrote duplicate terminal
  // rows.
  it.effect("reuses one id across retries so an ambiguous commit cannot duplicate", () =>
    Effect.gen(function* () {
      const dispatched: Array<{ readonly commandId: string; readonly activityId: string }> = [];
      let attempts = 0;
      const report = yield* Effect.promise(() =>
        Effect.runPromise(
          dispatchUserInputResolutions({
            dispatch: (command) =>
              Effect.suspend(() => {
                attempts += 1;
                dispatched.push({
                  commandId: String(command.commandId),
                  activityId: String(command.activity.id),
                });
                // First attempt: the write lands, then the ack is lost (the
                // ambiguous case). The retry must be byte-identical.
                return attempts === 1
                  ? Effect.fail(
                      new OrchestrationCommandInvariantError({
                        commandType: "thread.activity.append",
                        detail: "ack lost",
                      }),
                    )
                  : Effect.void;
              }),
            // Deliberately id-per-call: if the helper allocated inside the retry,
            // the two attempts would differ and the assertion below would fail.
            newId: Effect.sync(() => `act-ambiguous-${attempts}`),
            threadId: INCIDENT_THREAD,
            resolutions: [{ requestId: "ambiguous-write", outcome: "cancelled" }],
            createdAt: AT,
            tag: "ambiguous",
          }),
        ),
      );

      expect(report).toEqual({ persisted: 1, failed: 0 });
      expect(dispatched).toHaveLength(2);
      // Identical ids ⇒ the engine's command receipt dedupes the retry, so the
      // second attempt cannot write a second terminal row.
      expect(dispatched[0]).toEqual(dispatched[1]);
    }),
  );

  // THE FOLD INVARIANT, as a genuine truncate-and-rebuild. Every pathological
  // ordering the audit named: exact duplicates, distinct-id duplicates for one
  // requestId, resolved-before-requested, and a late requested after terminal
  // resolution. Terminal-wins means the rebuilt count is identical to the live
  // count in all of them — the old ordered add/delete set failed exactly here.
  it.effect("rebuilds the same count from pathological orderings (terminal-wins)", () =>
    Effect.gen(function* () {
      const append = yield* seedThread(REPLAY_THREAD);
      const sql = yield* SqlClient.SqlClient;
      const pipeline = yield* OrchestrationProjectionPipeline;

      // req-a: requested twice with distinct activity ids, then resolved, then
      // requested AGAIN with a newer id and a later timestamp.
      yield* append(
        requestedActivityEvent({
          threadId: REPLAY_THREAD,
          activityId: "act-a1",
          requestId: "req-a",
          createdAt: "2026-07-27T00:00:01.000Z",
        }),
      );
      yield* append(
        requestedActivityEvent({
          threadId: REPLAY_THREAD,
          activityId: "act-a2",
          requestId: "req-a",
          createdAt: "2026-07-27T00:00:02.000Z",
        }),
      );
      yield* append(
        resolvedActivityEvent({
          threadId: REPLAY_THREAD,
          activityId: "act-a-resolved",
          requestId: "req-a",
          outcome: "dismissed",
          createdAt: "2026-07-27T00:00:03.000Z",
        }),
      );
      yield* append(
        requestedActivityEvent({
          threadId: REPLAY_THREAD,
          activityId: "act-a3-late",
          requestId: "req-a",
          createdAt: "2026-07-27T00:00:04.000Z",
        }),
      );

      // req-b: resolved BEFORE requested (out-of-order ingestion).
      yield* append(
        resolvedActivityEvent({
          threadId: REPLAY_THREAD,
          activityId: "act-b-resolved",
          requestId: "req-b",
          outcome: "cancelled",
          createdAt: "2026-07-27T00:00:05.000Z",
        }),
      );
      yield* append(
        requestedActivityEvent({
          threadId: REPLAY_THREAD,
          activityId: "act-b1",
          requestId: "req-b",
          createdAt: "2026-07-27T00:00:06.000Z",
        }),
      );

      // req-c: genuinely open, and requested twice.
      yield* append(
        requestedActivityEvent({
          threadId: REPLAY_THREAD,
          activityId: "act-c1",
          requestId: "req-c",
          createdAt: "2026-07-27T00:00:07.000Z",
        }),
      );
      yield* append(
        requestedActivityEvent({
          threadId: REPLAY_THREAD,
          activityId: "act-c2",
          requestId: "req-c",
          createdAt: "2026-07-27T00:00:08.000Z",
        }),
      );

      // Exactly one request (req-c) is open under terminal-wins.
      const liveCount = yield* pendingCount(REPLAY_THREAD);
      assert.strictEqual(liveCount, 1);

      // Truncate every projection row AND the projector cursors, then rebuild
      // from the event store alone. This is the case a code change to the fold
      // never revisits in production, and the case the migration exists for.
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_state`;
      yield* pipeline.bootstrap;

      const rebuiltCount = yield* pendingCount(REPLAY_THREAD);
      assert.strictEqual(rebuiltCount, liveCount);

      // And the projector cursors advanced, i.e. this really was a rebuild.
      const cursors = yield* sql<{ readonly projector: string }>`
        SELECT projector FROM projection_state WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.threads}
      `;
      assert.strictEqual(cursors.length, 1);
    }),
  );
});

// The predicate that decides "expected echo" vs "real failure". It is the whole
// safety of the ingestion catch: anything it wrongly matches is a resolution
// dropped as if it were a duplicate — present in the log, absent from the
// database, which is incident 1.
describe("already-settled rejection predicate", () => {
  it("matches only the decider's first-terminal-wins rejection", () => {
    expect(
      isAlreadySettledRejection(
        new OrchestrationCommandInvariantError({
          commandType: "thread.activity.append",
          detail: `User-input request 'req-1' on thread 'thread-1' ${ALREADY_SETTLED_REJECTION_MARKER}.`,
        }),
      ),
    ).toBe(true);
  });

  it("rejects every other failure, so a real one can never be swallowed", () => {
    // A DIFFERENT invariant failure from the same command type.
    expect(
      isAlreadySettledRejection(
        new OrchestrationCommandInvariantError({
          commandType: "thread.activity.append",
          detail: "Thread 'thread-1' does not exist.",
        }),
      ),
    ).toBe(false);
    // A transient persistence/engine failure — the case that must PROPAGATE.
    expect(
      isAlreadySettledRejection({ _tag: "PersistenceSqlError", message: "db is locked" }),
    ).toBe(false);
    // Prose that merely mentions settlement, from something that is not the
    // decider's typed rejection.
    expect(isAlreadySettledRejection({ message: ALREADY_SETTLED_REJECTION_MARKER })).toBe(false);
    expect(isAlreadySettledRejection(new Error(ALREADY_SETTLED_REJECTION_MARKER))).toBe(false);
    expect(isAlreadySettledRejection(null)).toBe(false);
    expect(isAlreadySettledRejection(undefined)).toBe(false);
  });
});

describe("user-input resolved activity shape", () => {
  // The one definition of the durable row, shared by all three settlement layers,
  // so a resolution written by the runtime, by the session-exit rule, and by the
  // startup scan are indistinguishable to the fold and to every client.
  it("stamps an explicit outcome on every settlement", () => {
    for (const outcome of ["answered", "dismissed", "superseded", "cancelled"] as const) {
      const activity = userInputResolvedActivity({
        activityId: EventId.make(`act-${outcome}`),
        resolution: { requestId: "req", outcome },
        turnId: null,
        createdAt: AT,
      });
      expect(activity.kind).toBe("user-input.resolved");
      expect(activity.payload).toMatchObject({ requestId: "req", outcome, answers: {} });
    }
  });

  it("omits requestId when the emitter carried none, so the fold ignores the row", () => {
    const activity = userInputResolvedActivity({
      activityId: EventId.make("act-no-request"),
      resolution: { requestId: undefined, outcome: "answered" },
      turnId: null,
      createdAt: AT,
    });
    expect(activity.payload).not.toHaveProperty("requestId");
  });
});
