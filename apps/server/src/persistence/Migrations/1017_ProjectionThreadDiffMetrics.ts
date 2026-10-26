import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Per-thread cumulative added/deleted diff lines, summed from checkpoint file summaries. NULL (not
// 0) until the first checkpoint, so the UI suppresses the chip rather than show a misleading 0.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
  const existing = new Set(columns.map((column) => column.name));

  if (!existing.has("diff_additions")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN diff_additions INTEGER`;
  }
  if (!existing.has("diff_deletions")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN diff_deletions INTEGER`;
  }
});
