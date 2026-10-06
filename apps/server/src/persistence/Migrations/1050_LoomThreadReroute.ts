import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Pull 9 Phase 3 (track 3c, seam 12): the reroute sweep's record of a pi thread
// moved onto the fallback model (`loom/economics/rerouteRecord.ts`). The two
// selections are JSON `ModelSelection`. Starts empty.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE loom_thread_reroute (
      thread_id TEXT PRIMARY KEY,
      intended_selection TEXT,
      rerouted_selection TEXT,
      rerouted_at TEXT,
      window_label TEXT,
      reset_at TEXT
    )
  `;
});
