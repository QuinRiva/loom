import * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";

/**
 * Thinking time per message. Derived from created_at/updated_at it read "Thought for 0s" on replay
 * (both collapse to the finalize instant), so ingestion records it where burst boundaries are
 * known. Historical rows stay NULL and render "Thought" without inventing a duration.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_thread_messages
    ADD COLUMN reasoning_ms INTEGER
  `;
});
