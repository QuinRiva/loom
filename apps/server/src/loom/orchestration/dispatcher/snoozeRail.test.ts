/**
 * The tool only records the request; the pass applies `thread.snooze` once the asking turn ended
 * idle, and a later inbound message un-snoozes. A pending question or Loom attention flag drops
 * the request; `cancel` withdraws it.
 */
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import {
  callAs,
  HandlerTestLayer,
} from "../../../mcp/toolkits/workstream/handlers/handlers.testkit.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import { isSnoozed } from "../../../orchestration-v2/ThreadSettlementService.ts";
import { LoomStoreV2 } from "../../projection/LoomStore.ts";
import {
  completeSeededRun,
  dispatch,
  seededRunIds,
  seedRunningRun,
  seedThread,
  writeEvents,
} from "../../testkit/loomOrchestratorLayer.ts";
import { WorkstreamDispatcher, WorkstreamDispatcherLive } from "./WorkstreamDispatcher.ts";

const TestLayer = WorkstreamDispatcherLive.pipe(Layer.provideMerge(HandlerTestLayer));

const runPass = Effect.flatMap(WorkstreamDispatcher, (d) => d.runPass);
const tick = TestClock.adjust("1 second");
/** An ISO `until` `days` from the test clock's now. */
const inDays = (days: number) =>
  Effect.map(DateTime.now, (now) =>
    DateTime.formatIso(DateTime.add(now, { milliseconds: days * 24 * 60 * 60 * 1000 })),
  );
const shell = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (o) =>
    Effect.map(o.getThreadShell(threadId), (s) => s!),
  );
const snoozed = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const s = yield* shell(threadId);
    return isSnoozed(
      {
        ...s,
        snoozedUntil: s.snoozedUntil ?? null,
        snoozedAt: s.snoozedAt ?? null,
        latestRunCompletedAt: s.latestRunCompletedAt ?? null,
      },
      DateTime.toEpochMillis(yield* DateTime.now),
    );
  });
const pending = (threadId: ThreadId) =>
  Effect.flatMap(LoomStoreV2, (store) =>
    Effect.map(store.snoozeRequests.list, (all) => all.filter((r) => r.threadId === threadId)),
  );
let wakes = 0;
/** An inbound message, as a pull-request watch wake sends it. */
const wake = (threadId: ThreadId) =>
  dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`snooze-wake:${++wakes}`),
    threadId,
    messageId: MessageId.make(`message:snooze-wake:${wakes}`),
    text: "A check failed on the watched pull request.",
    attachments: [],
    createdBy: "agent",
    creationSource: "server",
    dispatchMode: { type: "queue_after_active" },
  });

/** A root mid-turn (a running run), ready to call the tool. */
const midTurn = Effect.fn("snoozeRailTest.midTurn")(function* (name: string) {
  const threadId = ThreadId.make(`snooze-${name}`);
  yield* seedThread({ threadId, role: "orchestrator" });
  yield* seedRunningRun({ threadId });
  yield* tick;
  return threadId;
});

const endTurn = (threadId: ThreadId) =>
  tick.pipe(Effect.andThen(completeSeededRun({ threadId })), Effect.andThen(tick));

it.layer(TestLayer)("snooze_thread and the snooze rail", (it) => {
  it.effect("validates until", () =>
    Effect.gen(function* () {
      const threadId = yield* midTurn("validate");
      for (const payload of [
        {},
        { until: "next tuesday" },
        { until: yield* inDays(-1) },
        { until: yield* inDays(31) },
      ]) {
        const result = yield* callAs(threadId, "snooze_thread", payload);
        assert.isTrue(result.isError, JSON.stringify(payload));
      }
      assert.isEmpty(yield* pending(threadId));
    }),
  );

  it.effect("applies once the turn ends idle; a message afterwards un-snoozes", () =>
    Effect.gen(function* () {
      const threadId = yield* midTurn("apply");
      yield* callAs(threadId, "snooze_thread", { until: yield* inDays(9) });
      const wakeAt = yield* inDays(2.5);
      const result = yield* callAs(threadId, "snooze_thread", { until: wakeAt }); // last call wins
      assert.isFalse(result.isError, result.text);
      assert.include(result.text, `until ${wakeAt},`);

      yield* runPass; // still running: the request waits
      assert.isFalse(yield* snoozed(threadId));
      assert.lengthOf(yield* pending(threadId), 1);

      yield* endTurn(threadId);
      yield* runPass;
      assert.isTrue(yield* snoozed(threadId));
      assert.equal(DateTime.formatIso((yield* shell(threadId)).snoozedUntil!), wakeAt);
      assert.isEmpty(yield* pending(threadId));

      yield* tick;
      yield* wake(threadId);
      assert.isFalse(yield* snoozed(threadId));
      assert.isNull((yield* shell(threadId)).snoozedUntil ?? null);
    }),
  );

  it.effect("a wake landing before the turn's end drops the request", () =>
    Effect.gen(function* () {
      const threadId = yield* midTurn("raced");
      yield* callAs(threadId, "snooze_thread", { until: yield* inDays(1) });
      yield* tick;
      yield* wake(threadId); // queued behind the running turn
      yield* endTurn(threadId);
      yield* runPass;
      assert.isFalse(yield* snoozed(threadId));
      assert.isEmpty(yield* pending(threadId));
    }),
  );

  it.effect("cancel withdraws the request", () =>
    Effect.gen(function* () {
      const threadId = yield* midTurn("cancel");
      yield* callAs(threadId, "snooze_thread", { until: yield* inDays(1) });
      const result = yield* callAs(threadId, "snooze_thread", { cancel: true });
      assert.match(result.text, /^Withdrew/);
      assert.isEmpty(yield* pending(threadId));
      yield* endTurn(threadId);
      yield* runPass;
      assert.isFalse(yield* snoozed(threadId));
      assert.match(
        (yield* callAs(threadId, "snooze_thread", { cancel: true })).text,
        /no snooze request/,
      );
    }),
  );

  it.effect("an attention flag at the end of the turn drops the request", () =>
    Effect.gen(function* () {
      const threadId = yield* midTurn("attention");
      yield* callAs(threadId, "snooze_thread", { until: yield* inDays(1) });
      yield* dispatch({
        type: "thread.attention.raise",
        commandId: CommandId.make("snooze-attention:raise"),
        threadId,
        createdAt: DateTime.formatIso(yield* DateTime.now),
        reason: "needs_guidance",
      });
      yield* endTurn(threadId);
      yield* runPass;
      assert.isFalse(yield* snoozed(threadId));
      assert.isEmpty(yield* pending(threadId));
    }),
  );

  it.effect("a pending question drops the request, even mid-turn", () =>
    Effect.gen(function* () {
      const threadId = yield* midTurn("question");
      yield* callAs(threadId, "snooze_thread", { until: yield* inDays(1) });
      const now = yield* DateTime.now;
      const ids = seededRunIds(threadId);
      yield* writeEvents([
        {
          id: EventId.make("event:snooze-question"),
          type: "runtime-request.updated",
          threadId,
          runId: ids.runId,
          occurredAt: now,
          payload: {
            id: RuntimeRequestId.make(`request:${threadId}`),
            nodeId: ids.nodeId,
            providerTurnId: ids.providerTurnId,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability: { type: "message" },
            createdAt: now,
            resolvedAt: null,
          },
        } as unknown as OrchestrationV2DomainEvent,
      ]);
      yield* runPass;
      assert.isEmpty(yield* pending(threadId));
      yield* endTurn(threadId);
      yield* runPass;
      assert.isFalse(yield* snoozed(threadId));
    }),
  );
});
