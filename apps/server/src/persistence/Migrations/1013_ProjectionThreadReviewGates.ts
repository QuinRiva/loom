import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Review gates (docs/design/workstream-review-gates.md §8): durable per-thread
// routing state.
// - routes: outcome route edges declared at spawn (JSON array; '[]' default).
// - gate_rounds: loop traversals consumed (projected from thread.route-taken).
// - pending_rework: 0/1 — an open rework round on a gate target.
// - last_outcome: the most recent submitted outcome record (JSON, nullable).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
  const existing = new Set(columns.map((column) => column.name));

  if (!existing.has("routes")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN routes TEXT NOT NULL DEFAULT '[]'`;
  }
  if (!existing.has("gate_rounds")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN gate_rounds INTEGER NOT NULL DEFAULT 0`;
  }
  if (!existing.has("pending_rework")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN pending_rework INTEGER NOT NULL DEFAULT 0`;
  }
  if (!existing.has("last_outcome")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN last_outcome TEXT`;
  }
});
