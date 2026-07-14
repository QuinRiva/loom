import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Scaffold-first graph authoring (workstream-scaffold plan §3): a nullable
// timestamp column recording each thread's most recent dependency-set
// transition. Companion to `plan_lane_since` (migration 059): a
// `workstream_set_dependencies` that removes/replaces a dependency can re-enter
// the brief-needed state (e.g. an unfinished dep swapped for an already-`done`
// one), and only this stable, transition-derived stamp advances the eligibility
// episode `briefNeededSinceMs` reads — so a fresh batched wake and a fresh
// liveness grace window fire. Stamped ONLY by `thread.dependencies-set`, never
// by a receipt-marker/activity append (unlike `updated_at`, which every
// activity bumps and would re-arm the wake in a loop). Backfilled null;
// consumers fall back to `created_at`/`plan_lane_since`.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
  const existing = new Set(columns.map((column) => column.name));

  if (!existing.has("dependencies_since")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN dependencies_since TEXT`;
  }
});
