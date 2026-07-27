import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Worktree isolation (docs plan workstream-worktree-isolation §1/§3): per-thread
// isolation policy + fan-in settlement.
// - isolation: 'isolated' | 'shared' | 'attached' (default 'shared' — today's
//   shared-worktree behaviour for pre-isolation rows).
// - fan_in_state: 'none' | 'completed' | 'conflicted' (default 'none').
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
