/**
 * t-attention (plan §2 rule 4, D19, DL-194, DL-195): a stored hold survives
 * every non-human turn and clears only when a human's or the parent's turn
 * starts, or an outcome is written. Also rule 0 (a continuation of a thread
 * that is not continued is an accepted no-op) and the server-side
 * `humanAuthored` stamp.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type LoomAttentionReason,
  MessageId,
  RunId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { LoomStoreV2 } from "../loom/projection/LoomStore.ts";
import {
  awaitStoredEvent,
  completeSeededRun,
  dispatch,
  LoomOrchestratorTestLayer,
  loomEvent,
  seededRunIds,
  seedRunningRun,
  seedThread,
  spawnChild,
  writeEvents,
} from "../loom/testkit/loomOrchestratorLayer.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { isHumanAuthored, loomMessageFields } from "./Orchestrator.loom.ts";
import * as Orchestrator from "./Orchestrator.ts";

const createdAt = "2026-01-01T00:00:00.000Z";
const parent = ThreadId.make("attention-parent");

const child = Effect.fn("test.child")(function* (name: string) {
  const threadId = ThreadId.make(`attention-${name}`);
  yield* spawnChild({ parentThreadId: parent, threadId, graphKey: name });
  return threadId;
});
const raise = (threadId: ThreadId, reason: LoomAttentionReason = "awaiting_acceptance") =>
  dispatch({
    type: "thread.attention.raise",
    commandId: CommandId.make(`test-raise:${threadId}:${reason}`),
    threadId,
    createdAt,
    reason,
  });
const attentionOf = Effect.fn("test.attentionOf")(function* (threadId: ThreadId) {
  const store = yield* LoomStoreV2;
  return (yield* store.getWorkstream(threadId))!.attention;
});

type MessageOverrides = Partial<
  Omit<Parameters<typeof dispatch>[0] & { readonly type: "message.dispatch" }, "type">
>;
let messageCounter = 0;
const message = (threadId: ThreadId, overrides: MessageOverrides = {}) => {
  const id = ++messageCounter;
  return dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`test-message:${id}`),
    threadId,
    messageId: MessageId.make(`message:attention:${id}`),
    text: `Message ${id}`,
    attachments: [],
    createdBy: "agent",
    creationSource: "server",
    dispatchMode: { type: "queue_after_active" },
    ...overrides,
  });
};

describe("pure predicates", () => {
  it("isHumanAuthored: upstream's limit-resume is not human; a composer send is", () => {
    assert.isTrue(isHumanAuthored({ createdBy: "user", usageLimitContinuationOfRunId: undefined }));
    assert.isFalse(
      isHumanAuthored({ createdBy: "user", usageLimitContinuationOfRunId: RunId.make("run:1") }),
    );
    assert.isFalse(
      isHumanAuthored({ createdBy: "agent", usageLimitContinuationOfRunId: undefined }),
    );
    // DL-245: a scheduled-task fire carries the task's createdBy (normally user) and is automation.
    assert.isFalse(
      isHumanAuthored({
        createdBy: "user",
        usageLimitContinuationOfRunId: undefined,
        scheduledTaskId: ScheduledTaskId.make("scheduled-task:nightly"),
      }),
    );
  });

  it("loomMessageFields overwrites a client-sent humanAuthored", () => {
    assert.deepEqual(
      loomMessageFields({
        createdBy: "agent",
        usageLimitContinuationOfRunId: undefined,
        loom: { humanAuthored: true },
      }),
      { humanAuthored: false },
    );
  });
});

it.layer(LoomOrchestratorTestLayer)("Loom attention holds", (it) => {
  it.effect(
    "t-attention: notify and control_notice turns keep the hold; the parent's prompt clears it",
    () =>
      Effect.gen(function* () {
        yield* seedThread({ threadId: parent });
        const held = yield* child("holds");
        yield* raise(held);
        yield* message(held, { loom: { origin: "notify" }, senderThreadId: parent });
        assert.deepEqual(yield* attentionOf(held), ["awaiting_acceptance"]);
        yield* message(held, { loom: { origin: "control_notice" } }); // queued behind the notify turn
        assert.deepEqual(yield* attentionOf(held), ["awaiting_acceptance"]);

        const prompted = yield* child("prompted");
        yield* raise(prompted);
        yield* message(prompted, { loom: { origin: "orchestrator" }, senderThreadId: parent });
        assert.deepEqual(yield* attentionOf(prompted), []);
      }),
  );

  it.effect(
    "t-attention: a human message queued behind a running turn clears only when it starts",
    () =>
      Effect.gen(function* () {
        const sink = yield* EventSinkV2;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const queued = yield* child("queued");
        yield* raise(queued);
        yield* seedRunningRun({ threadId: queued });
        const messageId = MessageId.make("message:attention:queued-human");
        yield* message(queued, { createdBy: "user", creationSource: "web", messageId });
        assert.deepEqual(yield* attentionOf(queued), ["awaiting_acceptance"]);
        const queuedRun = (yield* orchestrator.getThreadProjection(queued)).runs.find(
          (run) => run.userMessageId === messageId,
        )!;
        assert.equal(queuedRun.status, "queued");

        const before = yield* sink.latestSequence();
        yield* completeSeededRun({ threadId: queued });
        yield* awaitStoredEvent({
          afterSequence: before,
          threadId: queued,
          predicate: (event) => event.type === "thread.attention-cleared",
        });
        assert.deepEqual(yield* attentionOf(queued), []);
        const started = (yield* orchestrator.getThreadProjection(queued)).runs.find(
          (run) => run.id === queuedRun.id,
        )!;
        assert.equal(started.status, "starting");
      }),
  );

  it.effect("t-attention: every outcome write clears, including a reopen to null", () =>
    Effect.gen(function* () {
      const reopened = yield* child("reopened");
      const setOutcome = (outcome: "done" | null, id: string) =>
        dispatch({
          type: "thread.outcome.set",
          commandId: CommandId.make(id),
          threadId: reopened,
          createdAt,
          outcome,
        });
      yield* setOutcome("done", "outcome-done");
      // A hold on a finished thread cannot be raised by command; seed it as an event.
      yield* writeEvents([
        yield* loomEvent("thread.attention-raised", reopened, { reason: "awaiting_acceptance" }),
      ]);
      assert.deepEqual(yield* attentionOf(reopened), ["awaiting_acceptance"]);
      yield* setOutcome(null, "outcome-reopen");
      assert.deepEqual(yield* attentionOf(reopened), []);
    }),
  );

  it.effect(
    "a composer message clears; an agent's forged humanAuthored is overwritten and clears nothing",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const composed = yield* child("composed");
        yield* raise(composed);
        yield* message(composed, { createdBy: "user", creationSource: "web" });
        assert.deepEqual(yield* attentionOf(composed), []);

        const forged = yield* child("forged");
        yield* raise(forged);
        const messageId = MessageId.make("message:attention:forged");
        yield* message(forged, { loom: { humanAuthored: true }, messageId });
        assert.deepEqual(yield* attentionOf(forged), ["awaiting_acceptance"]);
        const stored = (yield* orchestrator.getThreadProjection(forged)).messages.find(
          (entry) => entry.id === messageId,
        )!;
        assert.isFalse(stored.loom?.humanAuthored);
      }),
  );

  it.effect(
    "an upstream limit-resume (createdBy user + continuation) keeps the hold and no-ops on a done thread",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const limitResume = (threadId: ThreadId) =>
          message(threadId, {
            createdBy: "user",
            creationSource: "web",
            dispatchMode: { type: "start_immediately" },
            usageLimitContinuationOfRunId: RunId.make(`run:${threadId}:limited`),
            usageLimitRecoveryRequestId: CommandId.make(`limit:${threadId}`),
          });
        const holding = yield* child("limit-holding");
        yield* raise(holding);
        const accepted = yield* limitResume(holding);
        assert.deepEqual(
          accepted.storedEvents.map((stored) => stored.event.type),
          ["thread.metadata-updated"],
        );
        assert.deepEqual(yield* attentionOf(holding), ["awaiting_acceptance"]);

        const done = yield* child("limit-done");
        yield* dispatch({
          type: "thread.outcome.set",
          commandId: CommandId.make("limit-done"),
          threadId: done,
          createdAt,
          outcome: "done",
        });
        const noOp = yield* limitResume(done);
        assert.deepEqual(
          noOp.storedEvents.map((stored) => stored.event.type),
          ["thread.metadata-updated"],
        );
        assert.deepEqual((yield* orchestrator.getThreadProjection(done)).runs, []);
      }),
  );

  it.effect(
    "rule 0: a restart continuation upstream would accept is vetoed on a done Loom thread",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const cutTurn = Effect.fn("test.cutTurn")(function* (threadId: ThreadId) {
          yield* seedRunningRun({ threadId });
          const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
          yield* writeEvents([
            {
              id: EventId.make(`event:test-cut:${threadId}`),
              type: "run.updated",
              threadId,
              runId: run.id,
              occurredAt: yield* DateTime.now,
              payload: { ...run, status: "cancelled", completedAt: yield* DateTime.now },
            },
          ]);
          return yield* message(threadId, {
            dispatchMode: { type: "start_immediately" },
            restartContinuationOfRunId: seededRunIds(threadId).runId,
          });
        });

        const done = yield* child("restart-done");
        yield* dispatch({
          type: "thread.outcome.set",
          commandId: CommandId.make("restart-done"),
          threadId: done,
          createdAt,
          outcome: "done",
        });
        const vetoed = yield* cutTurn(done);
        assert.deepEqual(
          vetoed.storedEvents.map((stored) => stored.event.type),
          ["thread.metadata-updated"],
        );
        assert.equal((yield* orchestrator.getThreadProjection(done)).runs.length, 1);

        const live = yield* child("restart-live");
        yield* cutTurn(live);
        assert.equal((yield* orchestrator.getThreadProjection(live)).runs.length, 2);
      }),
  );
  it.effect(
    "DL-245: a scheduled-task fire into a held, flagged thread keeps the hold, stays held, and starts as `other`",
    () =>
      Effect.gen(function* () {
        const scheduled = ThreadId.make("attention-scheduled");
        yield* spawnChild({
          parentThreadId: parent,
          threadId: scheduled,
          graphKey: "scheduled",
          held: true,
        });
        yield* raise(scheduled);
        const fired = yield* message(scheduled, {
          createdBy: "user",
          creationSource: "web",
          scheduledTaskId: ScheduledTaskId.make("scheduled-task:nightly"),
        });
        const row = (yield* (yield* LoomStoreV2).getWorkstream(scheduled))!;
        assert.deepEqual(row.attention, ["awaiting_acceptance"]);
        assert.isTrue(row.held);
        const kickoff = fired.storedEvents.find(
          (stored) => stored.event.type === "thread.kickoff-recorded",
        )?.event;
        assert.equal(
          kickoff?.type === "thread.kickoff-recorded" && kickoff.payload.origin,
          "other",
        );
      }),
  );

  it.effect(
    "a human stop raises needs_guidance on run.interrupt and thread.stop; a server: stop does not",
    () =>
      Effect.gen(function* () {
        // The web Stop button: run.interrupt with holdQueue on the running run.
        const stopped = yield* child("stop-interrupt");
        yield* seedRunningRun({ threadId: stopped, live: true });
        yield* dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("stop-interrupt"),
          threadId: stopped,
          runId: seededRunIds(stopped).runId,
          holdQueue: true,
        });
        assert.deepEqual(yield* attentionOf(stopped), ["needs_guidance"]);

        // thread.stop with nothing running: upstream's accepted no-op, so the raise is
        // the only event and the command is receipted on it.
        const idle = yield* child("stop-thread-idle");
        const accepted = yield* dispatch({
          type: "thread.stop",
          commandId: CommandId.make("stop-thread-idle"),
          threadId: idle,
        });
        assert.deepEqual(
          accepted.storedEvents.map((stored) => stored.event.type),
          ["thread.attention-raised"],
        );
        assert.deepEqual(yield* attentionOf(idle), ["needs_guidance"]);

        const serverStopped = yield* child("stop-thread-server");
        const noOp = yield* dispatch({
          type: "thread.stop",
          commandId: CommandId.make("server:stop-thread-server"),
          threadId: serverStopped,
        });
        assert.deepEqual(noOp.storedEvents, []);
        assert.deepEqual(yield* attentionOf(serverStopped), []);
      }),
  );
});
