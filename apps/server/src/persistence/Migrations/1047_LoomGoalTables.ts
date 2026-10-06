import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Pull 9 Phase 2 §5 (D12): V1's goal tables renamed in place — the data
// travels and SQLite rewrites the task table's FK reference. Unguarded: 1003
// created both on every database this ledger has touched.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_goals RENAME TO loom_goals`;
  yield* sql`ALTER TABLE projection_goal_tasks RENAME TO loom_goal_tasks`;
});
