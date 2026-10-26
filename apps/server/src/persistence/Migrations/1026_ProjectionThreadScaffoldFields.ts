import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Child-only columns, null for roots and legacy spawns. `graph_key` is unique and immutable among
// a parent's children and must round-trip here: the decider's key-uniqueness check reads it back.
// `kickoff_brief_path` stays null until workstream_brief attaches one; the dispatcher gates a
// child's first launch on it.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
  const existing = new Set(columns.map((column) => column.name));

  if (!existing.has("graph_key")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN graph_key TEXT`;
  }
  if (!existing.has("kickoff_brief_path")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN kickoff_brief_path TEXT`;
  }
});
