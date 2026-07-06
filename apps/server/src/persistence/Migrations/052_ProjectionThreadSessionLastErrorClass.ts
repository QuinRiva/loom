import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Classification of a session's last error (e.g. "quota_exhausted"), persisted
// alongside `last_error` so the exhaustion resume sweep can find limit-stalled
// sessions across restarts without re-parsing the raw string. Nullable TEXT:
// genuinely unknown for sessions that never errored (and for errors predating
// classification).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_thread_sessions)`;
  const existing = new Set(columns.map((column) => column.name));

  if (!existing.has("last_error_class")) {
    yield* sql`ALTER TABLE projection_thread_sessions ADD COLUMN last_error_class TEXT`;
  }
});
