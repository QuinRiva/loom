import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Scaffold-first graph authoring (workstream-scaffold plan §3): a nullable
// timestamp column recording each thread's most recent fan-in-settlement
// transition. Third companion to `plan_lane_since` (059) and
// `dependencies_since` (060): `areDependenciesSatisfied` requires an isolated
// dependency's fan-in to reach `completed` (not just `done`) — and, for a node
// behind an attached reviewer, the gated isolated coder's fan-in. That
// settlement can land long after `done`, so its `thread.fanin-set` event is the
// true eligibility transition `briefNeededSinceMs` must date the episode from —
// else the backstop fires immediately when a slow fan-in finally lands. Stamped
// ONLY by `thread.fanin-set`, never by a receipt-marker/activity append (unlike
// `updated_at`, which every activity bumps and would re-arm the wake in a loop).
// Backfilled null; consumers fall back to the older transition stamps.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
  const existing = new Set(columns.map((column) => column.name));

  if (!existing.has("fanin_since")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN fanin_since TEXT`;
  }
});
