/**
 * thread.work.submit routing (plan §2, §6): the events each decision writes on
 * the COMMANDED thread. The gate legs those decisions imply are re-drive
 * output (A4), not asserted here.
 */
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  type LoomAttentionReason,
  MessageId,
  type OrchestrationV2StoredEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { LoomStoreV2 } from "../loom/projection/LoomStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import {
  dispatch,
  LoomOrchestratorTestLayer,
  loomEvent,
  seededRunIds,
  seedRunningRun,
  seedThread,
  spawnChild,
  writeEvents,
} from "../loom/testkit/loomOrchestratorLayer.ts";

const createdAt = "2026-01-01T00:00:00.000Z";
const parent = ThreadId.make("submit-parent");
let counter = 0;

const submit = (threadId: ThreadId, outcome?: string, commandId = `submit:${++counter}`) =>
  dispatch({
    type: "thread.work.submit",
    commandId: CommandId.make(commandId),
    threadId,
    createdAt,
    reportPath: `/reports/${threadId}.md`,
    ...(outcome === undefined ? {} : { outcome }),
  });
const raise = (threadId: ThreadId, reason: LoomAttentionReason) =>
  dispatch({
    type: "thread.attention.raise",
    commandId: CommandId.make(`server:test-raise:${threadId}:${reason}`),
    threadId,
    createdAt,
    reason,
  });
/** `[type, salient payload]` per stored event, all on the commanded thread. */
const summary = (threadId: ThreadId, events: ReadonlyArray<OrchestrationV2StoredEvent>) =>
  events.map(({ event }) => {
    assert.equal(event.threadId, threadId);
    const payload = event.payload as Record<string, unknown>;
    switch (event.type) {
      case "thread.outcome-recorded":
        return [event.type, payload.decision];
      case "thread.outcome-set":
        return [event.type, payload.outcome];
      case "thread.attention-raised":
        return [event.type, payload.reason];
      case "thread.route-taken":
        return [event.type, payload.kind, payload.to, payload.round];
      default:
        return [event.type];
    }
  });
const causeOf = (error: { readonly _tag: string }) => String((error as { cause?: unknown }).cause);

it.layer(LoomOrchestratorTestLayer)("Loom work.submit routing", (it) => {
  it.effect("terminal, attention, yield and the reserved quiescent outcome", () =>
    Effect.gen(function* () {
      yield* seedThread({ threadId: parent });
      const spawn = (key: string) => {
        const threadId = ThreadId.make(`submit-${key}`);
        return spawnChild({ parentThreadId: parent, threadId, graphKey: key }).pipe(
          Effect.as(threadId),
        );
      };

      const finished = yield* spawn("finished");
      yield* raise(finished, "error");
      assert.deepEqual(summary(finished, (yield* submit(finished)).storedEvents), [
        ["thread.report-set"],
        ["thread.outcome-recorded", "terminal"],
        ["thread.outcome-set", "done"],
        ["thread.attention-cleared"],
      ]);
      assert.include(causeOf(yield* Effect.flip(submit(finished))), "terminal thread");

      const holding = yield* spawn("holding");
      yield* raise(holding, "awaiting_acceptance");
      assert.include(causeOf(yield* Effect.flip(submit(holding))), "awaiting_acceptance");

      const human = yield* spawn("human");
      assert.deepEqual(summary(human, (yield* submit(human, "needs_human")).storedEvents), [
        ["thread.report-set"],
        ["thread.outcome-recorded", "attention"],
        ["thread.attention-raised", "needs_guidance"],
      ]);

      const yielded = yield* spawn("yielded");
      assert.deepEqual(summary(yielded, (yield* submit(yielded, "blocked")).storedEvents), [
        ["thread.report-set"],
        ["thread.outcome-recorded", "yield"],
        ["thread.attention-raised", "awaiting_orchestrator"],
      ]);

      const quiet = yield* spawn("quiet");
      assert.include(causeOf(yield* Effect.flip(submit(quiet, "quiescent"))), "reserved");
      yield* submit(quiet, "quiescent", `server:loom:quiescent:${quiet}:run-1`);
      const row = (yield* (yield* LoomStoreV2).getWorkstream(quiet))!;
      assert.deepInclude(row.lastOutcome, {
        outcome: "quiescent",
        decision: "yield",
        synthesised: true,
      });
      assert.deepEqual(row.attention, ["awaiting_orchestrator"]);
      assert.isNull(row.outcome);
    }),
  );

  it.effect("a review gate: source loop, intercepted target loop-back, source resolve", () =>
    Effect.gen(function* () {
      const coder = ThreadId.make("submit-gate-coder");
      const reviewer = ThreadId.make("submit-gate-reviewer");
      yield* spawnChild({ parentThreadId: parent, threadId: coder, graphKey: "gate-coder" });
      yield* spawnChild({
        parentThreadId: parent,
        threadId: reviewer,
        graphKey: "gate-reviewer",
        role: "reviewer",
        blockedBy: [coder],
        routes: [
          { on: ["needs_rework"], kind: "loop", to: coder },
          { on: ["clean"], kind: "resolve" },
        ],
      });

      assert.deepEqual(summary(reviewer, (yield* submit(reviewer, "needs_rework")).storedEvents), [
        ["thread.report-set"],
        ["thread.outcome-recorded", "loop"],
        ["thread.route-taken", "loop", coder, 1],
      ]);

      // The rework leg (A4's re-drive) opens the round on the coder.
      yield* writeEvents([
        yield* loomEvent("thread.gate-rework-accepted", coder, {
          sourceThreadId: reviewer,
          round: 1,
        }),
      ]);
      assert.deepEqual(summary(coder, (yield* submit(coder)).storedEvents), [
        ["thread.report-set"],
        ["thread.outcome-recorded", "loop"],
        ["thread.route-taken", "loop-back", reviewer, 1],
      ]);

      assert.deepEqual(summary(reviewer, (yield* submit(reviewer, "clean")).storedEvents), [
        ["thread.report-set"],
        ["thread.outcome-recorded", "resolve"],
        ["thread.outcome-set", "done"],
        ["thread.route-taken", "resolve", coder, 1],
      ]);
    }),
  );

  it.effect(
    "outcome.set cancelled skips (never fails on) an own run upstream cannot interrupt",
    () =>
      Effect.gen(function* () {
        const cancelled = ThreadId.make("submit-cancelled");
        yield* spawnChild({ parentThreadId: parent, threadId: cancelled, graphKey: "cancelled" });
        yield* raise(cancelled, "needs_guidance");
        // A seeded run has no live provider session, so upstream's interrupt refuses it.
        yield* seedRunningRun({ threadId: cancelled });
        const result = yield* dispatch({
          type: "thread.outcome.set",
          commandId: CommandId.make("server:test-cancel"),
          threadId: cancelled,
          createdAt,
          outcome: "cancelled",
        });
        assert.deepEqual(summary(cancelled, result.storedEvents), [
          ["thread.outcome-set", "cancelled"],
          ["thread.attention-cleared"],
        ]);
      }),
  );
  it.effect(
    "DL-246: outcome.set cancelled interrupts the running run and cancels every queued run in one command",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const cancelled = ThreadId.make("submit-cancelled-queue");
        yield* spawnChild({ parentThreadId: parent, threadId: cancelled, graphKey: "queue" });
        yield* seedRunningRun({ threadId: cancelled, live: true });
        for (const n of [1, 2]) {
          yield* dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`queue-behind:${n}`),
            threadId: cancelled,
            messageId: MessageId.make(`message:queue-behind:${n}`),
            text: `Queued ${n}`,
            attachments: [],
            createdBy: "agent",
            creationSource: "server",
            dispatchMode: { type: "queue_after_active" },
          });
        }
        const queuedIds = (yield* orchestrator.getThreadProjection(cancelled)).runs
          .filter((run) => run.status === "queued")
          .map((run) => run.id);
        assert.lengthOf(queuedIds, 2);

        const commandId = CommandId.make("server:test-cancel-queue");
        yield* dispatch({
          type: "thread.outcome.set",
          commandId,
          threadId: cancelled,
          createdAt,
          outcome: "cancelled",
        });
        const effects = yield* sql<{ readonly effectType: string }>`
          SELECT effect_type AS "effectType" FROM orchestration_v2_effect_outbox
          WHERE command_id = ${commandId}`;
        assert.deepEqual(
          effects.map((effect) => effect.effectType),
          ["provider-turn.interrupt"],
        );
        const runs = (yield* orchestrator.getThreadProjection(cancelled)).runs;
        assert.deepEqual(
          runs.filter((run) => queuedIds.includes(run.id)).map((run) => run.status),
          ["cancelled", "cancelled"],
        );
        // Nothing is left to start when the interrupted turn ends.
        assert.isFalse(runs.some((run) => run.status === "queued" || run.status === "starting"));
        assert.equal(
          runs.find((run) => run.id === seededRunIds(cancelled).runId)?.status,
          "running",
        );
      }),
  );
});
