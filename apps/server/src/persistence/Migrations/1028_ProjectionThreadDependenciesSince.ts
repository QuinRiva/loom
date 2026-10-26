import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Most recent dependency-set transition, stamped ONLY by `thread.dependencies-set`. Replacing a
// dependency can re-enter brief-needed; this stamp advances `briefNeededSinceMs`'s episode so a
// fresh wake and grace window fire, where `updated_at` would re-arm the wake on every activity.
// Backfilled null; consumers fall back to `created_at`/`plan_lane_since`.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
  const existing = new Set(columns.map((column) => column.name));

  if (!existing.has("dependencies_since")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN dependencies_since TEXT`;
  }
});
