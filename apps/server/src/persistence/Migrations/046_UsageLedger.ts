import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Usage ledger (docs/usage-dashboard-design.md §3 D1): one row per
// `thread.token-usage.updated` runtime event, written by
// ProviderRuntimeIngestion alongside the context-window activity. Feeds the
// /usage dashboard's window breakdowns (per-model tokens/cost, per-thread
// attribution). `event_id` PK + INSERT OR IGNORE makes ingestion replay-safe.
// Like the heartbeats table this is a side channel of ingestion, not written
// by the event-sourced projector pipeline.
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
