import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

/**
 * Carries the fork's retired "ephemeral reasoning v2" data onto upstream's
 * model.
 *
 * Loom used to hang a thinking trace off the assistant row it preceded, as a
 * `reasoning_text` column. Upstream persists the trace as its own message row
 * with `role = 'reasoning'`, which is what the server writes and the client
 * renders now — so without this migration every historical thought disappears
 * from the timeline.
 *
 * One reasoning row per assistant row that carries text, stamped one
 * millisecond before its assistant message so it sorts above the answer it led
 * to (`ORDER BY created_at, message_id`). The id is derived from the assistant
 * id, so `INSERT OR IGNORE` makes a re-run a no-op.
 *
 * `reasoning_text` itself is deliberately left in place for now: the column and
 * its two siblings are dropped once the copy has been verified against real
 * data. See `docs/upstream-sync/26-reasoning-rehome.md`.
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
