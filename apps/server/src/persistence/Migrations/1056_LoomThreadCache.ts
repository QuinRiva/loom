import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Prompt-cache keeping (plans/prompt-cache-keeping): one row per pi thread. The
// session composer writes `retention` ('long' | 'short', the arm for life) at
// every launch; the pi adapter writes `touched_at` on each cache-warming ping.
// Plain table, not event-sourced; the shell join reads it. Starts empty.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE loom_thread_cache (
      thread_id TEXT PRIMARY KEY,
      retention TEXT NOT NULL,
      touched_at TEXT
    )
  `;
});
