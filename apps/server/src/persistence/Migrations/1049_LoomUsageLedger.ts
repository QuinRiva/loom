import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Pull 9 Phase 3 (track 3c, seam 11): V1's usage ledger (1014 / 1019 / 1043)
// renamed in place, so its rows travel to V2 with no import step. V1's columns
// keep their names and meaning (input_tokens is pure input, cache buckets
// separate); `event_id` stays the primary key (V2 fills it with the
// provider-turn.updated event id). V2 writes one row per terminal provider
// turn, so the turn is unique where known — SQLite cannot add a constraint in
// place, hence the partial unique index. The rename carries 1014's two indexes
// with it (re-pointed at the new table); they are renamed only so their names
// match the table.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_usage_ledger RENAME TO loom_usage_ledger`;
  yield* sql`ALTER TABLE loom_usage_ledger ADD COLUMN run_id TEXT`;
  yield* sql`ALTER TABLE loom_usage_ledger ADD COLUMN provider_turn_id TEXT`;
  yield* sql`
    CREATE UNIQUE INDEX idx_loom_usage_turn ON loom_usage_ledger(provider_turn_id)
    WHERE provider_turn_id IS NOT NULL
  `;
  yield* sql`DROP INDEX IF EXISTS idx_usage_ledger_created`;
  yield* sql`DROP INDEX IF EXISTS idx_usage_ledger_thread_created`;
  yield* sql`CREATE INDEX idx_loom_usage_created ON loom_usage_ledger(created_at)`;
  yield* sql`
    CREATE INDEX idx_loom_usage_thread_created ON loom_usage_ledger(thread_id, created_at)
  `;
});
