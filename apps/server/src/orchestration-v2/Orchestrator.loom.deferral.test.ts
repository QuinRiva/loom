/**
 * The three sanctioned deferral sites (plan §3, D15, DL-197) on the real
 * engine: a deferral leaves no events and no receipt, and the SAME command id
 * is accepted once the blocking run ends (t-defer, t-redrive-defer, fork.prepare).
 */
import { assert, it } from "@effect/vitest";
import { CommandId, ContextTransferId, EventId, MessageId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  completeSeededRun,
  dispatch,
  LoomOrchestratorTestLayer,
  loomEvent,
  seededRunIds,
  seedRunningRun,
  seedThread,
  spawnChild,
  testDriver,
  testModelSelection,
  writeEvents,
} from "../loom/testkit/loomOrchestratorLayer.ts";
import { CommandReceiptStoreV2 } from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";

const receiptOf = Effect.fn("test.receiptOf")(function* (commandId: CommandId) {
  const receipts = yield* CommandReceiptStoreV2;
  return yield* receipts.getByCommandId(commandId);
});

const expectDeferred = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(effect);
    assert.equal(error._tag, "LoomDispatchDeferredError");
  });

it.layer(LoomOrchestratorTestLayer)("Loom deferral sites", (it) => {
  it.effect("t-defer: start_if_idle defers on a busy target without a receipt, then starts", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("defer-target");
      yield* seedThread({ threadId });
      yield* seedRunningRun({ threadId });
      const command = {
        type: "message.dispatch",
        commandId: CommandId.make("server:loom:digest:defer-target:1"),
        threadId,
        messageId: MessageId.make("message:defer-digest"),
        text: "Two sub-threads finished.",
        attachments: [],
        createdBy: "agent",
        creationSource: "server",
        dispatchMode: { type: "start_if_idle" },
        loom: { origin: "control_notice" },
        notification: {
          source: { kind: "background_task" },
          outcome: "completed",
          summary: "Two sub-threads finished",
        },
      } as const;

      yield* expectDeferred(dispatch(command));
      assert.isTrue(Option.isNone(yield* receiptOf(command.commandId)));
      const busy = yield* orchestrator.getThreadProjection(threadId);
      assert.isUndefined(busy.messages.find((message) => message.id === command.messageId));

      yield* completeSeededRun({ threadId });
      const accepted = yield* dispatch(command);
      assert.isAbove(accepted.storedEvents.length, 0);
      const receipt = yield* receiptOf(command.commandId);
      assert.equal(Option.getOrThrow(receipt).status, "accepted");
      const idle = yield* orchestrator.getThreadProjection(threadId);
      const message = idle.messages.find((entry) => entry.id === command.messageId)!;
      assert.equal(message.notification?.summary, "Two sub-threads finished");
      assert.equal(message.loom?.origin, "control_notice");
      assert.isFalse(message.loom?.humanAuthored);
      const run = idle.runs.find((entry) => entry.userMessageId === command.messageId)!;
      assert.include(["starting", "preparing"], run.status);
    }),
  );

  it.effect(
    "t-redrive-defer: a gate leg behind a running run with a pending merge-back defers, then lands",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const parent = ThreadId.make("gate-parent");
        const coder = ThreadId.make("gate-coder");
        const reviewer = ThreadId.make("gate-reviewer");
        const fork = ThreadId.make("gate-fork");
        yield* seedThread({ threadId: parent });
        yield* spawnChild({ parentThreadId: parent, threadId: coder, graphKey: "coder" });
        yield* spawnChild({
          parentThreadId: parent,
          threadId: reviewer,
          graphKey: "reviewer",
          role: "reviewer",
          blockedBy: [coder],
          routes: [{ on: ["needs_rework"], kind: "loop", to: coder }],
        });
        const routeEventId = EventId.make("event:test-route:gate-reviewer:1");
        yield* writeEvents([
          yield* loomEvent(
            "thread.route-taken",
            reviewer,
            { to: coder, round: 1, kind: "loop" },
            { id: routeEventId },
          ),
        ]);
        // The coder is mid-turn and owes a merge-back from a finished fork.
        yield* seedThread({ threadId: fork });
        yield* seedRunningRun({ threadId: fork });
        yield* completeSeededRun({ threadId: fork });
        yield* seedRunningRun({ threadId: coder });
        const now = yield* DateTime.now;
        yield* writeEvents([
          {
            id: EventId.make("event:test-merge-back:gate-coder"),
            type: "context-transfer.created",
            threadId: coder,
            occurredAt: now,
            payload: {
              id: ContextTransferId.make("context-transfer:test-merge-back"),
              type: "merge_back",
              sourceThreadId: fork,
              targetThreadId: coder,
              sourcePoint: { threadId: fork, runId: seededRunIds(fork).runId },
              basePoint: null,
              sourceProviderInstanceId: testModelSelection.instanceId,
              targetProviderInstanceId: null,
              targetRunId: null,
              status: "pending",
              resolution: null,
              createdBy: "user",
              error: null,
              createdAt: now,
              updatedAt: now,
              consumedAt: null,
            },
          },
        ]);
        const command = {
          type: "thread.gate.rework",
          commandId: CommandId.make(`server:workstream-gate:${reviewer}:1:rework`),
          threadId: coder,
          createdAt: DateTime.formatIso(now),
          sourceThreadId: reviewer,
          round: 1,
          routeEventId,
          message: {
            messageId: MessageId.make("message:gate-rework:1"),
            text: "The reviewer asked for rework.",
            controlPayload: { kind: "notice", heading: "Rework requested", items: [] },
          },
        } as const;

        yield* expectDeferred(dispatch(command));
        assert.isTrue(Option.isNone(yield* receiptOf(command.commandId)));

        yield* completeSeededRun({ threadId: coder });
        yield* dispatch(command);
        assert.equal(Option.getOrThrow(yield* receiptOf(command.commandId)).status, "accepted");
        const projection = yield* orchestrator.getThreadProjection(coder);
        const message = projection.messages.find(
          (entry) => entry.id === command.message.messageId,
        )!;
        assert.equal(message.loom?.origin, "control_notice");
        assert.equal(message.notification?.summary, "Rework requested");
      }),
  );

  it.effect("thread.fork.prepare defers while the source runs, then writes the fork transfer", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const parent = ThreadId.make("fork-parent");
      const source = ThreadId.make("fork-source");
      const child = ThreadId.make("fork-child");
      yield* seedThread({ threadId: parent });
      yield* spawnChild({ parentThreadId: parent, threadId: source, graphKey: "source" });
      yield* spawnChild({
        parentThreadId: parent,
        threadId: child,
        graphKey: "fork",
        blockedBy: [source],
      });
      yield* seedRunningRun({ threadId: source });
      const prepare = (commandId: string) =>
        ({
          type: "thread.fork.prepare",
          commandId: CommandId.make(commandId),
          threadId: child,
          sourceThreadId: source,
          createdAt: "2026-01-01T00:00:00.000Z",
        }) as const;
      const command = prepare(`server:loom:fork-prepare:${child}`);

      yield* expectDeferred(dispatch(command));
      assert.isTrue(Option.isNone(yield* receiptOf(command.commandId)));

      yield* completeSeededRun({ threadId: source });
      yield* dispatch(command);
      const transfers = (yield* orchestrator.getThreadProjection(child)).contextTransfers;
      assert.equal(transfers.length, 1);
      const transfer = transfers[0]!;
      const ids = seededRunIds(source);
      assert.deepInclude(transfer, {
        type: "fork",
        sourceThreadId: source,
        targetThreadId: child,
        basePoint: null,
        sourceProviderInstanceId: testModelSelection.instanceId,
        targetProviderInstanceId: null,
        targetRunId: null,
        status: "pending",
        resolution: null,
        error: null,
        consumedAt: null,
      });
      assert.equal(transfer.sourcePoint.runId, ids.runId);
      assert.equal(transfer.sourcePoint.providerThreadRef?.strength, "strong");

      // A second prepare under another id is refused (receipted), not a second transfer.
      const again = yield* Effect.flip(dispatch(prepare("server:loom:fork-prepare:again")));
      assert.equal(again._tag, "OrchestratorDispatchError");
    }),
  );

  it.effect("thread.fork.prepare refuses a source without a strong native thread ref", () =>
    Effect.gen(function* () {
      const parent = ThreadId.make("weak-parent");
      const source = ThreadId.make("weak-source");
      const child = ThreadId.make("weak-child");
      yield* seedThread({ threadId: parent });
      yield* spawnChild({ parentThreadId: parent, threadId: source, graphKey: "source" });
      yield* spawnChild({ parentThreadId: parent, threadId: child, graphKey: "fork" });
      yield* seedRunningRun({ threadId: source });
      yield* completeSeededRun({ threadId: source });
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const providerThread = (yield* orchestrator.getThreadProjection(source)).providerThreads[0]!;
      yield* writeEvents([
        {
          id: EventId.make("event:test-weak-ref"),
          type: "provider-thread.updated",
          threadId: source,
          occurredAt: yield* DateTime.now,
          payload: {
            ...providerThread,
            nativeThreadRef: { driver: testDriver, nativeId: null, strength: "weak" },
          },
        },
      ]);
      const commandId = CommandId.make(`server:loom:fork-prepare:${child}`);
      const error = yield* Effect.flip(
        dispatch({
          type: "thread.fork.prepare",
          commandId,
          threadId: child,
          sourceThreadId: source,
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      assert.equal(error._tag, "OrchestratorDispatchError");
      assert.equal(Option.getOrThrow(yield* receiptOf(commandId)).status, "rejected");
    }),
  );
});
