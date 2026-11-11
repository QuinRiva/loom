import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A child its parent declared at spawn as one the human works in turn by turn; never reported as
// gone quiet. No backfill: nothing was declared before the column existed.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE loom_thread_workstream ADD COLUMN human_led INTEGER NOT NULL DEFAULT 0`;
});
