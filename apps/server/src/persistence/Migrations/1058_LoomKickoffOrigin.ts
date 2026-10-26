import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Who wrote a thread's first turn, stamped from `thread.kickoff-recorded`, so the agent-started
// rail tells an unedited `goal_continue` launch (`kickoff`) from an edited one (`user`). Backfilled
// from the first user message by the event's rule: its Loom origin, else `user` for a human, else
// `other`; a V1 message without Loom fields counts as `createdBy`.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE loom_thread_workstream ADD COLUMN kickoff_origin TEXT`;
  yield* sql`
    UPDATE loom_thread_workstream SET kickoff_origin = (
      SELECT COALESCE(
        json_extract(m.payload_json, '$.loom.origin'),
        CASE WHEN COALESCE(
          json_extract(m.payload_json, '$.loom.humanAuthored'),
          json_extract(m.payload_json, '$.createdBy') = 'user'
        ) THEN 'user' ELSE 'other' END
      )
      FROM orchestration_v2_projection_messages m
      WHERE m.thread_id = loom_thread_workstream.thread_id AND m.role = 'user'
      ORDER BY m.created_at, m.message_id LIMIT 1
    )
    WHERE kickoff_at IS NOT NULL
  `;
});
