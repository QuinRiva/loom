import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// loom_thread_history: the workstream Timeline's record of past states (outcomes, flags, routes, gate
// rounds), written by the Loom projector at commit time from this migration on. Backfilled once from the
// log rows pull 15's prune guard kept alive. This is the LAST fork migration that may read old
// orchestration_events rows (pull 15 §4.4): after the guard goes, the log is a day deep.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE loom_thread_history (
      event_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      stream_version INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      command_id TEXT,
      event_version INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX idx_loom_history_thread ON loom_thread_history(thread_id, stream_version)`;
  yield* sql`
    INSERT INTO loom_thread_history
      (event_id, thread_id, stream_version, event_type, occurred_at, command_id, event_version, payload_json)
    SELECT event_id, stream_id, stream_version, event_type, occurred_at, command_id,
      application_event_version, payload_json
    FROM orchestration_events
    WHERE aggregate_kind = 'thread' AND event_type IN (
      'thread.report-set', 'thread.outcome-recorded', 'thread.attention-raised',
      'thread.attention-cleared', 'thread.route-taken', 'thread.gate-rework-accepted',
      'thread.outcome-set', 'thread.plan-lane-set', 'thread.gate-warning')
    ORDER BY sequence
  `;
});
