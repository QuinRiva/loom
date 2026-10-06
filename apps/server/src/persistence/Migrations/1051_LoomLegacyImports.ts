import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Pull 9 Phase 4 §1: the Loom V1 importer's ledger — one row per V1 thread
// `loom/legacy/LoomV1WorkstreamImporter.ts` has considered, written in the same
// transaction as that thread's sidecar row and events. Deleting a row (server
// stopped) re-processes that thread at the next boot.
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
