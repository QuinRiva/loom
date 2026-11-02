import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A gate's verdict may traverse several siblings, so the sidecar's current-round traversal becomes
// a list. Rework and resolve legs are then keyed per sibling (`…:rework:<sibling>`); every historical
// receipt's `aggregate_id` is the leg's target, so re-keying it by that id keeps finished gates'
// legs receipted and never re-sent. Re-verify ids are unchanged.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE loom_thread_workstream ADD COLUMN last_routes TEXT NOT NULL DEFAULT '[]'`;
  yield* sql`
    UPDATE loom_thread_workstream
    SET last_routes = json_array(json(last_route))
    WHERE last_route IS NOT NULL
  `;
  yield* sql`ALTER TABLE loom_thread_workstream DROP COLUMN last_route`;
  yield* sql`
    UPDATE orchestration_command_receipts
    SET command_id = command_id || ':' || aggregate_id
    WHERE command_id GLOB 'server:workstream-gate:*:rework'
       OR command_id GLOB 'server:workstream-gate:*:resolve'
  `;
});
