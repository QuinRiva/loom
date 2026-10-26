import * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";

import { whenV1TableExists } from "../v1Projections.loom.ts";

/**
 * One-time refold of `pending_user_input_count` under terminal-wins (`@t3tools/shared/openRequests`),
 * since the projection never recomputes old rows when the fold changes. Open iff a request has a
 * `user-input.requested` row and no `user-input.resolved` row, in any order: a latest-state window
 * would let a late `requested` resurrect a settled request.
 */
export default whenV1TableExists(
  "projection_thread_activities",
  Effect.gen(function* () {
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
  }),
);
