/**
 * t-quiescence (plan §6, §7; DL-194): the reserved `quiescent` outcome routes a
 * quiet child to its orchestrator, and `quiescenceCandidate` reads a real
 * thread's shell, runs and latest user message.
 */
import { assert, it } from "@effect/vitest";
import { CommandId, EventId, MessageId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import { LoomStoreV2 } from "../projection/LoomStore.ts";
import {
  completeSeededRun,
  dispatch,
  LoomOrchestratorTestLayer,
  loomEvent,
  seededRunIds,
  seedRunningRun,
  seedThread,
  spawnChild,
  writeEvents,
} from "../testkit/loomOrchestratorLayer.ts";
import { quiescenceCandidate } from "./quiescence.ts";

const createdAt = "2026-01-01T00:00:00.000Z";
const parent = ThreadId.make("quiet-parent");
const reason = (error: { readonly _tag: string }) => String((error as { cause?: unknown }).cause);
const submitQuiescent = (threadId: ThreadId, commandId: string) =>
  dispatch({
    type: "thread.work.submit",
    commandId: CommandId.make(commandId),
    threadId,
    createdAt,
    reportPath: `/reports/${threadId}-quiescent.md`,
    outcome: "quiescent",
  });

/** The candidate inputs as the 3b rail reads them, `graceMs` after the last run ended. */
const candidateAfter = Effect.fn("test.candidateAfter")(function* (
  threadId: ThreadId,
  grace: { readonly controlStartedMs: number; readonly humanStartedMs: number | null },
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projection = yield* orchestrator.getThreadProjection(threadId);
  const ended = projection.runs.flatMap((run) =>
    run.completedAt === null ? [] : [run.completedAt],
  );
  return quiescenceCandidate({
    shell: (yield* orchestrator.getThreadShell(threadId))!,
    runs: projection.runs,
    latestUserMessage: projection.messages.findLast((message) => message.role === "user") ?? null,
    children: yield* (yield* LoomStoreV2).listChildren(threadId),
    now: DateTime.add(ended.at(-1) ?? (yield* DateTime.now), { seconds: 60 }),
    grace,
  });
});
const minute = { controlStartedMs: 60_000, humanStartedMs: null };

it.layer(LoomOrchestratorTestLayer)("Loom quiescence", (it) => {
  it.effect("t-quiescence: the reserved outcome yields, server ids only, never on a route", () =>
    Effect.gen(function* () {
      const store = yield* LoomStoreV2;
      yield* seedThread({ threadId: parent });
      const coder = ThreadId.make("quiet-coder");
      yield* spawnChild({ parentThreadId: parent, threadId: coder, graphKey: "coder" });
      // A gate target mid-rework: quiescence still yields, never hands the round back.
      yield* writeEvents([
        yield* loomEvent("thread.gate-rework-accepted", coder, {
          sourceThreadId: parent,
          round: 1,
        }),
      ]);
      assert.isTrue((yield* store.getWorkstream(coder))!.pendingRework);

      assert.include(
        reason(yield* Effect.flip(submitQuiescent(coder, "quiet-bare"))),
        "reserved for the server",
      );
      const accepted = yield* submitQuiescent(coder, `server:loom:quiescent:${coder}:run-1`);
      assert.deepEqual(
        accepted.storedEvents.map(({ event }) => event.type),
        ["thread.report-set", "thread.outcome-recorded", "thread.attention-raised"],
      );
      const row = (yield* store.getWorkstream(coder))!;
      assert.deepInclude(row.lastOutcome, {
        outcome: "quiescent",
        decision: "yield",
        synthesised: true,
      });
      assert.deepEqual(row.attention, ["awaiting_orchestrator"]);
      assert.isNull(row.outcome);

      const routed = yield* Effect.flip(
        spawnChild({
          parentThreadId: parent,
          threadId: ThreadId.make("quiet-router"),
          graphKey: "router",
          routes: [{ on: ["quiescent"], kind: "loop", to: coder }],
        }),
      );
      assert.include(reason(routed), "reserved outcome 'quiescent'");
    }),
  );

  it.effect("quiescenceCandidate: a control-started idle child qualifies after its grace", () =>
    Effect.gen(function* () {
      const idle = ThreadId.make("quiet-idle");
      yield* spawnChild({ parentThreadId: parent, threadId: idle, graphKey: "idle" });
      yield* seedRunningRun({ threadId: idle });
      yield* writeEvents([
        yield* loomEvent("thread.kickoff-recorded", idle, {
          kickoffAt: createdAt,
          messageId: seededRunIds(idle).messageId,
          origin: "kickoff",
        }),
      ]);
      assert.isFalse(yield* candidateAfter(idle, minute)); // still running
      yield* completeSeededRun({ threadId: idle });
      assert.isTrue(yield* candidateAfter(idle, minute));
      assert.isFalse(yield* candidateAfter(idle, { ...minute, controlStartedMs: 120_000 }));
    }),
  );

  it.effect("t-quiescence: false for a thread with a held queued run", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const held = ThreadId.make("quiet-held");
      yield* spawnChild({ parentThreadId: parent, threadId: held, graphKey: "held" });
      yield* seedRunningRun({ threadId: held });
      yield* dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("quiet-held-wake"),
        threadId: held,
        messageId: MessageId.make("message:quiet-held-wake"),
        text: "A wake queued behind the turn",
        attachments: [],
        createdBy: "agent",
        creationSource: "server",
        dispatchMode: { type: "queue_after_active" },
      });
      // Hold the queue as restart recovery would, then end the turn: nothing starts.
      const queued = (yield* orchestrator.getThreadProjection(held)).runs.find(
        (run) => run.status === "queued",
      )!;
      yield* writeEvents([
        {
          id: EventId.make("event:quiet-hold"),
          type: "run.updated",
          threadId: held,
          runId: queued.id,
          occurredAt: yield* DateTime.now,
          payload: { ...queued, queueHeld: true },
        },
      ]);
      yield* completeSeededRun({ threadId: held });
      yield* writeEvents([
        yield* loomEvent("thread.kickoff-recorded", held, {
          kickoffAt: createdAt,
          messageId: seededRunIds(held).messageId,
          origin: "kickoff",
        }),
      ]);
      assert.isFalse(yield* candidateAfter(held, minute));
      // The same thread without the held queue would qualify: the queue is the reason.
      const projection = yield* orchestrator.getThreadProjection(held);
      assert.isTrue(
        quiescenceCandidate({
          shell: (yield* orchestrator.getThreadShell(held))!,
          runs: projection.runs.filter((run) => run.status !== "queued"),
          latestUserMessage: null,
          children: [],
          now: DateTime.add(yield* DateTime.now, { minutes: 1 }),
          grace: minute,
        }),
      );
    }),
  );

  it.effect(
    "t-quiescence: a human-started last turn is never a candidate under a null human grace",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const human = ThreadId.make("quiet-human");
        yield* spawnChild({ parentThreadId: parent, threadId: human, graphKey: "human" });
        yield* dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("quiet-human-turn"),
          threadId: human,
          messageId: MessageId.make("message:quiet-human-turn"),
          text: "A composer message",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          dispatchMode: { type: "queue_after_active" },
        });
        const run = (yield* orchestrator.getThreadProjection(human)).runs[0]!;
        yield* writeEvents([
          {
            id: EventId.make("event:quiet-human-done"),
            type: "run.updated",
            threadId: human,
            runId: run.id,
            occurredAt: yield* DateTime.now,
            payload: { ...run, status: "completed", completedAt: yield* DateTime.now },
          },
        ]);
        assert.isFalse(yield* candidateAfter(human, minute));
        assert.isTrue(yield* candidateAfter(human, { ...minute, humanStartedMs: 0 }));
      }),
  );
});
