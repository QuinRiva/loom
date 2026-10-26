import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// One row per `thread.token-usage.updated` event, written by ProviderRuntimeIngestion beside the
// context-window activity, not by the projector pipeline. Feeds the /usage dashboard; the
// `event_id` PK plus INSERT OR IGNORE makes ingestion replay-safe.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_usage_ledger (
      event_id             TEXT PRIMARY KEY,   -- runtime event id; replay-safe dedupe key
      thread_id            TEXT NOT NULL,
      turn_id              TEXT,
      provider_instance_id TEXT,               -- envelope providerInstanceId (nullable during migration)
      requested_model      TEXT,               -- pi AssistantMessage.model, e.g. "claude-fable-5"
      resolved_model       TEXT,               -- responseModel when the provider reports it; NULL today
      input_tokens         INTEGER NOT NULL DEFAULT 0,  -- pure input (no cache buckets)
      cache_read_tokens    INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens   INTEGER NOT NULL DEFAULT 0,
      output_tokens        INTEGER NOT NULL DEFAULT 0,
      cost_usd             REAL NOT NULL DEFAULT 0,     -- provider-authoritative per-message delta
      created_at           TEXT NOT NULL                -- ISO, from the event envelope
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_usage_ledger_created
    ON projection_usage_ledger(created_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_usage_ledger_thread_created
    ON projection_usage_ledger(thread_id, created_at)
  `;
});
