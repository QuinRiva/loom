import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

/**
 * Thinking time per message, in milliseconds.
 *
 * The web header ("Thought for Xs") used to derive its duration from the
 * message's own `created_at`/`updated_at`, which measure the message rather than
 * the thinking — and in the durable record both collapse to the single finalize
 * instant, so every replayed reasoning block read "Thought for 0s". The duration
 * is now computed where the burst boundaries are actually known (provider
 * ingestion) and persisted here. Historical rows stay NULL: the duration was
 * never recorded, so the header renders "Thought" without inventing one.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_thread_messages
    ADD COLUMN reasoning_ms INTEGER
  `;
});
