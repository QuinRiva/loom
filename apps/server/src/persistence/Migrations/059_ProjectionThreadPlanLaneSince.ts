import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Scaffold-first graph authoring (workstream-scaffold plan §3): a nullable
// timestamp column recording each thread's most recent plan-lane transition.
// It is the stable episode clock the brief-needed liveness backstop and wake
// read (`briefNeededSinceMs`): a node's own `planned → ready` release and a
// dependency reaching `done` via a lane-only `workstream_set_lane` both advance
// it, while an unrelated receipt-marker/activity append does NOT — unlike
// `updated_at`, which every activity bumps and would re-arm the wake in a loop.
// Backfilled null; consumers fall back to `created_at`.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
  const existing = new Set(columns.map((column) => column.name));

  if (!existing.has("plan_lane_since")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN plan_lane_since TEXT`;
  }
});
