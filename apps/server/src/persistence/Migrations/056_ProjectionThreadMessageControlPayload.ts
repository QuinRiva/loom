import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

// Structured control-plane digest/notice payload for a message (loom), stored as
// JSON alongside the flattened markdown `text`. Nullable/absent ⇒ a plain
// message, so every historical row (including origin=control_notice bubbles
// written before this column existed) keeps rendering as today with no backfill.
// See `ControlPayload` in packages/contracts. Numbering convention: 055 was
// claimed by the concurrent thread-fork worktree (`ProjectionThreadForkSource`),
// so this took the next free slot 056; if another lands first, renumber to the
// next free id and update Migrations.ts accordingly.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_thread_messages
    ADD COLUMN control_payload_json TEXT
  `;
});
