import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The child's tip commit, recorded when fan-in merges its branch (or the kept branch tip at
// cancel). Historical marker only, null for rows never disposed; the relocation preamble surfaces
// it so a re-engaged thread knows where its work landed.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
  const existing = new Set(columns.map((column) => column.name));

  if (!existing.has("final_commit_sha")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN final_commit_sha TEXT`;
  }
});
