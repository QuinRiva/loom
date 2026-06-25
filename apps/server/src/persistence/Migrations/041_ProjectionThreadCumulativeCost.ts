import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Context cost meter: per-thread cumulative dollar spend, folded from the
// durable activity log (sum of every `context-window.updated` activity's
// `costUsd`) so it is deterministic on replay. REAL, NOT NULL, default 0 so
// pre-existing rows and non-pi threads (which carry no cost) read as 0.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
  const existing = new Set(columns.map((column) => column.name));

  if (!existing.has("cumulative_cost_usd")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN cumulative_cost_usd REAL NOT NULL DEFAULT 0`;
  }
});
