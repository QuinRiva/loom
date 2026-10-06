/**
 * Restart recovery for Loom threads (plan §3 table, w8; DL-195, DL-199): after
 * upstream's startup reconciliation holds every queued run, `releaseHeldQueues`
 * resumes a live thread's held control wake, leaves a thread owed a human
 * held (and rule 0 makes its continuation an accepted no-op), and cancels a
 * dead thread's queued runs — on the real orchestrator and recovery service.
 *
 * Seam 20 (Phase 3 3b-4, smoke step 17): `loomStartupRecovery` redelivers a
 * continued thread's stashed steer behind its restart continuation, exactly once,
 * and leaves the stash of a flagged, done or cancelled thread on disk.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, type LoomMessageFields, MessageId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { CommandReceiptStoreV2 } from "../../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ServerConfig from "../../config.ts";
import { ProviderRuntimeRecoveryService } from "../../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import { continueRestartedRun } from "../../orchestration-v2/RestartContinuation.ts";
import * as ServerSettings from "../../serverSettings.ts";
import {
  dispatch,
  LoomOrchestratorTestLayer,
  seededRunIds,
  seedRunningRun,
  seedThread,
  seedUsageLimitedRun,
  spawnChild,
} from "../testkit/loomOrchestratorLayer.ts";
import { steerRedeliverCommandId } from "../orchestration/dispatcher/controlMessage.ts";
import { WorkstreamDispatcherLive } from "../orchestration/dispatcher/WorkstreamDispatcher.ts";
import {
  loomStartupRecovery,
  redeliverStashedSteers,
  releaseHeldQueues,
  steerHash,
} from "./loomRecoveryPolicy.ts";

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

const StashTestLayer = WorkstreamDispatcherLive.pipe(
  Layer.provideMerge(LoomOrchestratorTestLayer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-loom-recovery-" })),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(NodeServices.layer),
);

const encodeStash = Schema.encodeEffect(Schema.fromJsonString(Schema.String));

/** Writes a stash file exactly as 3c's adapter hunk will: one JSON string. */
const stash = (threadId: ThreadId, text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join((yield* ServerConfig.ServerConfig).stateDir, "pending-steering");
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(path.join(dir, `${threadId}.json`), yield* encodeStash(text));
  });
const stashed = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const dir = path.join((yield* ServerConfig.ServerConfig).stateDir, "pending-steering");
    return yield* (yield* FileSystem.FileSystem).exists(path.join(dir, `${threadId}.json`));
  });

it.layer(StashTestLayer)("Loom restart recovery: stashed steers (seam 20)", (it) => {
  it.effect(
    "a continued thread's steer lands behind its continuation once; flagged threads keep it",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const receipts = yield* CommandReceiptStoreV2;
        const root = ThreadId.make("stash-root");
        yield* seedThread({ threadId: root });
        const child = Effect.fn("test.stashChild")(function* (key: string) {
          const threadId = ThreadId.make(`stash-${key}`);
          yield* spawnChild({ parentThreadId: root, threadId, graphKey: key });
          return threadId;
        });
        const steerText = (threadId: ThreadId) => `Also update the changelog (${threadId}).`;
        const redeliveryId = (threadId: ThreadId) =>
          MessageId.make(
            `message:${steerRedeliverCommandId(threadId, steerHash(steerText(threadId)))}`,
          );

        // Live, mid-turn on a real session: upstream will continue it.
        const live = yield* child("live");
        yield* seedRunningRun({ threadId: live, live: true });
        // Owed a human.
        const guided = yield* child("guided");
        yield* dispatch({
          type: "thread.attention.raise",
          commandId: CommandId.make("stash-raise-guided"),
          threadId: guided,
          createdAt,
          reason: "needs_guidance",
        });
        yield* seedRunningRun({ threadId: guided, live: true });
        // Done, with a control wake queued behind its last turn (DL-249: stays held).
        const done = yield* child("done");
        yield* seedRunningRun({ threadId: done });
        yield* queueBehind(done, "control");
        yield* dispatch({
          type: "thread.outcome.set",
          commandId: CommandId.make("stash-done"),
          threadId: done,
          createdAt,
          outcome: "done",
        });
        // Cancelled.
        const cancelled = yield* child("cancelled");
        yield* seedRunningRun({ threadId: cancelled });
        yield* dispatch({
          type: "thread.outcome.set",
          commandId: CommandId.make("stash-cancelled"),
          threadId: cancelled,
          createdAt,
          outcome: "cancelled",
        });
        for (const threadId of [live, guided, done, cancelled]) {
          yield* stash(threadId, steerText(threadId));
        }

        yield* (yield* ProviderRuntimeRecoveryService).reconcile("startup");
        yield* loomStartupRecovery.pipe(Effect.provide(ServerSettings.layerTest()));

        // The live thread: upstream's continuation first, then the steer behind it.
        const projection = yield* orchestrator.getThreadProjection(live);
        const continuation = projection.messages.find(
          (message) => message.id === `message:restart-continuation:${seededRunIds(live).runId}`,
        );
        assert.isDefined(continuation);
        const redelivered = projection.messages.filter(
          (message) => message.id === redeliveryId(live),
        );
        assert.lengthOf(redelivered, 1);
        assert.deepEqual(redelivered[0]!.loom, { origin: "control_notice", humanAuthored: false });
        assert.include(redelivered[0]!.text, steerText(live));
        assert.include(redelivered[0]!.text, "never reached it");
        const runOf = (messageId: string) =>
          projection.runs.find((run) => run.userMessageId === messageId)!;
        assert.isAbove(runOf(redelivered[0]!.id).ordinal, runOf(continuation!.id).ordinal);
        assert.isFalse(yield* stashed(live));

        // Flagged, done and cancelled threads: nothing sent, the stash stays for a human's turn.
        for (const threadId of [guided, done, cancelled]) {
          const messages = (yield* orchestrator.getThreadProjection(threadId)).messages;
          assert.isFalse(messages.some((message) => message.id === redeliveryId(threadId)));
          assert.isTrue(yield* stashed(threadId));
        }
        const doneQueued = (yield* orchestrator.getThreadProjection(done)).runs.filter(
          (run) => run.status === "queued",
        );
        assert.isTrue(doneQueued.length === 1 && doneQueued[0]!.queueHeld === true);

        // The same stash again (a crash before the clear) hits the receipt: still one message.
        yield* stash(live, steerText(live));
        yield* redeliverStashedSteers.pipe(Effect.provide(ServerSettings.layerTest()));
        const again = (yield* orchestrator.getThreadProjection(live)).messages.filter(
          (message) => message.id === redeliveryId(live),
        );
        assert.lengthOf(again, 1);
        assert.isFalse(yield* stashed(live));
        const receipt = yield* receipts.getByCommandId(
          CommandId.make(steerRedeliverCommandId(live, steerHash(steerText(live)))),
        );
        assert.equal(Option.getOrThrow(receipt).status, "accepted");
      }),
  );

  it.effect("rule 0 vetoes upstream's limit-resume on a cancelled Loom thread (seam 13b)", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const root = ThreadId.make("veto-root");
      yield* seedThread({ threadId: root });
      const resume = (threadId: ThreadId, runId: string) =>
        dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`veto-resume:${threadId}`),
          threadId,
          messageId: MessageId.make(`message:veto-resume:${threadId}`),
          text: "Continue where you left off.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "server",
          usageLimitContinuationOfRunId: runId as never,
        });
      // The control: the same resume on a live Loom thread starts a run.
      const live = ThreadId.make("veto-live");
      yield* spawnChild({ parentThreadId: root, threadId: live, graphKey: "veto-live" });
      const liveRun = yield* seedUsageLimitedRun({ threadId: live });
      yield* resume(live, liveRun.runId);
      assert.lengthOf((yield* orchestrator.getThreadProjection(live)).runs, 2);

      const cancelled = ThreadId.make("veto-cancelled");
      yield* spawnChild({ parentThreadId: root, threadId: cancelled, graphKey: "veto-cancelled" });
      const cancelledRun = yield* seedUsageLimitedRun({ threadId: cancelled });
      yield* dispatch({
        type: "thread.outcome.set",
        commandId: CommandId.make("veto-cancel"),
        threadId: cancelled,
        createdAt,
        outcome: "cancelled",
      });
      const accepted = yield* resume(cancelled, cancelledRun.runId);
      // Accepted; the only event is the receipt-carrying metadata touch (no run, no message).
      assert.deepEqual(
        accepted.storedEvents.map((stored) => stored.event.type),
        ["thread.metadata-updated"],
      );
      const after = yield* orchestrator.getThreadProjection(cancelled);
      assert.lengthOf(after.runs, 1);
      assert.isFalse(
        after.messages.some((message) => message.id === `message:veto-resume:${cancelled}`),
      );
    }),
  );
});
