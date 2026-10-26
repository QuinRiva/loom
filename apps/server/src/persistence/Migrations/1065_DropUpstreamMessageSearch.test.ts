import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runAllMigrations } from "../LoomMigrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import Migration1065 from "./1065_DropUpstreamMessageSearch.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

const searchObjects = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE name = 'orchestration_v2_message_search' OR name LIKE 'orchestration_v2_message_search_%'
    ORDER BY name
  `;
  return rows.map((row) => row.name);
});

layer("1065_DropUpstreamMessageSearch", (it) => {
  it.effect(
    "drops 069's index where it ran, is a no-op where it did not, and writes still land",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runAllMigrations({ toLoomMigrationInclusive: 1064 });
        assert.includeMembers(yield* searchObjects, [
          "orchestration_v2_message_search",
          "orchestration_v2_message_search_delete",
          "orchestration_v2_message_search_insert",
          "orchestration_v2_message_search_update",
        ]);

        yield* runAllMigrations();
        assert.deepStrictEqual(yield* searchObjects, []);
        // The shape of a database whose SQLite lacked trigram FTS5, so 069 created nothing.
        yield* Migration1065;

        yield* sql`
        INSERT INTO orchestration_v2_projection_messages (
          message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json
        )
        VALUES (
          'user', 'thread-1', NULL, NULL, 'user', 0,
          '2026-10-26T00:00:00.000Z', '2026-10-26T00:00:00.000Z', '{"text":"needle"}'
        )
      `;
        yield* sql`UPDATE orchestration_v2_projection_messages SET payload_json = '{"text":"pin"}'`;
        yield* sql`DELETE FROM orchestration_v2_projection_messages`;
      }),
  );
});
