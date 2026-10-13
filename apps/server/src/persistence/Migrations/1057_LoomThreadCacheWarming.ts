import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Cache gauge effective expiry: `touched_at` gives way to the facts a client needs to replay pi's
// keep-alive schedule — the last real request's dispatch and end, the last ping that landed, and
// the idle plan (`scheduled` | `stopped` | NULL = undecided). Existing rows keep their ring until
// their next turn: their last touch becomes the request end, and no pi process survives the
// restart that runs this, so their plan is `stopped`.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE loom_thread_cache ADD COLUMN request_started_at TEXT`;
  yield* sql`ALTER TABLE loom_thread_cache ADD COLUMN request_ended_at TEXT`;
  yield* sql`ALTER TABLE loom_thread_cache ADD COLUMN pinged_at TEXT`;
  yield* sql`ALTER TABLE loom_thread_cache ADD COLUMN warming TEXT`;
  yield* sql`UPDATE loom_thread_cache SET request_ended_at = touched_at, warming = 'stopped'`;
  yield* sql`ALTER TABLE loom_thread_cache DROP COLUMN touched_at`;
});
