import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The sidebar's agent-started cue: a `goal_handoff` destination root records who
// started it (`handoff_origin`, JSON `HandoffOrigin`), stamped by the projector on
// `thread.handoff-recorded`. Backfilled from the callers' existing
// `handoff_destinations` by the projector's rule (`stampHandoffOrigin`): a
// `/handoff` drafter, or a source whose record names another drafter, credits the
// human's source thread as `human` (which wins); any other caller is the `agent`.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE loom_thread_workstream ADD COLUMN handoff_origin TEXT`;
  yield* sql`
    WITH credits AS (
      SELECT json_extract(d.value, '$.threadId') AS destination,
        CASE WHEN c.role = 'handoff-drafter' THEN COALESCE(c.fork_from_thread_id, c.thread_id)
          ELSE c.thread_id END AS origin,
        CASE WHEN c.role = 'handoff-drafter'
          OR json_extract(d.value, '$.drafterThreadId') <> c.thread_id
          THEN 'human' ELSE 'agent' END AS initiated_by
      FROM loom_thread_workstream c, json_each(c.handoff_destinations) d
    )
    UPDATE loom_thread_workstream SET handoff_origin = (
      SELECT json_object('threadId', origin, 'initiatedBy', initiated_by) FROM credits
      WHERE destination = loom_thread_workstream.thread_id
      ORDER BY initiated_by = 'human' DESC LIMIT 1
    )
    WHERE thread_id IN (SELECT destination FROM credits)
  `;
});
