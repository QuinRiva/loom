import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Digests written before the `human-message` item kind was retired (b9143bd292) no longer decode.
// Strip those items from each message and from every `message.updated` copy of it, so a rebuild
// matches. The message stays (a run's `userMessageId` names it) with its text, the bytes the agent
// read; one left with no items keeps an empty card. `instr` first: it skips the JSON walk elsewhere.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE orchestration_v2_projection_messages
    SET payload_json = json_set(payload_json, '$.loom.controlPayload.items', (
      SELECT json_group_array(json(value))
      FROM json_each(payload_json, '$.loom.controlPayload.items')
      WHERE json_extract(value, '$.kind') IS NOT 'human-message'
    ))
    WHERE instr(payload_json, '"human-message"') > 0
      AND EXISTS (
        SELECT 1 FROM json_each(payload_json, '$.loom.controlPayload.items')
        WHERE json_extract(value, '$.kind') = 'human-message'
      )
  `;
  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(payload_json, '$.loom.controlPayload.items', (
      SELECT json_group_array(json(value))
      FROM json_each(payload_json, '$.loom.controlPayload.items')
      WHERE json_extract(value, '$.kind') IS NOT 'human-message'
    ))
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
