import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runAllMigrations } from "../LoomMigrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const insertMessage = (input: {
  readonly messageId: string;
  readonly role: string;
  readonly text: string;
  readonly createdAt: string;
  readonly reasoningText: string | null;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, is_streaming,
        reasoning_text, created_at, updated_at
      )
      VALUES (
        ${input.messageId}, 'thread-1', 'turn-1', ${input.role}, ${input.text}, 0,
        ${input.reasoningText}, ${input.createdAt}, ${input.createdAt}
      )
    `;
  });

const timeline = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly messageId: string;
    readonly role: string;
    readonly text: string;
    readonly turnId: string | null;
  }>`
    SELECT message_id AS "messageId", role, text, turn_id AS "turnId"
    FROM projection_thread_messages
    ORDER BY created_at ASC, message_id ASC
  `;
  return rows.map((row) => [row.role, row.text, row.turnId] as const);
});

layer("1038_ReasoningTextToReasoningMessages", (it) => {
  it.effect("copies legacy reasoning text into reasoning rows above their answer", () =>
    Effect.gen(function* () {
      yield* runAllMigrations({ toLoomMigrationInclusive: 1037 });

      yield* insertMessage({
        messageId: "user:1",
        role: "user",
        text: "question",
        createdAt: "2026-07-27T00:00:00.000Z",
        reasoningText: null,
      });
      yield* insertMessage({
        messageId: "assistant:1",
        role: "assistant",
        text: "answer",
        createdAt: "2026-07-27T00:00:05.000Z",
        reasoningText: "thought it through",
      });
      // Nothing to carry: no reasoning, and whitespace-only reasoning.
      yield* insertMessage({
        messageId: "assistant:2",
        role: "assistant",
        text: "second answer",
        createdAt: "2026-07-27T00:00:09.000Z",
        reasoningText: "   ",
      });

      yield* runAllMigrations({ toLoomMigrationInclusive: 1038 });

      const expected = [
        ["user", "question", "turn-1"],
        ["reasoning", "thought it through", "turn-1"],
        ["assistant", "answer", "turn-1"],
        ["assistant", "second answer", "turn-1"],
      ];
      assert.deepEqual(yield* timeline, expected);

      // Idempotent: a second pass over the same rows adds nothing.
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM loom_sql_migrations WHERE migration_id = 1038`;
      });
      yield* runAllMigrations({ toLoomMigrationInclusive: 1038 });
      assert.deepEqual(yield* timeline, expected);
    }),
  );
});
