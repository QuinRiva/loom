import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runAllMigrations } from "../LoomMigrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));
const T = (n: number) => `2026-10-01T00:00:${String(n).padStart(2, "0")}.000Z`;

layer("1070_LoomThreadHistory", (it) => {
  it.effect("backfills the log's history rows, V1 and V2, with their command ids", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runAllMigrations({ toLoomMigrationInclusive: 1069 });
      const event = (
        version: number,
        n: number,
        type: string,
        extra: { aggregate_kind?: string; command_id?: string } = {},
      ) =>
        sql`INSERT INTO orchestration_events ${sql.insert({
          event_id: `event:${n}`,
          aggregate_kind: "thread",
          stream_id: "history-thread",
          stream_version: n,
          event_type: type,
          occurred_at: T(n),
          actor_kind: "server",
          payload_json: JSON.stringify({ n }),
          metadata_json: "{}",
          application_event_version: version,
          ...extra,
        })}`;
      yield* event(1, 1, "thread.report-set");
      yield* event(1, 2, "thread.outcome-recorded");
      yield* event(1, 3, "thread.route-taken");
      yield* event(1, 4, "thread.plan-lane-set");
      yield* event(1, 5, "thread.plan-lane-set");
      yield* event(2, 6, "thread.title-set"); // not history
      yield* event(2, 7, "thread.outcome-set", { aggregate_kind: "project" }); // not a thread
      yield* event(2, 8, "thread.attention-raised");
      yield* event(2, 9, "thread.attention-cleared");
      yield* event(2, 10, "thread.gate-warning");
      yield* event(2, 11, "thread.outcome-recorded");
      yield* event(2, 12, "thread.outcome-set", { command_id: "command:mcp:cancel-1" });

      yield* runAllMigrations({ toLoomMigrationInclusive: 1070 });
      const rows = yield* sql<Record<string, unknown>>`
        SELECT * FROM loom_thread_history ORDER BY stream_version`;
      assert.deepEqual(
        rows.map((row) => [row.stream_version, row.event_type, row.event_version, row.command_id]),
        [
          [1, "thread.report-set", 1, null],
          [2, "thread.outcome-recorded", 1, null],
          [3, "thread.route-taken", 1, null],
          [4, "thread.plan-lane-set", 1, null],
          [5, "thread.plan-lane-set", 1, null],
          [8, "thread.attention-raised", 2, null],
          [9, "thread.attention-cleared", 2, null],
          [10, "thread.gate-warning", 2, null],
          [11, "thread.outcome-recorded", 2, null],
          [12, "thread.outcome-set", 2, "command:mcp:cancel-1"],
        ],
      );
      assert.deepEqual(rows.at(-1), {
        event_id: "event:12",
        thread_id: "history-thread",
        stream_version: 12,
        event_type: "thread.outcome-set",
        occurred_at: T(12),
        command_id: "command:mcp:cancel-1",
        event_version: 2,
        payload_json: JSON.stringify({ n: 12 }),
      });
    }),
  );
});
