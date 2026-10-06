import * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_thread_messages
    ADD COLUMN reasoning_text TEXT
  `;
  yield* sql`
    ALTER TABLE projection_thread_messages
    ADD COLUMN reasoning_streaming INTEGER
  `;
});
