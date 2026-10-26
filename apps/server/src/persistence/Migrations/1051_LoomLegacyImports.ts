import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Pull 9 Phase 4 §1: the ledger of the Loom V1 importer (retired once every
// cockpit V1 thread was imported): one row per V1 thread it considered.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS loom_legacy_imports (
      thread_id TEXT PRIMARY KEY,
      imported_at TEXT NOT NULL,
      status TEXT NOT NULL,
      sidecar_written INTEGER NOT NULL DEFAULT 0,
      lineage_reemitted INTEGER NOT NULL DEFAULT 0,
      session_status TEXT NOT NULL,
      session_path TEXT,
      warnings_json TEXT NOT NULL DEFAULT '[]'
    )
  `;
});
