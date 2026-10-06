/**
 * UsageLedgerReactor — writes one `loom_usage_ledger` row per terminal provider
 * turn (plan seam 11): every `provider-turn.updated` whose turn has ended and
 * carries upstream's per-turn `turnTokenUsage` (the pi adapter's marked hunk
 * fills it from pi's per-message usage; `tokenUsage`'s token counts are pi's
 * session-wide totals and are never read here). The cost is the adapter's
 * pi-priced `tokenUsage.costUsd` (DR-8), absent ⇒ 0.
 *
 * Row derivation: `event_id` = the domain event id; `run_id` = the event's run
 * (else the provider turn's attempt's run); `provider_id` / `requested_model` =
 * the run's `modelSelection.model` split at its first `/` into pi's
 * `providerID` / `modelID`, as V1 stored them (`provider_id` NULL and the whole
 * slug as the model when it has no namespace); `resolved_model` NULL (pi reports none per turn);
 * `input_tokens` is pure input (upstream's input includes the cache buckets),
 * as V1's column was. `INSERT OR IGNORE` on the event id and the unique
 * provider-turn index make a replayed or repeated terminal event a no-op.
 *
 * Starts after activation, like the other Loom reactors.
 *
 * @module loom/economics/UsageLedgerReactor
 */
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../../serverActivation.ts";

type ProviderTurnEvent = Extract<OrchestrationV2DomainEvent, { type: "provider-turn.updated" }>;

const isTerminalTurn = (event: OrchestrationV2DomainEvent): event is ProviderTurnEvent =>
  event.type === "provider-turn.updated" &&
  event.payload.status !== "pending" &&
  event.payload.status !== "running" &&
  event.payload.turnTokenUsage !== undefined;

export const recordTurnUsage = Effect.fn("loom.usage-ledger.record")(function* (
  event: ProviderTurnEvent,
) {
  const sql = yield* SqlClient.SqlClient;
  const turn = event.payload;
  const usage = turn.turnTokenUsage!;
  const [run] = yield* sql<{ readonly runId: string; readonly model: string | null }>`
    SELECT run_id AS "runId", json_extract(payload_json, '$.modelSelection.model') AS "model"
    FROM orchestration_v2_projection_runs
    WHERE run_id = coalesce(${event.runId ?? null}, (
      SELECT run_id FROM orchestration_v2_projection_run_attempts WHERE attempt_id = ${turn.runAttemptId}
    ))`;
  const model = run?.model ?? null;
  const slash = model?.indexOf("/") ?? -1;
  const cacheRead = usage.cachedInputTokens ?? 0;
  const cacheWrite = usage.cacheCreationTokens ?? 0;
  yield* sql`
    INSERT OR IGNORE INTO loom_usage_ledger (
      event_id, thread_id, turn_id, run_id, provider_turn_id, provider_instance_id,
      provider_id, requested_model, resolved_model,
      input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
      cost_usd, created_at
    ) VALUES (
      ${event.id}, ${event.threadId}, NULL, ${run?.runId ?? event.runId ?? null}, ${turn.id},
      ${event.providerInstanceId ?? null},
      ${slash > 0 ? model!.slice(0, slash) : null}, ${slash > 0 ? model!.slice(slash + 1) : model}, NULL,
      ${Math.max(0, (usage.inputTokens ?? 0) - cacheRead - cacheWrite)}, ${cacheRead}, ${cacheWrite},
      ${usage.outputTokens ?? 0}, ${turn.tokenUsage?.costUsd ?? 0},
      ${DateTime.formatIso(event.occurredAt)}
    )`;
});

/** Writes a row for every terminal provider turn in `events` (a failed write is logged, not fatal). */
export const recordTerminalTurns = <E, R>(
  events: Stream.Stream<OrchestrationV2DomainEvent, E, R>,
) =>
  events.pipe(
    Stream.filter(isTerminalTurn),
    Stream.runForEach((event) =>
      recordTurnUsage(event).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("loom.usage-ledger.record-failed", { eventId: event.id, cause }),
        ),
      ),
    ),
  );

/** The reactor: one ledger row per terminal provider turn, from the live domain stream. */
export const UsageLedgerReactorLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    yield* forkParked(
      recordTerminalTurns(orchestrator.streamDomainEvents).pipe(
        Effect.catchCause((cause) => Effect.logWarning("loom.usage-ledger.stopped", { cause })),
      ),
    );
  }),
);
