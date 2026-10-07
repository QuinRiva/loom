/**
 * Restart recovery for Loom threads (plan §3 table, w8; DL-195, DL-199): after
 * upstream's startup reconciliation holds every queued run, `releaseHeldQueues`
 * resumes a live thread's held control wake (behind upstream's restart
 * continuation, run first when its effect is still due — DL-376), leaves a thread owed a human
 * held (and rule 0 makes its continuation an accepted no-op), and cancels a
 * dead thread's queued runs — on the real orchestrator and recovery service.
 *
 * Seam 20 (Phase 3 3b-4, smoke step 17; DL-690): a continued thread's stashed steer
 * rides its restart continuation exactly once — first, and past a human-held queue —
 * or, with no continuation, starts as a control message; the stash of a flagged or done
 * thread stays on disk, and the dispatcher's redelivery rail then carries a flagged
 * thread's stash into the next human-started turn (DL-387). A stash from a turn that
 * ended any other way (a Stop, a cancel) is discarded, never delivered (DL-694).
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
import * as TestClock from "effect/testing/TestClock";

import { CommandReceiptStoreV2 } from "../../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ServerConfig from "../../config.ts";
import { ProviderRuntimeRecoveryService } from "../../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import { OrchestrationEffectWorkerV2 } from "../../orchestration-v2/EffectWorker.ts";
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
import { LoomProviderHealthLive } from "../serverLayers.ts";
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
      // A cancelled thread a human started a turn on and queued two follow-ups behind before
      // the restart. The run is seeded after the cancel: cancelling settles a running run (DL-501).
      const cancelled = yield* child("cancelled");
      yield* dispatch({
        type: "thread.outcome.set",
        commandId: CommandId.make("recovery-cancel"),
        threadId: cancelled,
        createdAt,
        outcome: "cancelled",
      });
      yield* seedRunningRun({ threadId: cancelled });
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
  // The live adapter hooks, whose stash read upstream's restart continuation makes (DL-690).
  Layer.provideMerge(LoomProviderHealthLive),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-loom-recovery-" })),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(NodeServices.layer),
);

/** What the adapter mirrored for the seeded run's turn when the restart killed pi: one undelivered steer. */
const stash = (threadId: ThreadId, text: string) =>
  PendingSteering.write(threadId, seededRunIds(threadId).runId, [text]);
const stashText = (threadId: ThreadId) =>
  Effect.map(PendingSteering.read(threadId), (stash) => stash?.text ?? null);
const stashed = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const dir = path.join((yield* ServerConfig.ServerConfig).stateDir, "pending-steering");
    return yield* (yield* FileSystem.FileSystem).exists(path.join(dir, `${threadId}.json`));
  });

it.layer(StashTestLayer)("Loom restart recovery: stashed steers (seam 20)", (it) => {
  it.effect(
    "a continued thread's steer rides its continuation once, past a human-held queue; flagged threads keep it",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
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

        // Live, mid-turn on a real session (upstream will continue it). A queued message was taken
        // out of the queue (as promote-to-steer does: a cancelled run with a higher ordinal), and
        // a human queued a follow-up behind the turn: the restart holds it.
        const live = yield* child("live");
        yield* seedRunningRun({ threadId: live, live: true });
        yield* queueBehind(live, "human");
        yield* dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make("stash-live-unqueue"),
          threadId: live,
          runId: (yield* orchestrator.getThreadProjection(live)).runs.find(
            (run) => run.status === "queued",
          )!.id,
        });
        yield* TestClock.adjust("1 second"); // the restart comes later
        yield* queueBehind(live, "human");
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

        const continuationOf = (threadId: ThreadId) =>
          Effect.map(orchestrator.getThreadProjection(threadId), (projection) => {
            const message = projection.messages.find(
              (candidate) =>
                candidate.id === `message:restart-continuation:${seededRunIds(threadId).runId}`,
            )!;
            return {
              projection,
              message,
              run: projection.runs.find((run) => run.userMessageId === message.id)!,
            };
          });
        yield* (yield* ProviderRuntimeRecoveryService).reconcile("startup");
        // Loom's startup pass reaches the continuation effect before the effect worker does.
        yield* loomStartupRecovery.pipe(Effect.provide(ServerSettings.layerTest()));
        yield* (yield* OrchestrationEffectWorkerV2).drain();

        // The live thread: the continuation carried the steer; nothing waits behind the human.
        const { projection, message, run } = yield* continuationOf(live);
        assert.include(message.text, "Continue where you left off.");
        assert.include(message.text, "never reached it");
        assert.include(message.text, steerText(live));
        assert.notEqual(run.status, "queued");
        assert.isFalse(
          projection.messages.some((candidate) => candidate.id === redeliveryId(live)),
        );
        const humanHeld = projection.runs.filter((candidate) => candidate.status === "queued");
        assert.isTrue(humanHeld.length === 1 && humanHeld[0]!.queueHeld === true);
        assert.isFalse(yield* stashed(live));

        // Flagged and done threads: nothing sent, the stash stays for a human's turn. The cancel
        // interrupted the cancelled thread's turn before the restart, so its steer died with it.
        assert.isFalse(yield* stashed(cancelled));
        for (const threadId of [guided, done, cancelled]) {
          const messages = (yield* orchestrator.getThreadProjection(threadId)).messages;
          assert.isFalse(
            messages.some(
              (candidate) =>
                candidate.id === redeliveryId(threadId) || candidate.text.includes("changelog"),
            ),
          );
          if (threadId !== cancelled) assert.isTrue(yield* stashed(threadId));
        }
        const doneQueued = (yield* orchestrator.getThreadProjection(done)).runs.filter(
          (candidate) => candidate.status === "queued",
        );
        assert.isTrue(doneQueued.length === 1 && doneQueued[0]!.queueHeld === true);

        // The same stash again (a crash before the clear): the continuation already carried it.
        yield* stash(live, steerText(live));
        yield* redeliverStashedSteers.pipe(Effect.provide(ServerSettings.layerTest()));
        const again = yield* continuationOf(live);
        assert.equal(again.message.text, message.text);
        assert.isFalse(
          again.projection.messages.some((candidate) => candidate.id === redeliveryId(live)),
        );
        assert.isFalse(yield* stashed(live));
      }),
  );

  it.effect(
    "with no continuation, a stashed steer starts at once as a control message, past a human-held queue",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const receipts = yield* CommandReceiptStoreV2;
        const root = ThreadId.make("bare-root");
        const child = ThreadId.make("bare-child");
        yield* seedThread({ threadId: root });
        yield* spawnChild({ parentThreadId: root, threadId: child, graphKey: "bare" });
        // No live session at the restart, so upstream has no continuation for it.
        yield* seedRunningRun({ threadId: child });
        yield* queueBehind(child, "human");
        const steer = "hello from notifier";
        yield* stash(child, steer);
        const redeliveryCommand = CommandId.make(steerRedeliverCommandId(child, steerHash(steer)));

        yield* (yield* ProviderRuntimeRecoveryService).reconcile("startup");
        yield* (yield* OrchestrationEffectWorkerV2).drain();
        yield* loomStartupRecovery.pipe(Effect.provide(ServerSettings.layerTest()));

        const projection = yield* orchestrator.getThreadProjection(child);
        const redelivered = projection.messages.filter(
          (message) => message.id === `message:${redeliveryCommand}`,
        );
        assert.lengthOf(redelivered, 1);
        assert.deepEqual(redelivered[0]!.loom, { origin: "control_notice", humanAuthored: false });
        assert.include(redelivered[0]!.text, steer);
        const redeliveryRun = projection.runs.find(
          (run) => run.userMessageId === redelivered[0]!.id,
        )!;
        const human = projection.runs.find((run) => run.status === "queued")!;
        assert.notEqual(redeliveryRun.status, "queued");
        assert.isTrue(human.queueHeld);
        assert.isFalse(yield* stashed(child));

        // A crash before the clear hits the receipt: still one message.
        yield* stash(child, steer);
        yield* redeliverStashedSteers.pipe(Effect.provide(ServerSettings.layerTest()));
        const again = (yield* orchestrator.getThreadProjection(child)).messages.filter(
          (message) => message.id === `message:${redeliveryCommand}`,
        );
        assert.lengthOf(again, 1);
        assert.equal(
          Option.getOrThrow(yield* receipts.getByCommandId(redeliveryCommand)).status,
          "accepted",
        );
      }),
  );

  it.effect("a stash from a turn the user stopped dies with it: no later restart delivers it", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const root = ThreadId.make("stopped-root");
      yield* seedThread({ threadId: root });
      /** A user Stop: pi is terminated with the steer still queued, and the run ends interrupted. */
      const stopSeededRun = Effect.fn("test.stopSeededRun")(function* (threadId: ThreadId) {
        const ids = seededRunIds(threadId);
        const projection = yield* orchestrator.getThreadProjection(threadId);
        const now = yield* DateTime.now;
        const run = projection.runs.find((entry) => entry.id === ids.runId)!;
        const turn = projection.providerTurns.find((entry) => entry.id === ids.providerTurnId)!;
        yield* writeEvents([
          {
            id: EventId.make(`event:stop-turn:${threadId}`),
            type: "provider-turn.updated",
            threadId,
            runId: ids.runId,
            nodeId: ids.nodeId,
            occurredAt: now,
            payload: { ...turn, status: "interrupted", completedAt: now },
          },
          {
            id: EventId.make(`event:stop-run:${threadId}`),
            type: "run.updated",
            threadId,
            runId: ids.runId,
            occurredAt: now,
            payload: { ...run, status: "interrupted", completedAt: now },
          },
        ] as Array<OrchestrationV2DomainEvent>);
      });
      const steer = (threadId: ThreadId) => `Rename the module (${threadId}).`;
      const delivered = (threadId: ThreadId) =>
        Effect.map(orchestrator.getThreadProjection(threadId), (projection) =>
          projection.messages.filter((message) => message.text.includes(steer(threadId))),
        );

      // Stopped, then idle until the restart.
      const idle = ThreadId.make("stopped-idle");
      yield* spawnChild({ parentThreadId: root, threadId: idle, graphKey: "stopped-idle" });
      yield* seedRunningRun({ threadId: idle, live: true });
      yield* stash(idle, steer(idle));
      yield* stopSeededRun(idle);
      // Stopped, then the human's next turn is the one the restart cuts.
      const later = ThreadId.make("stopped-later");
      yield* spawnChild({ parentThreadId: root, threadId: later, graphKey: "stopped-later" });
      yield* seedRunningRun({ threadId: later, live: true });
      yield* stash(later, steer(later));
      yield* stopSeededRun(later);
      yield* TestClock.adjust("1 second");
      yield* seedRunningRun({ threadId: later, ordinal: 2, live: true });

      yield* (yield* ProviderRuntimeRecoveryService).reconcile("startup");
      yield* (yield* OrchestrationEffectWorkerV2).drain();
      yield* loomStartupRecovery.pipe(Effect.provide(ServerSettings.layerTest()));

      const idleRuns = (yield* orchestrator.getThreadProjection(idle)).runs;
      assert.lengthOf(idleRuns, 1);
      assert.lengthOf(yield* delivered(idle), 0);
      assert.isFalse(yield* stashed(idle));
      // The later turn's continuation runs without the stopped turn's steer.
      const continuation = (yield* orchestrator.getThreadProjection(later)).messages.find(
        (message) => message.id === `message:restart-continuation:${seededRunIds(later, 2).runId}`,
      );
      assert.equal(continuation?.text, "Continue where you left off.");
      assert.lengthOf(yield* delivered(later), 0);
      assert.isFalse(yield* stashed(later));
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

        // Pi accepts a fresh steer into the running turn: the adapter mirrors pi's queue.
        const live = "Also bump the version.";
        yield* PendingSteering.write(flagged, humanRun.id, [live]);

        yield* dispatcher.runPass;
        const [redelivered, ...more] = yield* redeliveries;
        assert.lengthOf(more, 0);
        assert.include(redelivered!.text, steer);
        assert.notInclude(redelivered!.text, live);
        assert.equal(redelivered!.loom?.origin, "control_notice");
        // Only the startup text left the file; the live turn's own steer keeps its durability.
        assert.equal(yield* stashText(flagged), live);
        yield* dispatcher.runPass;
        assert.lengthOf(yield* redeliveries, 1);
        assert.equal(yield* stashText(flagged), live);
      }),
  );

  it.effect(
    "a left stash still reaches its human-started turn when that turn ends (and pi's empty queue overwrites the file) before a pass sees it",
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
        // The human's turn runs and ends before any pass: pi's empty queue removes the stash file.
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
        yield* PendingSteering.write(flagged, humanRun.id, []);
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
        // What the adapter mirrors when pi queues a steer into this live turn.
        const accepted = "Use the new tokenizer.";
        yield* PendingSteering.write(child, run.id, [accepted]);

        yield* (yield* WorkstreamDispatcher).runPass;
        const messages = (yield* orchestrator.getThreadProjection(child)).messages;
        assert.isFalse(messages.some((message) => message.loom?.origin === "control_notice"));
        assert.equal(yield* stashText(child), accepted);
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
