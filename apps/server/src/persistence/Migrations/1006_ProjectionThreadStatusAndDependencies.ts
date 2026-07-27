import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
  const existing = new Set(columns.map((column) => column.name));

  if (!existing.has("status")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN status TEXT NOT NULL DEFAULT 'planned'`;
  }
  if (!existing.has("blocked_by")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN blocked_by TEXT NOT NULL DEFAULT '[]'`;
  }
});
