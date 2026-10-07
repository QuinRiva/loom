/**
 * t-zero (plan §2 Receipts): a Loom set-style command that changes nothing
 * emits nothing and is accepted with a receipt at the thread's latest sequence,
 * so a re-driven repeat costs nothing and is never a rejection.
 */
import { assert, it } from "@effect/vitest";
import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  dispatch,
  LoomOrchestratorTestLayer,
  seedThread,
  spawnChild,
} from "../loom/testkit/loomOrchestratorLayer.ts";
import { CommandReceiptStoreV2 } from "./CommandReceiptStore.ts";
import { EventSinkV2 } from "./EventSink.ts";

it.layer(LoomOrchestratorTestLayer)("Loom zero-event receipts", (it) => {
  it.effect("t-zero: a standing raise and an unchanged held.set are accepted no-ops", () =>
    Effect.gen(function* () {
      const receipts = yield* CommandReceiptStoreV2;
      const sink = yield* EventSinkV2;
      const parent = ThreadId.make("zero-parent");
      const child = ThreadId.make("zero-child");
      yield* seedThread({ threadId: parent });
      yield* spawnChild({ parentThreadId: parent, threadId: child, graphKey: "child" });
      const raise = (commandId: string) =>
        dispatch({
          type: "thread.attention.raise",
          commandId: CommandId.make(commandId),
          threadId: child,
          createdAt: "2026-01-01T00:00:00.000Z",
          reason: "needs_guidance",
        });
      assert.equal((yield* raise("raise-1")).storedEvents.length, 1);

      for (const result of [
        { id: "raise-2", outcome: yield* raise("raise-2") },
        {
          id: "held-unchanged",
          outcome: yield* dispatch({
            type: "thread.held.set",
            commandId: CommandId.make("held-unchanged"),
            threadId: child,
            createdAt: "2026-01-01T00:00:00.000Z",
            held: false,
          }),
        },
      ]) {
        assert.deepEqual(result.outcome.storedEvents, []);
        const receipt = Option.getOrThrow(
          yield* receipts.getByCommandId(CommandId.make(result.id)),
        );
        assert.equal(receipt.status, "accepted");
        assert.equal(receipt.threadId, child);
        assert.equal(receipt.resultSequence, yield* sink.latestSequence({ threadId: child }));
        assert.equal(result.outcome.sequence, receipt.resultSequence);
      }
    }),
  );
});
