import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Pull 9 Phase 2 §5 (D12): V1's consult and peer-message edge tables renamed in
// place. Upstream's importer preserves thread ids, so the history stays valid.
// Unguarded: 1016 / 1032 created them on every database this ledger has touched.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_thread_consults RENAME TO loom_thread_consults`;
  yield* sql`ALTER TABLE projection_thread_peer_messages RENAME TO loom_thread_peer_messages`;
});
