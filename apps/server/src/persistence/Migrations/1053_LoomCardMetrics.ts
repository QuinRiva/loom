import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Pull 9 QA fix (W5): what the board card's tool count and context chip read
// (`LoomStore.shellFields`).
// - The partial index lets the shell read count a thread's tool turn items
//   from the index alone. Keep its type list aligned with that query.
// - `loom_thread_imported_metrics` keeps V1's own figures for each thread
//   (`projection_threads`, columns from 1012), copied once: V2's copy of the
//   V1 database is seeded before migrations run, so this sees every V1
//   thread. An imported card adds V2's tool items to V1's count and shows V1's
//   context until V2 reports one.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX loom_turn_items_tool_calls_idx
    ON orchestration_v2_projection_turn_items(thread_id)
    WHERE type IN ('command_execution', 'file_change', 'file_search', 'web_search', 'dynamic_tool')
  `;
  yield* sql`
    CREATE TABLE loom_thread_imported_metrics (
      thread_id TEXT PRIMARY KEY,
      tool_calls INTEGER NOT NULL,
      used_tokens INTEGER,
      max_tokens INTEGER
    )
  `;
  yield* sql`
    INSERT INTO loom_thread_imported_metrics (thread_id, tool_calls, used_tokens, max_tokens)
    SELECT thread_id, COALESCE(tool_uses, 0), used_tokens, max_tokens
    FROM projection_threads
    WHERE tool_uses > 0 OR used_tokens IS NOT NULL
  `;
});
