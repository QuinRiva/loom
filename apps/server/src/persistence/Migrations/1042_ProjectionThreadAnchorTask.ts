import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Task-tree branch scoping (plans/task-tree-branch-scoping/plan.mdx §1):
// anchor_task_id — the ONE task of the thread's goal whose subtree is the branch
// this thread owns (what it is injected with, what its goal_task_* calls default
// to, what it may restructure). Null = unbound, which is both the legacy value
// and a first-class live state. No foreign key: the anchor is resolved against
// the live tree at read time, so a deleted anchor degrades the thread to unbound
// rather than failing.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
  if (!columns.some((column) => column.name === "anchor_task_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN anchor_task_id TEXT`;
  }
});
