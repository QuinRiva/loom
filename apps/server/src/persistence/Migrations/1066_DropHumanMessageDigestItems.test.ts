import {
  type LoomControlItemKind,
  OrchestrationV2ConversationMessageJson,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { runAllMigrations } from "../LoomMigrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import Migration1066 from "./1066_DropHumanMessageDigestItems.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));
const decodeMessage = Schema.decodeUnknownSync(OrchestrationV2ConversationMessageJson);

const at = "2026-10-14T11:01:12.123Z";
const human = { kind: "human-message", title: "The human wrote", messageId: "m-human" };
const terminal = { kind: "terminal", threadId: "child-1", title: "Completed", status: "done" };
const message = (id: string, items: ReadonlyArray<object>) => ({
  id,
  threadId: "thread-1",
  runId: null,
  nodeId: null,
  role: "user",
  text: `digest ${id}`,
  attachments: [],
  streaming: false,
  createdBy: "agent",
  creationSource: "server",
  createdAt: at,
  updatedAt: at,
  loom: {
    origin: "control_notice",
    humanAuthored: false,
    controlPayload: { kind: "digest", heading: "FYI digest", items },
  },
});
const fixtures = [
  message("mixed", [terminal, human]),
  message("only-human", [human]),
  message("none", [terminal]),
];

const itemKinds = (rows: ReadonlyArray<{ readonly payload_json: string }>) =>
  rows.map((row) =>
    decodeMessage(JSON.parse(row.payload_json)).loom?.controlPayload?.items.map((i) => i.kind),
  );

layer("1066_DropHumanMessageDigestItems", (it) => {
  it.effect("strips human-message items from messages and their events, once", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runAllMigrations({ toLoomMigrationInclusive: 1065 });
      for (const [index, fixture] of fixtures.entries()) {
        const payload = JSON.stringify(fixture);
        yield* sql`
          INSERT INTO orchestration_v2_projection_messages (
            message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json
          )
          VALUES (${fixture.id}, 'thread-1', NULL, NULL, 'user', 0, ${at}, ${at}, ${payload})
        `;
        yield* sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            actor_kind, payload_json, metadata_json, application_event_version
          )
          VALUES (
            ${`event-${fixture.id}`}, 'thread', 'thread-1', ${index + 1}, 'message.updated', ${at},
            'server', ${payload}, '{}', 2
          )
        `;
      }
      const untouched = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_events WHERE event_id = 'event-none'
      `;

      yield* runAllMigrations();
      const messages = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_v2_projection_messages ORDER BY rowid
      `;
      const events = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_events ORDER BY sequence
      `;
      const expected: Array<Array<LoomControlItemKind>> = [["terminal"], [], ["terminal"]];
      assert.deepStrictEqual(itemKinds(messages), expected);
      assert.deepStrictEqual(itemKinds(events), expected);
      assert.deepStrictEqual(
        messages.map((row) => row.payload_json),
        events.map((row) => row.payload_json),
      );
      assert.strictEqual(events[2]?.payload_json, untouched[0]?.payload_json);

      const [rerun] = yield* sql<{ readonly changes: number }>`SELECT total_changes() AS changes`;
      yield* Migration1066;
      const [after] = yield* sql<{ readonly changes: number }>`SELECT total_changes() AS changes`;
      assert.strictEqual(after?.changes, rerun?.changes);
    }),
  );
});
