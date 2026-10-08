/**
 * The usage ledger on the real orchestrator (plan track 3c, Tests; seam 11): the
 * reactor's pipeline turns terminal provider turns into `loom_usage_ledger` rows
 * (read back from the event store in order, so no sleeps), a replay adds nothing,
 * a live turn update adds no row (its live cost still counts in `threadSpend`),
 * and the two seam-11 queries sum and rank.
 */
import { assert, it } from "@effect/vitest";
import {
  EventId,
  type IsoDateTime,
  type OrchestrationV2DomainEvent,
  ProviderInstanceId,
  type ThreadId,
  ThreadId as ThreadIdSchema,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import {
  LoomOrchestratorTestLayer,
  seedRunningRun,
  seedThread,
  writeEvents,
} from "../testkit/loomOrchestratorLayer.ts";
import { LoomUsageLedger, layer as LoomUsageLedgerLayer } from "./LoomUsageLedger.ts";
import { recordTerminalTurns } from "./UsageLedgerReactor.ts";

/** Runs the reactor's pipeline over every stored event after `afterSequence`, up to `lastId`. */
const react = (afterSequence: number, lastId: EventId) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    yield* recordTerminalTurns(
      sink.stream({ afterSequence }).pipe(
        Stream.map((stored) => stored.event),
        Stream.takeUntil((event) => event.id === lastId),
      ),
    );
  });

/** A thread with one seeded run, its turn then updated to `status` with this turn's usage. */
const turnEnds = Effect.fn("test.turnEnds")(function* (input: {
  readonly threadId: ThreadId;
  readonly status: "running" | "completed" | "failed";
  readonly model?: string;
  readonly costUsd?: number;
}) {
  yield* seedThread({ threadId: input.threadId });
  const ids = yield* seedRunningRun({ threadId: input.threadId });
  const projection = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(
    input.threadId,
  );
  const run = projection.runs.find((entry) => entry.id === ids.runId)!;
  const turn = projection.providerTurns.find((entry) => entry.id === ids.providerTurnId)!;
  const occurredAt = yield* DateTime.now;
  const id = EventId.make(`test:turn-${input.status}:${input.threadId}`);
  const events: Array<OrchestrationV2DomainEvent> = [
    {
      id,
      type: "provider-turn.updated",
      threadId: input.threadId,
      runId: ids.runId,
      nodeId: ids.nodeId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      occurredAt,
      payload: {
        ...turn,
        status: input.status,
        completedAt: input.status === "running" ? null : occurredAt,
        tokenUsage: {
          usedTokens: 5_000,
          maxTokens: 200_000,
          // Session-wide totals, as pi reports them: never read by the ledger.
          inputTokens: 99_999,
          outputTokens: 99_999,
          ...(input.costUsd === undefined ? {} : { costUsd: input.costUsd }),
          updatedAt: DateTime.formatIso(occurredAt),
        },
        turnTokenUsage: {
          usageScope: "main_agent",
          usageStatus: input.status === "completed" ? "complete" : "partial",
          inputTokens: 1_000,
          cachedInputTokens: 600,
          cacheCreationTokens: 80,
          outputTokens: 40,
          hasSubagents: false,
        },
      },
    },
  ];
  if (input.model !== undefined)
    events.unshift({
      id: EventId.make(`test:run-model:${input.threadId}`),
      type: "run.updated",
      threadId: input.threadId,
      runId: ids.runId,
      occurredAt,
      payload: { ...run, modelSelection: { ...run.modelSelection, model: input.model } },
    });
  yield* writeEvents(events);
  return { ...ids, eventId: id };
});

const ledgerRows = Effect.gen(function* () {
  return yield* (yield* SqlClient.SqlClient)`
    SELECT event_id, thread_id, run_id, provider_turn_id, provider_instance_id, provider_id,
      requested_model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, cost_usd
    FROM loom_usage_ledger ORDER BY event_id`;
});

it.layer(Layer.provideMerge(LoomUsageLedgerLayer, LoomOrchestratorTestLayer))(
  "Loom usage ledger",
  (it) => {
    it.effect("writes one row per terminal provider turn and answers seam 11's queries", () =>
      Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        const start = yield* sink.latestSequence();
        const opus = ThreadIdSchema.make("ledger-opus");
        const bare = ThreadIdSchema.make("ledger-bare");
        const live = ThreadIdSchema.make("ledger-live");
        const completed = yield* turnEnds({
          threadId: opus,
          status: "completed",
          model: "cliproxy/claude-opus-5-5",
          costUsd: 0.5,
        });
        // A failed turn pi priced at nothing carries no costUsd.
        const failed = yield* turnEnds({ threadId: bare, status: "failed" });
        const running = yield* turnEnds({ threadId: live, status: "running", costUsd: 9 });

        yield* react(start, running.eventId);
        const expected = [
          {
            event_id: completed.eventId,
            thread_id: opus,
            run_id: completed.runId,
            provider_turn_id: completed.providerTurnId,
            provider_instance_id: "codex",
            provider_id: "cliproxy",
            requested_model: "claude-opus-5-5",
            input_tokens: 320,
            cache_read_tokens: 600,
            cache_write_tokens: 80,
            output_tokens: 40,
            cost_usd: 0.5,
          },
          {
            event_id: failed.eventId,
            thread_id: bare,
            run_id: failed.runId,
            provider_turn_id: failed.providerTurnId,
            provider_instance_id: "codex",
            provider_id: null,
            requested_model: "gpt-5.4",
            input_tokens: 320,
            cache_read_tokens: 600,
            cache_write_tokens: 80,
            output_tokens: 40,
            cost_usd: 0,
          },
        ].toSorted((a, b) => a.event_id.localeCompare(b.event_id));
        assert.deepEqual(yield* ledgerRows, expected);

        // A replay of the same events adds nothing.
        yield* react(start, running.eventId);
        assert.lengthOf(yield* ledgerRows, 2);

        // A V1 row carried over by migration 1049 (no run, no provider turn) counts too.
        yield* (yield* SqlClient.SqlClient)`
          INSERT INTO loom_usage_ledger (event_id, thread_id, input_tokens, cache_read_tokens,
            cache_write_tokens, output_tokens, cost_usd, created_at)
          VALUES ('v1-row', ${bare}, 10, 1, 2, 5, 0.25, '1969-12-31T00:00:00.000Z')`;

        const ledger = yield* LoomUsageLedger;
        const spend = yield* ledger.threadSpend([opus, bare, live]);
        assert.deepEqual(spend.get(opus), {
          costUsd: 0.5,
          inputTokens: 320,
          outputTokens: 40,
          cachedTokens: 680,
        });
        assert.deepEqual(spend.get(bare), {
          costUsd: 0.25,
          inputTokens: 330,
          outputTokens: 45,
          cachedTokens: 683,
        });
        // A running turn has no ledger row yet: its live cost counts, and a
        // ledgered turn's own live cost (opus) is not counted twice.
        assert.deepEqual(spend.get(live), {
          costUsd: 9,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
        });
        assert.equal((yield* ledger.threadSpend([])).size, 0);

        const epoch = "1969-01-01T00:00:00.000Z" as IsoDateTime;
        assert.deepEqual(
          (yield* ledger.topSpend(10, epoch)).map((row) => [row.threadId, row.costUsd]),
          [
            [opus, 0.5],
            [bare, 0.25],
          ],
        );
        assert.deepEqual(
          (yield* ledger.topSpend(1, epoch)).map((row) => row.threadId),
          [opus],
        );
        // `since` drops the older V1 row.
        const today = DateTime.formatIso(yield* DateTime.now) as IsoDateTime;
        assert.deepEqual(
          (yield* ledger.topSpend(10, today)).map((row) => [row.threadId, row.costUsd]),
          [
            [opus, 0.5],
            [bare, 0],
          ],
        );
      }),
    );
  },
);
