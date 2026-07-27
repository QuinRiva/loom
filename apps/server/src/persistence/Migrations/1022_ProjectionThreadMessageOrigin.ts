import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

// Provenance of a user-role message (loom). Nullable/absent ⇒ human, so every
// historical row keeps rendering as a human send with no backfill. See
// `MessageOrigin` in packages/contracts.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_thread_messages
    ADD COLUMN origin TEXT
  `;
});
