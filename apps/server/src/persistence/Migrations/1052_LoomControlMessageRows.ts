import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Repairs control-message rows written before they were stamped, in the projection and the writing
// event so a rebuild keeps it; a no-op on a fresh cut-over. Imported V1 rows with a V1 `origin` get
// `message.loom` + `createdBy: "agent"` (a human's row is untouched); V2 control wakes' bare
// `notification` activity items become the `user_message` they were built as.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE orchestration_v2_projection_messages AS message
    SET payload_json = json_set(
      message.payload_json, '$.createdBy', 'agent', '$.loom', json(legacy.loom)
    )
    FROM (
      SELECT
        message_id,
        json_patch(
          json_object('origin', origin, 'humanAuthored', json('false')),
          json_object(
            'controlPayload',
            CASE WHEN json_valid(control_payload_json) THEN json(control_payload_json) END
          )
        ) AS loom
      FROM projection_thread_messages
      WHERE role = 'user' AND origin IN ('kickoff', 'orchestrator', 'control_notice', 'notify')
    ) AS legacy
    WHERE message.message_id = legacy.message_id
      AND message.thread_id IN (SELECT thread_id FROM orchestration_v2_legacy_imports)
      AND json_type(message.payload_json, '$.loom') IS NULL
  `;
  yield* sql`
    UPDATE orchestration_v2_projection_turn_items AS item
    SET payload_json = json_set(item.payload_json, '$.createdBy', 'agent')
    FROM orchestration_v2_projection_messages AS message
    WHERE item.turn_item_id = 'migration:v1:turn-item:' || message.message_id
      AND item.type = 'user_message'
      AND json_extract(item.payload_json, '$.createdBy') = 'user'
      AND json_type(message.payload_json, '$.loom.origin') IS NOT NULL
  `;

  // Item ids follow `IdAllocator.derive.userTurnItem` (`encodeURIComponent` of a server id).
  yield* sql`
    UPDATE orchestration_v2_projection_turn_items AS item
    SET
      type = 'user_message',
      payload_json = json_patch(
        json_remove(item.payload_json, '$.source', '$.outcome', '$.summary', '$.detail'),
        json_object(
          'type', 'user_message',
          'messageId', message.message_id,
          'inputIntent', 'turn_start',
          'text', json_extract(message.payload_json, '$.text'),
          'attachments', json(json_extract(message.payload_json, '$.attachments')),
          'createdBy', json_extract(message.payload_json, '$.createdBy'),
          'creationSource', json_extract(message.payload_json, '$.creationSource'),
          'senderThreadId', json_extract(message.payload_json, '$.senderThreadId')
        )
      )
    FROM orchestration_v2_projection_messages AS message
    WHERE item.type = 'notification'
      AND item.thread_id = message.thread_id
      AND item.turn_item_id = 'turn-item:message:' || replace(replace(message.message_id, '%', '%25'), ':', '%3A')
      AND json_type(message.payload_json, '$.loom.origin') IS NOT NULL
  `;

  // The events: copy each repaired projection payload onto the event that wrote it.
  yield* sql`
    UPDATE orchestration_events AS event
    SET payload_json = message.payload_json
    FROM orchestration_v2_projection_messages AS message
    WHERE event.event_id = 'migration:v1:message:' || message.message_id
      AND json_type(message.payload_json, '$.loom.origin') IS NOT NULL
      AND json_type(event.payload_json, '$.loom') IS NULL
  `;
  yield* sql`
    UPDATE orchestration_events AS event
    SET payload_json = item.payload_json
    FROM orchestration_v2_projection_turn_items AS item
    WHERE event.event_id = item.turn_item_id
      AND item.turn_item_id LIKE 'migration:v1:turn-item:%'
      AND json_extract(item.payload_json, '$.createdBy') = 'agent'
      AND json_extract(event.payload_json, '$.createdBy') = 'user'
  `;
  yield* sql`
    UPDATE orchestration_events AS event
    SET payload_json = json_set(item.payload_json, '$.updatedAt', json_extract(event.payload_json, '$.updatedAt'))
    FROM orchestration_v2_projection_turn_items AS item
    WHERE event.application_event_version = 2
      AND event.aggregate_kind = 'thread'
      AND event.stream_id = item.thread_id
      AND event.event_type = 'turn-item.updated'
      AND json_extract(event.payload_json, '$.type') = 'notification'
      AND json_extract(event.payload_json, '$.id') = item.turn_item_id
      AND item.type = 'user_message'
      AND item.turn_item_id LIKE 'turn-item:message:%'
  `;
});
