import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// D-notify: durable per-thread fields for upward completion propagation.
// - spawn_generation: the parent's turn id at spawn time, grouping sibling
//   sub-threads into one join barrier (recomputable from the read model).
// - report_path: pointer to the on-disk completion report markdown file.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
  const existing = new Set(columns.map((column) => column.name));

  if (!existing.has("spawn_generation")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN spawn_generation TEXT`;
  }
  if (!existing.has("report_path")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN report_path TEXT`;
  }
});
