import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * 1045's message insert/update triggers name `projection_turns`, which upstream's 063 drops. A
 * trigger naming a missing table fails every write to its table and every later `ALTER TABLE …
 * RENAME`, so drop just this pair; the search tables, rows and healthy triggers stay.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TRIGGER IF EXISTS loom_ts_messages_ai`;
  yield* sql`DROP TRIGGER IF EXISTS loom_ts_messages_au`;
});
