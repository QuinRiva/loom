import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// One row per peer message, keyed by `record_id`, from which delivery/expire/mark command ids derive
// so re-projection, the handler's immediate delivery and the dispatcher rail agree. The row is the
// delivery queue entry (pending -> delivered | expired), the sender shell's `peerMessages` edge and
// the source of `notifySendLog` on restart; it holds the full text, the shell only a preview.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_peer_messages (
      record_id TEXT PRIMARY KEY,
      sender_thread_id TEXT NOT NULL,
      target_thread_id TEXT NOT NULL,
      target_title TEXT NOT NULL,
      message TEXT NOT NULL,
      framed_message TEXT NOT NULL,
      message_preview TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      -- Monotonic append order (the orchestration event sequence). created_at has
      -- only millisecond resolution and record_id is a random UUID, so concurrent
      -- same-millisecond sends to one target need this as the FIFO tiebreaker to
      -- preserve their durable record/event order (D4).
      seq INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      delivered_at TEXT
    )
  `;
  // The dispatcher rail's pending scan: oldest pending row per target (FIFO by
  // created_at then the monotonic seq tiebreaker).
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_peer_messages_pending
      ON projection_thread_peer_messages (target_thread_id, created_at, seq)
      WHERE status = 'pending'
  `;
  // Sender edge aggregation (shell `peerMessages`) + notifySendLog rebuild.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_peer_messages_sender
      ON projection_thread_peer_messages (sender_thread_id, target_thread_id, created_at)
  `;
});
