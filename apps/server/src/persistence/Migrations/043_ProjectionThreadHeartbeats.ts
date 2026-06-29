import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Liveness heartbeat: a per-thread "last runtime activity at" timestamp that
// advances on ANY runtime event (assistant/reasoning token deltas, tool
// lifecycle, turn boundaries), written debounced by ProviderRuntimeIngestion.
// Unlike the activity-row timeline it captures token/reasoning streaming, so
// the stall rail no longer false-fires on a child reasoning for minutes with
// no tool call. This is a side-channel table: it is never written by the
// event-sourced projector pipeline, only by the debounced ingestion touch.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_heartbeats (
      thread_id TEXT PRIMARY KEY,
      last_activity_at TEXT NOT NULL
    )
  `;
});
