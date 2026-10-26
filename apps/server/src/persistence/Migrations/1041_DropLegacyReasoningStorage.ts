import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Retires "ephemeral reasoning v2" storage after 1038's copy was verified. Columns and the
 * `thread.message-reasoning` events go together: the event schema left `orchestration.loom.ts` in
 * the same change. Nothing references the columns, so DROP COLUMN needs no rebuild; the store
 * tolerates `stream_version` gaps (it appends at max + 1 and reads in `sequence` order).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = new Set(
    (yield* sql<{ name: string }>`PRAGMA table_info(projection_thread_messages)`).map(
      (column) => column.name,
    ),
  );
  for (const column of ["reasoning_text", "reasoning_streaming", "reasoning_ms"]) {
    if (columns.has(column)) {
      yield* sql`ALTER TABLE projection_thread_messages DROP COLUMN ${sql(column)}`;
    }
  }

  yield* sql`DELETE FROM orchestration_events WHERE event_type = 'thread.message-reasoning'`;
});
