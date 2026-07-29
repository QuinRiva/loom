import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

/**
 * One-time refold of `pending_user_input_count` under the terminal-wins
 * algorithm (`@t3tools/shared/openRequests`).
 *
 * The projection resumes from `last_applied_sequence` and never recomputes old
 * rows when the fold's CODE changes, so deployed rows keep whatever the previous
 * algorithm produced. Two production threads are stuck at 1 with no resolution
 * they could ever receive; the startup scan settles them going forward, and this
 * makes the historical count agree with the new fold in the same deploy.
 *
 * Terminal-wins, expressed in SQL: a request is open iff a `user-input.requested`
 * row exists for it and NO `user-input.resolved` row exists — regardless of
 * ordering or timestamps. That is why there is no `ROW_NUMBER() … ORDER BY
 * created_at DESC` latest-state window here, unlike migration 024's version of
 * this same column: latest-state is precisely the rule that let a duplicate or
 * late `requested` row resurrect a settled request. `respond.failed` details are
 * no longer consulted at all — resolution is the only clearing signal, and the
 * prose allowlists this migration's predecessor matched on have been deleted.
 *
 * Precedent: `024_BackfillProjectionThreadShellSummary`. Only the count is
 * touched; the derived `awaiting_input` attention flag needs no backfill because
 * it is unioned at read time from this very column.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_threads
    SET pending_user_input_count = COALESCE((
      SELECT COUNT(DISTINCT requested.request_id)
      FROM (
        SELECT DISTINCT json_extract(payload_json, '$.requestId') AS request_id
        FROM projection_thread_activities
        WHERE thread_id = projection_threads.thread_id
          AND kind = 'user-input.requested'
          AND json_extract(payload_json, '$.requestId') IS NOT NULL
      ) AS requested
      WHERE NOT EXISTS (
        SELECT 1
        FROM projection_thread_activities AS resolved
        WHERE resolved.thread_id = projection_threads.thread_id
          AND resolved.kind = 'user-input.resolved'
          AND json_extract(resolved.payload_json, '$.requestId') = requested.request_id
      )
    ), 0)
  `;
});
