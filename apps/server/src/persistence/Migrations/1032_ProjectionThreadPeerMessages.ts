import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// notify_thread (cross-thread push): one row per recorded peer message, keyed
// by the handler-generated `record_id` (stable correlation key from which the
// delivery/expire/mark command ids derive, so a re-projection is idempotent and
// the handler's immediate delivery attempt and the dispatcher rail agree on the
// same deterministic ids). The row is simultaneously the durable delivery-queue
// entry (status lifecycle pending -> delivered | expired), the observability
// edge aggregated onto the SENDER shell's `peerMessages` at query time, and the
// source the command read model reconstructs `notifySendLog` from on restart.
// The full raw + framed text live here; the shell carries only the bounded
// preview.
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
