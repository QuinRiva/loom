// Enabling runtime-data fix carried alongside the DB goals/tasks migration.
// It is NOT unrelated collateral: the goals/tasks dogfood work failed to start
// because legacy `thread.message-reasoning` rows used an incremental
// `reasoningDelta` shape that no longer decodes. This migration canonicalises
// those rows to the current full-text reasoning payload so the dogfood server
// boots and the goals/tasks pipeline can be exercised end to end. See
// progress.md ("Notes / findings") for the author-session consult that
// confirmed keeping it in this branch.
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    WITH cumulative_reasoning AS (
      SELECT
        sequence,
        group_concat(json_extract(payload_json, '$.reasoningDelta'), '') OVER (
          PARTITION BY stream_id, json_extract(payload_json, '$.messageId')
          ORDER BY sequence
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS reasoning_text
      FROM orchestration_events
      WHERE event_type = 'thread.message-reasoning'
        AND json_type(payload_json, '$.reasoningText') IS NULL
        AND json_type(payload_json, '$.reasoningDelta') IS NOT NULL
    )
    UPDATE orchestration_events
    SET payload_json = json_remove(
      json_set(
        payload_json,
        '$.reasoningText', (SELECT reasoning_text FROM cumulative_reasoning WHERE cumulative_reasoning.sequence = orchestration_events.sequence),
        '$.reasoningStreaming', json('false')
      ),
      '$.reasoningDelta'
    )
    WHERE sequence IN (SELECT sequence FROM cumulative_reasoning)
  `;
});
