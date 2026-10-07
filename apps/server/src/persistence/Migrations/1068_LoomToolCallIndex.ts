import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Pull 9 QA fix (W5): the board card's tool-call count (`LoomStore.shellFields`)
// counts a thread's tool turn items from this index alone, so the shell read
// never touches the item rows. Keep the type list aligned with that query.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX loom_turn_items_tool_calls_idx
    ON orchestration_v2_projection_turn_items(thread_id)
    WHERE type IN ('command_execution', 'file_change', 'file_search', 'web_search', 'dynamic_tool')
  `;
});
