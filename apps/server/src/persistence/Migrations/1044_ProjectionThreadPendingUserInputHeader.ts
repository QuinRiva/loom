import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Agent-question arrival surfaces (plans/agent-question-redesign, increment 3):
// the oldest open question's first header and its asked-at, so the sidebar row,
// board card and notification can say WHICH question is waiting and for how
// long. Folded by `refreshThreadShellSummary` beside `pending_user_input_count`;
// persisted (not derived at read time) because every shell read would otherwise
// pay a correlated activity scan per row.
//
// The projection never refolds old rows on a code change, so threads already
// holding an open question are backfilled here under the same terminal-wins rule
// as the count (Migration 1033): open iff requested and never resolved.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
  if (!columns.some((column) => column.name === "pending_user_input_header")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN pending_user_input_header TEXT`;
  }
  if (!columns.some((column) => column.name === "pending_user_input_since")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN pending_user_input_since TEXT`;
  }

  yield* sql`
    UPDATE projection_threads
    SET (pending_user_input_header, pending_user_input_since) = (
      SELECT
        CASE json_type(requested.payload_json, '$.questions[0].header')
          WHEN 'text' THEN json_extract(requested.payload_json, '$.questions[0].header')
        END,
        requested.created_at
      FROM projection_thread_activities AS requested
      WHERE requested.thread_id = projection_threads.thread_id
        AND requested.kind = 'user-input.requested'
        AND json_type(requested.payload_json, '$.requestId') = 'text'
        AND NOT EXISTS (
          SELECT 1
          FROM projection_thread_activities AS resolved
          WHERE resolved.thread_id = requested.thread_id
            AND resolved.kind = 'user-input.resolved'
            AND json_extract(resolved.payload_json, '$.requestId') =
              json_extract(requested.payload_json, '$.requestId')
        )
      ORDER BY requested.created_at, requested.activity_id
      LIMIT 1
    )
    WHERE pending_user_input_count > 0
  `;
});
