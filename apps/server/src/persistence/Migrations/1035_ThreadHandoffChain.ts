import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// `continues_thread_id`: the predecessor on the same goal, stamped by `goal_continue`, so serial
// handoff order is queryable. `handoff_destinations` (`[{goalId, threadId}, …]`) replaces the lossy
// `handoff_count`; historical counts cannot be rebuilt (the ids were discarded) and are dropped.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
  const existing = new Set(columns.map((column) => column.name));

  if (!existing.has("continues_thread_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN continues_thread_id TEXT`;
  }
  if (!existing.has("handoff_destinations")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN handoff_destinations TEXT NOT NULL DEFAULT '[]'`;
  }
  if (existing.has("handoff_count")) {
    yield* sql`ALTER TABLE projection_threads DROP COLUMN handoff_count`;
  }
});
