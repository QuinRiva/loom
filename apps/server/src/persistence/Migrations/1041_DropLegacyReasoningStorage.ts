import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Retires loom's "ephemeral reasoning v2" storage, now that migration 1038's
 * copy onto upstream's `role = 'reasoning'` message rows has been verified
 * against real data.
 *
 * Two halves of one retirement, hence one migration. The three columns have
 * been write-dead and read-dead since the reasoning re-home, and the
 * `thread.message-reasoning` events were kept only so a replay across the
 * historical event store could still decode them — the same change that
 * deletes the rows drops the event literal and its payload schema from
 * `orchestration.loom.ts`, so they must not outlive each other.
 *
 * No index, trigger or view on the real schema references the three columns,
 * so `DROP COLUMN` needs no table rebuild. Deleting events leaves gaps in
 * `stream_version`, which the store tolerates: it appends at
 * `max(stream_version) + 1` and reads in `sequence` order.
 *
 * See `docs/upstream-sync/26-reasoning-rehome.md`.
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
