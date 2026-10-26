import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Most recent fan-in-settlement transition, stamped ONLY by `thread.fanin-set`. Fan-in can land
// long after `done`, so `briefNeededSinceMs` dates the episode from it, not from `updated_at`
// (every activity bumps that and would re-arm the wake in a loop). Backfilled null; consumers fall
// back to the older transition stamps.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
  const existing = new Set(columns.map((column) => column.name));

  if (!existing.has("fanin_since")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN fanin_since TEXT`;
  }
});
