import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Replaces `touched_at` with what a client needs to replay pi's keep-alive schedule: last request
// dispatch and end, last landed ping, idle plan (`scheduled` | `stopped` | NULL = undecided).
// Existing rows: last touch becomes the request end and the plan `stopped`, since no pi process
// survives the restart that runs this.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE loom_thread_cache ADD COLUMN request_started_at TEXT`;
  yield* sql`ALTER TABLE loom_thread_cache ADD COLUMN request_ended_at TEXT`;
  yield* sql`ALTER TABLE loom_thread_cache ADD COLUMN pinged_at TEXT`;
  yield* sql`ALTER TABLE loom_thread_cache ADD COLUMN warming TEXT`;
  yield* sql`UPDATE loom_thread_cache SET request_ended_at = touched_at, warming = 'stopped'`;
  yield* sql`ALTER TABLE loom_thread_cache DROP COLUMN touched_at`;
});
