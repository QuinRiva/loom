/**
 * Restart recovery for Loom threads (plan §3 table, w8; DL-195, DL-199): after
 * upstream's startup reconciliation holds every queued run, `releaseHeldQueues`
 * resumes a live thread's held control wake, leaves a thread owed a human
 * held (and rule 0 makes its continuation an accepted no-op), and cancels a
 * dead thread's queued runs — on the real orchestrator and recovery service.
 */
import { assert, it } from "@effect/vitest";
import { CommandId, type LoomMessageFields, MessageId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { CommandReceiptStoreV2 } from "../../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import { ProviderRuntimeRecoveryService } from "../../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import { continueRestartedRun } from "../../orchestration-v2/RestartContinuation.ts";
import * as ServerSettings from "../../serverSettings.ts";
import {
  dispatch,
  LoomOrchestratorTestLayer,
  seededRunIds,
  seedRunningRun,
  seedThread,
  spawnChild,
} from "../testkit/loomOrchestratorLayer.ts";
import { releaseHeldQueues } from "./loomRecoveryPolicy.ts";

const createdAt = "2026-01-01T00:00:00.000Z";
const parent = ThreadId.make("recovery-parent");

let queuedCount = 0;
/** A message queued behind the thread's running turn. */
const queueBehind = (threadId: ThreadId, from: "control" | "human") =>
  dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`recovery-queue:${++queuedCount}`),
    threadId,
    messageId: MessageId.make(`message:recovery-queue:${queuedCount}`),
    text: `Queued ${queuedCount}`,
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
    ...(from === "human"
      ? { createdBy: "user", creationSource: "web" }
      : {
          createdBy: "agent",
          creationSource: "server",
          loom: { origin: "control_notice" } satisfies LoomMessageFields,
        }),
  });

it.layer(LoomOrchestratorTestLayer)("Loom restart recovery", (it) => {
  it.effect("releaseHeldQueues applies the §3 table after upstream's reconciliation", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const receipts = yield* CommandReceiptStoreV2;
      const queuedRuns = (threadId: ThreadId) =>
        Effect.map(orchestrator.getThreadProjection(threadId), (projection) =>
          projection.runs.filter((run) => run.id !== seededRunIds(threadId).runId),
        );
      yield* seedThread({ threadId: parent });
      const child = Effect.fn("test.child")(function* (key: string) {
        const threadId = ThreadId.make(`recovery-${key}`);
        yield* spawnChild({ parentThreadId: parent, threadId, graphKey: key });
        return threadId;
      });

      // A live Loom thread with a control wake queued behind its turn.
      const live = yield* child("live");
      yield* seedRunningRun({ threadId: live });
      yield* queueBehind(live, "control");
      // A thread owed a human, with the same.
      const guided = yield* child("guided");
      yield* dispatch({
        type: "thread.attention.raise",
        commandId: CommandId.make("recovery-raise-guided"),
        threadId: guided,
        createdAt,
        reason: "needs_guidance",
      });
      yield* seedRunningRun({ threadId: guided });
      yield* queueBehind(guided, "control");
      // A cancelled thread a human queued two follow-ups on before the restart.
      const cancelled = yield* child("cancelled");
      yield* seedRunningRun({ threadId: cancelled });
      yield* dispatch({
        type: "thread.outcome.set",
        commandId: CommandId.make("recovery-cancel"),
        threadId: cancelled,
        createdAt,
        outcome: "cancelled",
      });
      yield* queueBehind(cancelled, "human");
      yield* queueBehind(cancelled, "human");
      // An upstream-only thread keeps upstream's rule.
      const plain = ThreadId.make("recovery-plain");
      yield* seedThread({ threadId: plain });
      yield* seedRunningRun({ threadId: plain });
      yield* queueBehind(plain, "control");

      // The restart: upstream cuts every turn and holds every queued run.
      yield* (yield* ProviderRuntimeRecoveryService).reconcile("startup");
      for (const threadId of [live, guided, cancelled, plain]) {
        const runs = yield* queuedRuns(threadId);
        assert.isTrue(runs.every((run) => run.status === "queued" && run.queueHeld === true));
      }
      assert.lengthOf(yield* queuedRuns(cancelled), 2);

      // Rule 0: the guided thread's continuation is accepted and does nothing.
      yield* continueRestartedRun({
        threadId: guided,
        sourceRunId: seededRunIds(guided).runId,
      }).pipe(Effect.provide(ServerSettings.layerTest()));
      const continuation = yield* receipts.getByCommandId(
        CommandId.make(`command:restart-continuation:${seededRunIds(guided).runId}`),
      );
      assert.equal(Option.getOrThrow(continuation).status, "accepted");
      assert.lengthOf(yield* queuedRuns(guided), 1);

      yield* releaseHeldQueues;

      const [resumed] = yield* queuedRuns(live);
      assert.isFalse(resumed!.queueHeld === true);
      assert.equal(resumed!.status, "starting");
      const [stillHeld] = yield* queuedRuns(guided);
      assert.deepInclude(stillHeld, { status: "queued", queueHeld: true });
      assert.deepEqual(
        (yield* queuedRuns(cancelled)).map((run) => run.status),
        ["cancelled", "cancelled"],
      );
      const [upstreamHeld] = yield* queuedRuns(plain);
      assert.deepInclude(upstreamHeld, { status: "queued", queueHeld: true });
    }),
  );
});
