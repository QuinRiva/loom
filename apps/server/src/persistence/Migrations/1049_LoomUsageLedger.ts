import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// V1's usage ledger renamed in place, so rows travel to V2 with no import; columns keep their
// meaning and `event_id` stays the PK. V2 writes one row per terminal provider turn; SQLite cannot
// add a constraint in place, hence the partial unique index. 1014's two indexes move with the
// rename and are renamed to match.
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
