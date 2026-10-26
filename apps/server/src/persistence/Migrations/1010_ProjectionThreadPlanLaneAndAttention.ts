import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Splits the conflated `status` column into a plan lane and an attention set (JSON array of
// reasons): a one-time best-effort remap, no compat shim. planned, done map across; running →
// in_progress; review → in_progress + awaiting_acceptance; error → in_progress + error; blocked →
// ready (board-blocked if it still names deps, else needs_guidance).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
  const existing = new Set(columns.map((column) => column.name));

  if (!existing.has("plan_lane")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN plan_lane TEXT NOT NULL DEFAULT 'planned'`;
  }
  if (!existing.has("attention")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN attention TEXT NOT NULL DEFAULT '[]'`;
  }

  if (existing.has("status")) {
    yield* sql`UPDATE projection_threads SET plan_lane = 'in_progress' WHERE status = 'running'`;
    yield* sql`UPDATE projection_threads SET plan_lane = 'done' WHERE status = 'done'`;
    yield* sql`UPDATE projection_threads SET plan_lane = 'in_progress', attention = '["awaiting_acceptance"]' WHERE status = 'review'`;
    yield* sql`UPDATE projection_threads SET plan_lane = 'in_progress', attention = '["error"]' WHERE status = 'error'`;
    yield* sql`UPDATE projection_threads SET plan_lane = 'ready' WHERE status = 'blocked' AND blocked_by IS NOT NULL AND blocked_by != '[]'`;
    yield* sql`UPDATE projection_threads SET plan_lane = 'ready', attention = '["needs_guidance"]' WHERE status = 'blocked' AND (blocked_by IS NULL OR blocked_by = '[]')`;
    yield* sql`ALTER TABLE projection_threads DROP COLUMN status`;
  }
});
