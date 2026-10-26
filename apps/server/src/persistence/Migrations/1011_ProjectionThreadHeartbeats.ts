import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Per-thread last runtime activity, advanced on any runtime event including token and reasoning
// deltas, so the stall rail no longer false-fires on a long reasoning burst. Side-channel table
// written only by ProviderRuntimeIngestion's debounced touch, never by the projector pipeline.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_heartbeats (
      thread_id TEXT PRIMARY KEY,
      last_activity_at TEXT NOT NULL
    )
  `;
});
