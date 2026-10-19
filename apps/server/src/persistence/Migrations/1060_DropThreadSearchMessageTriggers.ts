import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * 1045's message insert/update triggers name `projection_turns`, which upstream's
 * 063 drops (its own three triggers went with it). A trigger naming a missing
 * table fails every write to its table and every later `ALTER TABLE … RENAME`
 * anywhere in the schema, so drop just this pair: the search tables, their rows
 * and the healthy triggers stay for the reimplemented thread search (pull 12
 * DL-1320).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TRIGGER IF EXISTS loom_ts_messages_ai`;
  yield* sql`DROP TRIGGER IF EXISTS loom_ts_messages_au`;
});
