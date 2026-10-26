// Canonicalises legacy `thread.message-reasoning` rows from the incremental `reasoningDelta` shape,
// which no longer decodes and stopped the server booting, to the current full-text payload.
import * as SqlClient from "effect/sql/SqlClient";
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
