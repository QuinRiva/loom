import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// One row per recorded consult, keyed by the originating event id so re-projection is idempotent.
// The asker's `consults` summary aggregates these at query time; the full question and answer live
// on `thread.consult-recorded`, and this row carries only the bounded preview.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_consults (
      event_id TEXT PRIMARY KEY,
      asker_thread_id TEXT NOT NULL,
      target_thread_id TEXT NOT NULL,
      target_title TEXT NOT NULL,
      question_preview TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_consults_asker
      ON projection_thread_consults (asker_thread_id, target_thread_id)
  `;
});
