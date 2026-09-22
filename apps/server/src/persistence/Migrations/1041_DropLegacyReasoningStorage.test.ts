import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runAllMigrations } from "../LoomMigrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const messageColumns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ name: string }>`PRAGMA table_info(projection_thread_messages)`;
  return rows.map((row) => row.name);
});

const surviving = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const messages = yield* sql<{
    readonly messageId: string;
    readonly text: string;
  }>`SELECT message_id AS "messageId", text FROM projection_thread_messages ORDER BY message_id`;
  const events = yield* sql<{
    readonly eventType: string;
  }>`SELECT event_type AS "eventType" FROM orchestration_events ORDER BY sequence`;
  return {
    messages: messages.map((row) => [row.messageId, row.text] as const),
    events: events.map((row) => row.eventType),
  };
});

layer("1041_DropLegacyReasoningStorage", (it) => {
  it.effect("drops the legacy reasoning columns and purges the legacy events", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runAllMigrations({ toLoomMigrationInclusive: 1040 });

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming,
          reasoning_text, reasoning_streaming, reasoning_ms, created_at, updated_at
        )
        VALUES
          ('assistant:1', 'thread-1', 'turn-1', 'assistant', 'answer', 0,
           'thought it through', 0, 1200, '2026-07-27T00:00:05.000Z', '2026-07-27T00:00:05.000Z'),
          ('reasoning:legacy:assistant:1', 'thread-1', 'turn-1', 'reasoning', 'thought it through', 0,
           NULL, NULL, NULL, '2026-07-27T00:00:04.999Z', '2026-07-27T00:00:05.000Z')
      `;
      for (const [version, eventType] of [
        [0, "thread.message-sent"],
        [1, "thread.message-reasoning"],
      ] as const) {
        yield* sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
            command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
          )
          VALUES (
            ${`event-${version}`}, 'thread', 'thread-1', ${version}, ${eventType},
            '2026-07-27T00:00:05.000Z', NULL, NULL, NULL, 'server', '{}', '{}'
          )
        `;
      }

      yield* runAllMigrations({ toLoomMigrationInclusive: 1041 });

      const columns = yield* messageColumns;
      assert.deepEqual(
        columns.filter((name) => name.startsWith("reasoning_")),
        [],
      );
      const expected = {
        messages: [
          ["assistant:1", "answer"],
          ["reasoning:legacy:assistant:1", "thought it through"],
        ],
        events: ["thread.message-sent"],
      } satisfies {
        readonly messages: ReadonlyArray<readonly [string, string]>;
        readonly events: ReadonlyArray<string>;
      };
      assert.deepEqual(yield* surviving, expected);

      // Idempotent: the column guard and the delete both no-op on a second pass.
      yield* sql`DELETE FROM loom_sql_migrations WHERE migration_id = 1041`;
      yield* runAllMigrations({ toLoomMigrationInclusive: 1041 });
      assert.deepEqual(yield* surviving, expected);
    }),
  );
});
