import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The V1 thread-search index (old 1045) indexed V1 projections upstream's 063
// dropped, and nothing has read it since pull 9 (DL-82). Its message triggers
// still name the dropped `projection_turns`, so any write to
// `projection_thread_messages` would fail. Triggers on the dropped tables went
// with them.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const trigger of [
    "loom_ts_threads_ai",
    "loom_ts_threads_au",
    "loom_ts_threads_ad",
    "loom_ts_messages_ai",
    "loom_ts_messages_au",
    "loom_ts_messages_ad",
    "loom_ts_goals_ai",
    "loom_ts_goals_au",
    "loom_ts_goals_ad",
    "loom_ts_tasks_ai",
    "loom_ts_tasks_au",
    "loom_ts_tasks_ad",
  ])
    yield* sql.unsafe(`DROP TRIGGER IF EXISTS ${trigger}`);
  yield* sql`DROP TABLE IF EXISTS loom_thread_search`;
  yield* sql`DROP TABLE IF EXISTS loom_thread_embeddings`;
});
