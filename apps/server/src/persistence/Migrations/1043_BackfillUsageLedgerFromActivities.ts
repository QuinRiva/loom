import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Restore the usage-ledger rows lost from 2026-09-23 while ingestion's inserts
 * ran on the read-only lane (see `ProjectionUsageLedgerOnSqlReadClient`). Every
 * lost row survives as its `context-window.updated` activity: `activity_id` is
 * the ledger `event_id` and the payload is the token-usage snapshot, so this
 * mirrors ingestion's row derivation exactly. Scoped to the regression; the
 * older gap predates the ledger and is deliberately left alone. INSERT OR IGNORE
 * keeps rows that did land.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT OR IGNORE INTO projection_usage_ledger (
      event_id, thread_id, turn_id, provider_instance_id,
      provider_id, requested_model, resolved_model,
      input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
      cost_usd, created_at
    )
    SELECT
      activity_id, thread_id, turn_id, 'pi',
      json_extract(payload_json, '$.providerId'),
      json_extract(payload_json, '$.model'),
      json_extract(payload_json, '$.resolvedModel'),
      max(0, coalesce(json_extract(payload_json, '$.inputTokens'), 0)
        - coalesce(json_extract(payload_json, '$.cachedInputTokens'), 0)
        - coalesce(json_extract(payload_json, '$.cacheWriteTokens'), 0)),
      coalesce(json_extract(payload_json, '$.cachedInputTokens'), 0),
      coalesce(json_extract(payload_json, '$.cacheWriteTokens'), 0),
      coalesce(json_extract(payload_json, '$.outputTokens'), 0),
      coalesce(json_extract(payload_json, '$.costUsd'), 0),
      created_at
    FROM projection_thread_activities
    WHERE kind = 'context-window.updated'
      AND json_extract(payload_json, '$.usedTokens') > 0
      AND created_at >= '2026-09-23'
  `;
});
