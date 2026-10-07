import { OrchestrationV2TurnItemJson } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import {
  importedConsultTurnItem,
  interleaveConsults,
  type LegacyConsultRow,
} from "../../orchestration-v2/legacy/LegacyV1ThreadImporter.loom.ts";

// T3: threads imported before the importer learnt to bring V1 `consult_thread`
// calls across have no consult turn item, so their consult card is missing.
// Each V1 `thread.consult-recorded` event becomes the completed consult item
// the importer now writes (`importedConsultTurnItem`), placed among the
// thread's runless items by time (`interleaveConsults`): the runless items are
// renumbered densely, consults in the gaps. Every write lands in the
// projection, the position table and the event that carries the item, so a
// projection rebuild keeps it. Only transcript-imported threads are touched,
// and a consult already imported is skipped; on a fresh cut-over (migrations
// before the importer) it is a no-op.
const encodeItem = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2TurnItemJson));

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const consults = yield* sql<LegacyConsultRow>`
    SELECT consult.event_id, consult.stream_id AS thread_id, consult.occurred_at, consult.payload_json
    FROM orchestration_v2_legacy_imports AS legacy
    JOIN orchestration_events AS consult
      ON consult.aggregate_kind = 'thread' AND consult.stream_id = legacy.thread_id
    WHERE legacy.transcript_imported_at IS NOT NULL
      AND consult.application_event_version = 1
      AND consult.event_type = 'thread.consult-recorded'
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_turn_item_positions AS position
        WHERE position.thread_id = consult.stream_id
          AND position.turn_item_id = 'migration:v1:turn-item:consult:' || consult.event_id
      )
    ORDER BY consult.stream_id, consult.occurred_at, consult.event_id
  `;
  const byThread = new Map<string, Array<LegacyConsultRow>>();
  for (const consult of consults)
    byThread.set(consult.thread_id, [...(byThread.get(consult.thread_id) ?? []), consult]);

  for (const [threadId, threadConsults] of byThread) {
    // Runless items sit below the first run's bucket (`TurnItemPositionStore`).
    const items = yield* sql<{
      readonly turn_item_id: string;
      readonly ordinal: number;
      readonly at: string;
    }>`
      SELECT position.turn_item_id, position.ordinal,
        COALESCE(json_extract(item.payload_json, '$.startedAt'), item.updated_at) AS at
      FROM orchestration_v2_turn_item_positions AS position
      JOIN orchestration_v2_projection_turn_items AS item USING (turn_item_id)
      WHERE position.thread_id = ${threadId} AND position.ordinal < 1000000
      ORDER BY position.ordinal
    `;
    const merged = interleaveConsults(items, (item) => item.at, threadConsults);
    const moves = merged.flatMap((entry, index) =>
      "item" in entry && entry.item.ordinal !== index + 1
        ? [{ turnItemId: entry.item.turn_item_id, ordinal: index + 1 }]
        : [],
    );
    // Two passes through negatives: UNIQUE (thread_id, ordinal) is checked per row.
    for (const sign of [-1, 1]) {
      for (const move of moves) {
        yield* sql`
          UPDATE orchestration_v2_turn_item_positions SET ordinal = ${sign * move.ordinal}
          WHERE thread_id = ${threadId} AND turn_item_id = ${move.turnItemId}
        `;
      }
    }
    for (const move of moves) {
      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET ordinal = ${move.ordinal}, payload_json = json_set(payload_json, '$.ordinal', ${move.ordinal})
        WHERE turn_item_id = ${move.turnItemId}
      `;
      yield* sql`
        UPDATE orchestration_events
        SET payload_json = json_set(payload_json, '$.ordinal', ${move.ordinal})
        WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
          AND application_event_version = 2 AND event_type = 'turn-item.updated'
          AND json_extract(payload_json, '$.id') = ${move.turnItemId}
      `;
    }
    for (const [index, entry] of merged.entries()) {
      if (!("consult" in entry)) continue;
      const item = importedConsultTurnItem(entry.consult, index + 1);
      const payload = encodeItem(item);
      const at = entry.consult.occurred_at;
      yield* sql`
        INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
        VALUES (${threadId}, ${item.id}, ${item.ordinal})
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        )
        VALUES (
          ${item.id}, ${threadId}, NULL, NULL, NULL, NULL,
          NULL, ${item.ordinal}, ${item.type}, ${item.status}, ${at}, ${payload}
        )
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json,
          metadata_json, application_event_version
        )
        SELECT ${item.id}, 'thread', ${threadId}, COALESCE(MAX(stream_version), 0) + 1,
          'turn-item.updated', ${at}, NULL, NULL, NULL, 'server', ${payload}, '{}', 2
        FROM orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
      `;
    }
  }
});
