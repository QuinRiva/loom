import * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";

/**
 * Copies loom's `reasoning_text` column onto upstream's `role = 'reasoning'` message rows, or every
 * historical thought disappears. Each row is stamped 1 ms before its assistant message so it sorts
 * above it, with an id derived from the assistant id so INSERT OR IGNORE makes re-runs no-ops.
 * Migration 1041 drops the old columns.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    INSERT OR IGNORE INTO projection_thread_messages (
      message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
    )
    SELECT
      'reasoning:legacy:' || message_id,
      thread_id,
      turn_id,
      'reasoning',
      reasoning_text,
      0,
      COALESCE(
        strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '-0.001 seconds'),
        created_at
      ),
      updated_at
    FROM projection_thread_messages
    WHERE reasoning_text IS NOT NULL
      AND trim(reasoning_text) <> ''
      AND role <> 'reasoning'
  `;
});
