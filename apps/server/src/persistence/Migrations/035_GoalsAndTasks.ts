import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

/**
 * DB-authoritative goals/tasks (architecture-plan v4): goals and their task
 * trees become first-class event-sourced aggregates instead of file-discovered
 * `goal.md` packages. Threads reference a goal by stable id (`goal_id`) rather
 * than the worktree-ambiguous `goal_slug`, which is dropped — there is no
 * coexistence period.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_goals (
      goal_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      deleted_at TEXT,
      UNIQUE (project_id, slug)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_goal_tasks (
      task_id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      parent_task_id TEXT,
      position INTEGER NOT NULL,
      text TEXT NOT NULL,
      done INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      FOREIGN KEY (goal_id) REFERENCES projection_goals(goal_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_goals_project_id
    ON projection_goals(project_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_goal_tasks_goal_id
    ON projection_goal_tasks(goal_id)
  `;

  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!threadColumns.some((column) => column.name === "goal_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN goal_id TEXT
    `;
  }
  if (threadColumns.some((column) => column.name === "goal_slug")) {
    yield* sql`
      ALTER TABLE projection_threads
      DROP COLUMN goal_slug
    `;
  }
});
