import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Thread fork (MVP): the source thread a thread was forked from.
// - fork_from_thread_id: nullable thread id. Null for non-forked rows (the
//   default for every pre-fork row). Read by the pi driver at the child's first
//   launch to fork the source's session via native `pi --fork`.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
  const existing = new Set(columns.map((column) => column.name));

  if (!existing.has("fork_from_thread_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN fork_from_thread_id TEXT`;
  }
});
