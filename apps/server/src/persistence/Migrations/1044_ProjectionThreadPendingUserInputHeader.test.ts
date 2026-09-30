import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runAllMigrations } from "../LoomMigrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("1044_ProjectionThreadPendingUserInputHeader", (it) => {
  it.effect("backfills the oldest open question's header and asked-at", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runAllMigrations({ toLoomMigrationInclusive: 1043 });

      for (const [threadId, count] of [
        ["thread-open", 1],
        ["thread-quiet", 0],
      ] as const) {
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
            branch, worktree_path, latest_turn_id, created_at, updated_at, archived_at,
            latest_user_message_at, pending_approval_count, pending_user_input_count,
            has_actionable_proposed_plan, deleted_at
          )
          VALUES (
            ${threadId}, 'project-1', ${threadId}, '{"instanceId":"pi","model":"pi"}',
            'full-access', 'default', NULL, NULL, NULL,
            '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z', NULL, NULL,
            0, ${count}, 0, NULL
          )
        `;
      }
      // Oldest request is answered; the next-oldest open one is what the panel shows.
      for (const [activityId, threadId, kind, payloadJson, createdAt] of [
        [
          "a1",
          "thread-open",
          "user-input.requested",
          '{"requestId":"r1","questions":[{"header":"Answered already"}]}',
          "2026-07-27T00:00:01.000Z",
        ],
        [
          "a2",
          "thread-open",
          "user-input.resolved",
          '{"requestId":"r1","answers":{}}',
          "2026-07-27T00:00:02.000Z",
        ],
        [
          "a3",
          "thread-open",
          "user-input.requested",
          '{"requestId":"r2","questions":[{"header":"Still waiting"}]}',
          "2026-07-27T00:00:03.000Z",
        ],
        [
          "a4",
          "thread-open",
          "user-input.requested",
          '{"requestId":"r3","questions":[{"header":"Newer"}]}',
          "2026-07-27T00:00:04.000Z",
        ],
      ] as const) {
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
          )
          VALUES (${activityId}, ${threadId}, NULL, 'info', ${kind}, ${kind}, ${payloadJson}, NULL, ${createdAt})
        `;
      }

      yield* runAllMigrations({ toLoomMigrationInclusive: 1044 });

      assert.deepEqual(
        yield* sql`
          SELECT thread_id AS "threadId", pending_user_input_header AS "header",
            pending_user_input_since AS "since"
          FROM projection_threads ORDER BY thread_id
        `,
        [
          { threadId: "thread-open", header: "Still waiting", since: "2026-07-27T00:00:03.000Z" },
          { threadId: "thread-quiet", header: null, since: null },
        ],
      );
    }),
  );
});
