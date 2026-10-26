import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Worktree isolation: `isolation` is 'isolated' | 'shared' | 'attached' (default 'shared', the
// pre-isolation behaviour); `fan_in_state` is 'none' | 'completed' | 'conflicted' (default 'none').
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
  const existing = new Set(columns.map((column) => column.name));

  if (!existing.has("isolation")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN isolation TEXT NOT NULL DEFAULT 'shared'`;
  }
  if (!existing.has("fan_in_state")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN fan_in_state TEXT NOT NULL DEFAULT 'none'`;
  }
});
