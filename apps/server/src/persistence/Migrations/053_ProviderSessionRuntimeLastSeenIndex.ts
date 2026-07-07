import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Matches listRuntimeRows: ORDER BY last_seen_at ASC, thread_id ASC.
  // Removes the SCAN + TEMP B-TREE (sort) that dominated 4,444 calls / 411s.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_session_runtime_last_seen_thread
    ON provider_session_runtime(last_seen_at, thread_id)
  `;
});
