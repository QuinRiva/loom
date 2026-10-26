import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The one task whose subtree this thread owns; null means unbound, a first-class live state. No
// foreign key: resolved against the live tree at read time, so a deleted anchor degrades to unbound.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
  if (!columns.some((column) => column.name === "anchor_task_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN anchor_task_id TEXT`;
  }
});
