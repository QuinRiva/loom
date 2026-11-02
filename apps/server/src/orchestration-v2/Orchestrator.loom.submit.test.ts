/**
 * thread.work.submit routing (plan §2, §6): the events each decision writes on
 * the COMMANDED thread. The gate legs those decisions imply are re-drive
 * output (A4), not asserted here.
 */
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
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

const submit = (
  threadId: ThreadId,
  outcome?: string,
  commandId = `submit:${++counter}`,
  rework?: ReadonlyArray<ThreadId>,
) =>
  dispatch({
    type: "thread.work.submit",
    commandId: CommandId.make(commandId),
    threadId,
    createdAt,
    reportPath: `/reports/${threadId}.md`,
    ...(outcome === undefined ? {} : { outcome }),
    ...(rework === undefined ? {} : { rework }),
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
    "a gate over several siblings: named rework, fan-in re-verify, resolve of the set",
    () =>
      Effect.gen(function* () {
        const [a, b, c] = ["a", "b", "c"].map((key) => ThreadId.make(`multi-gate-${key}`));
        const reviewer = ThreadId.make("multi-gate-reviewer");
        for (const coder of [a!, b!, c!]) {
          yield* spawnChild({ parentThreadId: parent, threadId: coder, graphKey: coder });
        }
        yield* spawnChild({
          parentThreadId: parent,
          threadId: reviewer,
          graphKey: "multi-gate-reviewer",
          role: "reviewer",
          blockedBy: [a!, b!, c!],
          routes: [
            ...[a!, b!, c!].map((to) => ({ on: ["needs_rework"], kind: "loop" as const, to })),
            { on: ["clean"], kind: "resolve" },
          ],
        });
        yield* writeEvents([
          yield* loomEvent("thread.kickoff-recorded", reviewer, {
            kickoffAt: createdAt,
            messageId: MessageId.make(`message:kickoff:${reviewer}`),
            origin: "kickoff",
          }),
        ]);
        const store = yield* LoomStoreV2;

        // A loop verdict on a multi-sibling gate must name the siblings to reopen.
        const unnamed = causeOf(yield* Effect.flip(submit(reviewer, "needs_rework")));
        assert.include(unnamed, `${a}, ${b}, ${c}`);
        assert.include(
          causeOf(yield* Effect.flip(submit(reviewer, "clean", undefined, [a!]))),
          "only accompanies",
        );
        assert.deepEqual(
          summary(
            reviewer,
            (yield* submit(reviewer, "needs_rework", undefined, [b!, a!])).storedEvents,
          ),
          [
            ["thread.report-set"],
            ["thread.outcome-recorded", "loop"],
            ["thread.route-taken", "loop", a, 1],
            ["thread.route-taken", "loop", b, 1],
          ],
        );
        const looped = (yield* store.getWorkstream(reviewer))!;
        assert.equal(looped.gateRounds, 1);
        assert.deepEqual(
          looped.lastRoutes.map((route) => route.to),
          [a, b],
        );

        // The rework legs (re-drive output) open the round on a and b; each routes back.
        const loopBacks = new Map<ThreadId, EventId>();
        for (const coder of [a!, b!]) {
          yield* writeEvents([
            yield* loomEvent("thread.gate-rework-accepted", coder, {
              sourceThreadId: reviewer,
              round: 1,
            }),
          ]);
          const { storedEvents } = yield* submit(coder);
          assert.deepEqual(summary(coder, storedEvents).at(-1), [
            "thread.route-taken",
            "loop-back",
            reviewer,
            1,
          ]);
          loopBacks.set(coder, storedEvents.at(-1)!.event.id);
        }

        const reverify = (sources: ReadonlyArray<readonly [ThreadId, EventId]>, key: string) =>
          dispatch({
            type: "thread.gate.reverify",
            commandId: CommandId.make(`server:workstream-gate:${reviewer}:1:reverify${key}`),
            threadId: reviewer,
            createdAt,
            sources: sources.map(([threadId, routeEventId]) => ({ threadId, routeEventId })),
            round: 1,
            message: {
              messageId: MessageId.make(`message:gate-reverify${key}`),
              text: "Both returned their rework.",
              controlPayload: { kind: "notice", heading: "Re-verify", items: [] },
            },
          });
        assert.include(
          causeOf(
            yield* Effect.flip(
              reverify(
                [
                  [a!, loopBacks.get(a!)!],
                  [b!, EventId.make("event:stale")],
                ],
                ":stale",
              ),
            ),
          ),
          "is stale",
        );
        yield* reverify(
          [
            [a!, loopBacks.get(a!)!],
            [b!, loopBacks.get(b!)!],
          ],
          "",
        );

        assert.deepEqual(summary(reviewer, (yield* submit(reviewer, "clean")).storedEvents), [
          ["thread.report-set"],
          ["thread.outcome-recorded", "resolve"],
          ["thread.outcome-set", "done"],
          ["thread.route-taken", "resolve", a, 1],
          ["thread.route-taken", "resolve", b, 1],
          ["thread.route-taken", "resolve", c, 1],
        ]);
      }),
  );

  it.effect("a rework reopening a done coder warns of started dependents, not its reviewer", () =>
    Effect.gen(function* () {
      const reopen = Effect.fn("test.reopen")(function* (key: string, downstreamStarted: boolean) {
        const root = ThreadId.make(`warn-${key}`);
        const coder = ThreadId.make(`warn-${key}-coder`);
        const reviewer = ThreadId.make(`warn-${key}-reviewer`);
        const downstream = ThreadId.make(`warn-${key}-downstream`);
        yield* seedThread({ threadId: root });
        yield* spawnChild({ parentThreadId: root, threadId: coder, graphKey: "coder" });
        yield* spawnChild({
          parentThreadId: root,
          threadId: reviewer,
          graphKey: "reviewer",
          role: "reviewer",
          blockedBy: [coder],
          routes: [{ on: ["needs_rework"], kind: "loop", to: coder }],
        });
        yield* spawnChild({
          parentThreadId: root,
          threadId: downstream,
          graphKey: "downstream",
          blockedBy: [coder],
        });
        yield* submit(coder);
        const routeEventId = EventId.make(`event:test-route:${reviewer}:1`);
        yield* writeEvents([
          ...(yield* Effect.forEach(downstreamStarted ? [reviewer, downstream] : [reviewer], (id) =>
            loomEvent("thread.kickoff-recorded", id, {
              kickoffAt: createdAt,
              messageId: MessageId.make(`message:kickoff:${id}`),
              origin: "kickoff",
            }),
          )),
          yield* loomEvent(
            "thread.route-taken",
            reviewer,
            { to: coder, round: 1, kind: "loop" },
            { id: routeEventId },
          ),
        ]);
        const result = yield* dispatch({
          type: "thread.gate.rework",
          commandId: CommandId.make(`server:workstream-gate:${reviewer}:1:rework:${coder}`),
          threadId: coder,
          createdAt,
          sourceThreadId: reviewer,
          round: 1,
          routeEventId,
          message: {
            messageId: MessageId.make(`message:gate-rework:${key}`),
            text: "The reviewer asked for rework.",
            controlPayload: { kind: "notice", heading: "Rework requested", items: [] },
          },
        });
        return {
          downstream,
          warnings: result.storedEvents.flatMap(({ event }) =>
            event.type === "thread.gate-warning" ? [event.payload] : [],
          ),
        };
      });

      assert.deepEqual((yield* reopen("reviewer-only", false)).warnings, []);
      const started = yield* reopen("downstream", true);
      assert.deepEqual(
        started.warnings.map((warning) => warning.threadIds),
        [[started.downstream]],
      );
    }),
  );

  it.effect("outcome.set cancelled settles an own run that has no live provider session", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const cancelled = ThreadId.make("submit-cancelled");
      yield* spawnChild({ parentThreadId: parent, threadId: cancelled, graphKey: "cancelled" });
      yield* raise(cancelled, "needs_guidance");
      // A seeded run has no live provider session; since upstream's a7a2230c33 the
      // interrupt settles it instead of refusing (DL-501), so cancelling still never fails.
      yield* seedRunningRun({ threadId: cancelled });
      const result = yield* dispatch({
        type: "thread.outcome.set",
        commandId: CommandId.make("server:test-cancel"),
        threadId: cancelled,
        createdAt,
        outcome: "cancelled",
      });
      assert.deepEqual(summary(cancelled, result.storedEvents).slice(0, 2), [
        ["thread.outcome-set", "cancelled"],
        ["thread.attention-cleared"],
      ]);
      const { runs } = yield* orchestrator.getThreadProjection(cancelled);
      assert.deepEqual(
        runs.map((run) => run.status),
        ["interrupted"],
      );
    }),
  );
  it.effect(
    "outcome.set carries a cancel reason to the event and history, and drops it on done",
    () =>
      Effect.gen(function* () {
        const thread = ThreadId.make("submit-cancel-reason");
        yield* spawnChild({ parentThreadId: parent, threadId: thread, graphKey: "cancel-reason" });
        const set = (outcome: "cancelled" | "done" | null, n: number) =>
          dispatch({
            type: "thread.outcome.set",
            commandId: CommandId.make(`server:test-cancel-reason:${n}`),
            threadId: thread,
            createdAt,
            outcome,
            reason: "superseded",
          });
        const payloads = (result: {
          readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
        }) =>
          result.storedEvents
            .filter(({ event }) => event.type === "thread.outcome-set")
            .map(({ event }) => event.payload);
        assert.deepEqual(payloads(yield* set("cancelled", 1)), [
          { outcome: "cancelled", cause: "set", reason: "superseded" },
        ]);
        assert.deepEqual(payloads(yield* set(null, 2)), [{ outcome: null, cause: "set" }]);
        assert.deepEqual(payloads(yield* set("done", 3)), [{ outcome: "done", cause: "set" }]);
        const history = yield* (yield* LoomStoreV2).history(thread);
        assert.deepEqual(
          history.flatMap((entry) =>
            entry.type === "outcome-set" ? [[entry.outcome, entry.reason]] : [],
          ),
          [
            ["cancelled", "superseded"],
            [null, undefined],
            ["done", undefined],
          ],
        );
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
