import * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";

// Structured control-plane payload stored as JSON beside the flattened markdown `text`. NULL means
// a plain message, so historical rows (old control_notice bubbles included) need no backfill.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_thread_messages
    ADD COLUMN control_payload_json TEXT
  `;
});
