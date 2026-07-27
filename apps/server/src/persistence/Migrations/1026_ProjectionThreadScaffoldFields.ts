import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Scaffold-first graph authoring (workstream-scaffold plan §1a + "Key scoping"):
// two nullable child-only columns.
// - graph_key: the symbolic graph key assigned at scaffold time, unique-forever
//   + immutable among a parent's children. Null for legacy spawns / roots. The
//   decider's key-uniqueness check reads it back from the SQL-hydrated command
//   read model, so it must round-trip through this column.
// - kickoff_brief_path: absolute path to the child's kickoff-brief markdown
//   file. Null until workstream_brief attaches one; the dispatcher gates a
//   child's first launch on it being non-null.
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
