import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// consult_thread observability: one row per recorded consult (keyed by the
// originating event id, so re-projection is idempotent). The asker shell's
// `consults` edge summary is aggregated from these rows at query time
// (COUNT + latest target title / question preview per asker→target pair), so
// no derived counters need maintaining. The full question + answer of each
// consult live on the `thread.consult-recorded` event, not here — this table
// only carries the bounded preview the shell needs.
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
