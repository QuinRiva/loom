import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

/**
 * File-centric goal model (architecture-plan v3): goals live as `goal.md`
 * files discovered at runtime, not as a DB aggregate. A thread records the
 * slug of the goal package it was started from via `goal_slug` (nullable);
 * there is no `projection_goals` table and no goal foreign key.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!threadColumns.some((column) => column.name === "goal_slug")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN goal_slug TEXT
    `;
  }
});
