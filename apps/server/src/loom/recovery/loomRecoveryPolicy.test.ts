/**
 * Restart recovery for Loom threads (plan §3 table, w8; DL-195, DL-199): after
 * upstream's startup reconciliation holds every queued run, `releaseHeldQueues`
 * resumes a live thread's held control wake (behind upstream's restart
 * continuation, run first when its effect is still due — DL-376), leaves a thread owed a human
 * held (and rule 0 makes its continuation an accepted no-op), and cancels a
 * dead thread's queued runs — on the real orchestrator and recovery service.
 *
 * Seam 20 (Phase 3 3b-4, smoke step 17): `loomStartupRecovery` redelivers a
 * continued thread's stashed steer behind its restart continuation, exactly once,
 * and leaves the stash of a flagged, done or cancelled thread on disk; the
 * dispatcher's redelivery rail then carries a flagged thread's stash into the next
 * human-started turn (DL-387).
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type LoomMessageFields,
  MessageId,
  type OrchestrationV2DomainEvent,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
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
import { ProviderSessionManagerV2 } from "../../orchestration-v2/ProviderSessionManager.ts";
import { continueRestartedRun } from "../../orchestration-v2/RestartContinuation.ts";
import * as ServerSettings from "../../serverSettings.ts";
import {
  completeOpenRuns,
  dispatch,
  LoomOrchestratorTestLayer,
  seededRunIds,
  seedRunningRun,
  seedThread,
  seedUsageLimitedRun,
  spawnChild,
  testModelSelection,
  writeEvents,
} from "../testkit/loomOrchestratorLayer.ts";
import { steerHash, steerRedeliverCommandId } from "../orchestration/dispatcher/controlMessage.ts";
import {
  WorkstreamDispatcher,
  WorkstreamDispatcherLive,
} from "../orchestration/dispatcher/WorkstreamDispatcher.ts";
import * as PendingSteering from "../steering/pendingSteering.ts";
import {
  loomStartupRecovery,
  redeliverStashedSteers,
  releaseHeldQueues,
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

      // A live Loom thread (a real session, so upstream will continue it) with a control wake
      // queued behind its turn.
      const live = yield* child("live");
      yield* seedRunningRun({ threadId: live, live: true });
      // Queued while the session was away (not steerable), then the session is back.
      const sessions = yield* ProviderSessionManagerV2;
      const sessionId = ProviderSessionId.make(`provider-session:${live}`);
      yield* sessions.close(sessionId);
      yield* queueBehind(live, "control");
      yield* sessions.open({
        threadId: live,
        providerSessionId: sessionId,
        modelSelection: testModelSelection,
        runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
      });
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

      yield* releaseHeldQueues.pipe(Effect.provide(ServerSettings.layerTest()));
      // The effect worker's own run of the continuation effect, after the release: a no-op.
      yield* continueRestartedRun({ threadId: live, sourceRunId: seededRunIds(live).runId }).pipe(
        Effect.provide(ServerSettings.layerTest()),
      );

      // DL-376: upstream's continuation ran first and the released wake queues behind it —
      // without the pre-call the wake would start first and the continuation would no-op.
      const liveRuns = yield* queuedRuns(live);
      assert.lengthOf(liveRuns, 2);
      const continued = liveRuns.find(
        (run) => run.userMessageId === `message:restart-continuation:${seededRunIds(live).runId}`,
      );
      const resumed = liveRuns.find((run) => run !== continued);
      assert.equal(continued?.status, "starting");
      assert.deepInclude(resumed, { status: "queued", queueHeld: false });
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

  it.effect(
    "a flagged thread's stash survives startup, then rides the next human-started turn once",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const root = ThreadId.make("later-root");
        const flagged = ThreadId.make("later-flagged");
        yield* seedThread({ threadId: root });
        yield* spawnChild({ parentThreadId: root, threadId: flagged, graphKey: "later" });
        yield* dispatch({
          type: "thread.attention.raise",
          commandId: CommandId.make("later-raise"),
          threadId: flagged,
          createdAt,
          reason: "needs_guidance",
        });
        yield* seedRunningRun({ threadId: flagged, live: true });
        const steer = "Use the staging bucket, not production.";
        yield* stash(flagged, steer);
        const redeliveryId = MessageId.make(
          `message:${steerRedeliverCommandId(flagged, steerHash(steer))}`,
        );
        const redeliveries = Effect.map(orchestrator.getThreadProjection(flagged), (projection) =>
          projection.messages.filter((message) => message.id === redeliveryId),
        );

        yield* (yield* ProviderRuntimeRecoveryService).reconcile("startup");
        yield* loomStartupRecovery.pipe(Effect.provide(ServerSettings.layerTest()));
        // Rule 0: nothing sent; the stash waits for a human's or the parent's turn.
        assert.lengthOf(yield* redeliveries, 0);
        assert.isTrue(yield* stashed(flagged));

        // The human answers; the turn starts (rule 4 clears the flag) and runs.
        yield* dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("later-human"),
          threadId: flagged,
          messageId: MessageId.make("message:later-human"),
          text: "Carry on.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const humanRun = (yield* orchestrator.getThreadProjection(flagged)).runs.find(
          (run) => run.userMessageId === "message:later-human",
        )!;
        const dispatcher = yield* WorkstreamDispatcher;
        yield* dispatcher.runPass; // not running yet: the stash waits
        assert.lengthOf(yield* redeliveries, 0);
        yield* writeEvents([
          {
            id: EventId.make("event:later-human-running"),
            type: "run.updated",
            threadId: flagged,
            runId: humanRun.id,
            providerInstanceId: humanRun.providerInstanceId,
            occurredAt: yield* DateTime.now,
            payload: { ...humanRun, status: "running", startedAt: yield* DateTime.now },
          } as OrchestrationV2DomainEvent,
        ]);

        // Pi accepts a fresh steer into the running turn: the adapter appends it to the stash.
        const live = "Also bump the version.";
        yield* PendingSteering.append(flagged, live);

        yield* dispatcher.runPass;
        const [redelivered, ...more] = yield* redeliveries;
        assert.lengthOf(more, 0);
        assert.include(redelivered!.text, steer);
        assert.notInclude(redelivered!.text, live);
        assert.equal(redelivered!.loom?.origin, "control_notice");
        // Only the startup text left the file; the live turn's own steer keeps its durability.
        assert.equal(yield* PendingSteering.read(flagged), live);
        yield* dispatcher.runPass;
        assert.lengthOf(yield* redeliveries, 1);
        assert.equal(yield* PendingSteering.read(flagged), live);
      }),
  );

  it.effect(
    "a left stash still reaches its human-started turn when that turn ends (and the adapter clears the file) before a pass sees it",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const root = ThreadId.make("race-root");
        const flagged = ThreadId.make("race-flagged");
        yield* seedThread({ threadId: root });
        yield* spawnChild({ parentThreadId: root, threadId: flagged, graphKey: "race" });
        yield* dispatch({
          type: "thread.attention.raise",
          commandId: CommandId.make("race-raise"),
          threadId: flagged,
          createdAt,
          reason: "needs_guidance",
        });
        yield* seedRunningRun({ threadId: flagged, live: true });
        const steer = "Pin the dependency to 4.2.";
        yield* stash(flagged, steer);
        const redeliveryId = MessageId.make(
          `message:${steerRedeliverCommandId(flagged, steerHash(steer))}`,
        );
        const redeliveries = Effect.map(orchestrator.getThreadProjection(flagged), (projection) =>
          projection.messages.filter((message) => message.id === redeliveryId),
        );
        yield* (yield* ProviderRuntimeRecoveryService).reconcile("startup");
        yield* loomStartupRecovery.pipe(Effect.provide(ServerSettings.layerTest()));
        assert.lengthOf(yield* redeliveries, 0);

        yield* dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("race-human"),
          threadId: flagged,
          messageId: MessageId.make("message:race-human"),
          text: "Carry on.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        // The human's turn runs and ends before any pass: its finalizeTurn clears the stash file.
        const humanRun = (yield* orchestrator.getThreadProjection(flagged)).runs.find(
          (run) => run.userMessageId === "message:race-human",
        )!;
        yield* writeEvents([
          {
            id: EventId.make("event:race-human-running"),
            type: "run.updated",
            threadId: flagged,
            runId: humanRun.id,
            providerInstanceId: humanRun.providerInstanceId,
            occurredAt: yield* DateTime.now,
            payload: { ...humanRun, status: "running", startedAt: yield* DateTime.now },
          } as OrchestrationV2DomainEvent,
        ]);
        yield* PendingSteering.clear(flagged);
        yield* completeOpenRuns(flagged);

        const dispatcher = yield* WorkstreamDispatcher;
        yield* dispatcher.runPass;
        const [redelivered, ...more] = yield* redeliveries;
        assert.lengthOf(more, 0);
        assert.include(redelivered!.text, steer);
        yield* dispatcher.runPass;
        assert.lengthOf(yield* redeliveries, 1);
        assert.isFalse(yield* stashed(flagged));
      }),
  );

  it.effect(
    "a live turn's own stash (no restart) is never redelivered or cleared by the rail",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const root = ThreadId.make("live-stash-root");
        const child = ThreadId.make("live-stash-child");
        yield* seedThread({ threadId: root });
        yield* spawnChild({ parentThreadId: root, threadId: child, graphKey: "live-stash" });
        yield* dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("live-stash-human"),
          threadId: child,
          messageId: MessageId.make("message:live-stash-human"),
          text: "Start on the parser.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const run = (yield* orchestrator.getThreadProjection(child)).runs[0]!;
        yield* writeEvents([
          {
            id: EventId.make("event:live-stash-running"),
            type: "run.updated",
            threadId: child,
            runId: run.id,
            providerInstanceId: run.providerInstanceId,
            occurredAt: yield* DateTime.now,
            payload: { ...run, status: "running", startedAt: yield* DateTime.now },
          } as OrchestrationV2DomainEvent,
        ]);
        // What 3c's adapter writes when pi acks a steer into this live turn.
        const accepted = "Use the new tokenizer.";
        yield* PendingSteering.append(child, accepted);

        yield* (yield* WorkstreamDispatcher).runPass;
        const messages = (yield* orchestrator.getThreadProjection(child)).messages;
        assert.isFalse(messages.some((message) => message.loom?.origin === "control_notice"));
        assert.equal(yield* PendingSteering.read(child), accepted);
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
