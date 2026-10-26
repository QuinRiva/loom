import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Upstream's 069 trigram index has no reader in Loom (search runs on `loom_thread_search`), yet its
 * triggers tokenise every finished message. Triggers first: one left naming a missing table fails
 * every write to the messages table. `IF EXISTS`: 069 skips both on SQLite without trigram FTS5.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TRIGGER IF EXISTS orchestration_v2_message_search_insert`;
  yield* sql`DROP TRIGGER IF EXISTS orchestration_v2_message_search_update`;
  yield* sql`DROP TRIGGER IF EXISTS orchestration_v2_message_search_delete`;
  yield* sql`DROP TABLE IF EXISTS orchestration_v2_message_search`;
});
