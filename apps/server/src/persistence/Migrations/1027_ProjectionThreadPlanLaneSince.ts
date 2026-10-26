import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Most recent plan-lane transition: the stable episode clock `briefNeededSinceMs` reads. Unlike
// `updated_at`, which every activity bumps and would re-arm the wake in a loop, receipt-marker and
// activity appends do not advance it. Backfilled null; consumers fall back to `created_at`.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
  const existing = new Set(columns.map((column) => column.name));

  if (!existing.has("plan_lane_since")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN plan_lane_since TEXT`;
  }
});
