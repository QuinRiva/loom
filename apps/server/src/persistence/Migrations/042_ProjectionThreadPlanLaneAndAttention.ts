import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Three-axis state model (.plans/workstream-state-model-design.md): the single
// conflated `status` column is split into a plan lane (intent) and an attention
// set (needs-a-human). Best-effort one-time remap (design §9), no compat shim —
// the `status` column is dropped. `attention` is a JSON array of reasons.
//
// Remap:
//   planned → planned                       running → in_progress
//   review  → in_progress + awaiting_acceptance
//   done    → done                          error   → in_progress + error
//   blocked → ready (board-blocked when it still names deps; else needs_guidance)
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
