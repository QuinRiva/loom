import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A thread's own deferred snooze (`mcp__t3-code__snooze_thread`): one pending request
// per thread, written by the tool mid-turn and consumed by the dispatcher's snooze rail
// once that turn has ended idle (a snooze applied mid-turn is undone by the run's
// completion). Plain table, not event-sourced: a request is transient intent, and any
// thread may hold one, sidecar row or not. Starts empty.
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
