import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Count of `goal_handoff` calls a handoff-drafter root has placed (one `thread.handoff-recorded`
// each). At turn end the settlement reactor converges and archives on 1+, raises attention on 0.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
  const existing = new Set(columns.map((column) => column.name));

  if (!existing.has("handoff_count")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN handoff_count INTEGER NOT NULL DEFAULT 0`;
  }
});
