import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// When the thread last saw its goal's task tree (spawn snapshot, `goal_task_list`, a write's
// reply): the goal-task tools' "changed by other threads since" mark. Written by those tools, not
// the projector, so it stays out of the row codec. NULL on existing rows: nothing reads as changed.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE loom_thread_workstream ADD COLUMN goal_tree_read_at TEXT`;
});
