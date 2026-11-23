import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Digests with the retired `human-message` item kind no longer decode: strip those items from each
// message and every `message.updated` copy so a rebuild matches. The message (a run's `userMessageId`)
// keeps its text; one left with no items keeps an empty card. `instr` skips the JSON walk elsewhere;
// `json((…))` keeps the array an array, since Node 26.13.1's SQLite drops the subtype in a subquery.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE orchestration_v2_projection_messages
    SET payload_json = json_set(payload_json, '$.loom.controlPayload.items', json((
      SELECT json_group_array(json(value))
      FROM json_each(payload_json, '$.loom.controlPayload.items')
      WHERE json_extract(value, '$.kind') IS NOT 'human-message'
    )))
    WHERE instr(payload_json, '"human-message"') > 0
      AND EXISTS (
        SELECT 1 FROM json_each(payload_json, '$.loom.controlPayload.items')
        WHERE json_extract(value, '$.kind') = 'human-message'
      )
  `;
  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(payload_json, '$.loom.controlPayload.items', json((
      SELECT json_group_array(json(value))
      FROM json_each(payload_json, '$.loom.controlPayload.items')
      WHERE json_extract(value, '$.kind') IS NOT 'human-message'
    )))
    WHERE event_type = 'message.updated'
      AND application_event_version = 2
      AND aggregate_kind = 'thread'
      AND instr(payload_json, '"human-message"') > 0
      AND EXISTS (
        SELECT 1 FROM json_each(payload_json, '$.loom.controlPayload.items')
        WHERE json_extract(value, '$.kind') = 'human-message'
      )
  `;
});
