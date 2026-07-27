import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// `/handoff` fork-drafter (plan §4 Phase 1): durable per-thread count of the
// `goal_handoff` calls a handoff-drafter root has placed (one
// `thread.handoff-recorded` event each). The settlement reactor reads it at the
// drafter's turn end to decide converge-and-archive (≥1) vs raise-attention (0).
// Additive column, default 0 so every pre-handoff row loads unchanged.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
  const existing = new Set(columns.map((column) => column.name));

  if (!existing.has("handoff_count")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN handoff_count INTEGER NOT NULL DEFAULT 0`;
  }
});
