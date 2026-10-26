import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// One pending `snooze_thread` request per thread, written mid-turn and applied by the dispatcher's
// snooze rail once the turn ends idle (a mid-turn snooze is undone by the run's completion). Plain
// table, not event-sourced: a request is transient intent, and any thread may hold one.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE loom_thread_snooze_requests (
      thread_id TEXT PRIMARY KEY,
      snoozed_until TEXT NOT NULL,
      requested_at TEXT NOT NULL
    )
  `;
});
