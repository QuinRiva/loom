import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runAllMigrations } from "../LoomMigrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const insertThread = (threadId: string, pendingUserInputCount: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
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
      0, ${pendingUserInputCount}, 0, NULL
    )
  `;
  });

// `payloadJson` is written as a literal string, matching the sibling migration
// tests: this is fixture data shaped exactly as the projection stores it, not a
// value being encoded.
const insertActivity = (input: {
  readonly activityId: string;
  readonly threadId: string;
  readonly kind: string;
  readonly payloadJson: string;
  readonly createdAt: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_thread_activities (
        activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
      )
      VALUES (
        ${input.activityId}, ${input.threadId}, NULL, 'info', ${input.kind}, ${input.kind},
        ${input.payloadJson}, NULL, ${input.createdAt}
      )
    `;
  });

const counts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly threadId: string;
    readonly count: number;
  }>`
    SELECT thread_id AS "threadId", pending_user_input_count AS "count"
    FROM projection_threads
    ORDER BY thread_id ASC
  `;
  return Object.fromEntries(rows.map((row) => [row.threadId, row.count]));
});

layer("1033_RefoldPendingUserInputCount", (it) => {
  it.effect("refolds deployed counts under terminal-wins and settles the stuck threads", () =>
    Effect.gen(function* () {
      yield* runAllMigrations({ toLoomMigrationInclusive: 1032 });

      // Thread `57fbb002`, in the exact shape production still carries: a
      // `user-input.requested` whose terminal event is GENUINELY ABSENT (the
      // cancellation was emitted into a dead queue and never persisted), plus the
      // non-clearing respond.failed rows the user's sixteen answer attempts
      // produced. The division of labour this asserts: the migration refolds
      // honestly and therefore leaves it at 1, because no resolution exists to
      // find — settling it is the STARTUP SCAN's job, not the migration's. A
      // migration that "fixed" the count here would be inventing a settlement.
      yield* insertThread("thread-57fbb002-unsettled", 1);
      yield* insertActivity({
        activityId: "act-57fbb002-unsettled-requested",
        threadId: "thread-57fbb002-unsettled",
        kind: "user-input.requested",
        payloadJson: '{"requestId":"6bc37509-unsettled","questions":[]}',
        createdAt: "2026-07-27T06:42:17.283Z",
      });
      yield* insertActivity({
        activityId: "act-57fbb002-unsettled-failed",
        threadId: "thread-57fbb002-unsettled",
        kind: "provider.user-input.respond.failed",
        payloadJson:
          '{"requestId":"6bc37509-unsettled","detail":"Cannot recover thread because no provider resume state is persisted."}',
        createdAt: "2026-07-28T05:39:00.000Z",
      });

      // The same thread once the startup scan HAS run: its cancellation is now a
      // durable row, and the refold agrees.
      yield* insertThread("thread-57fbb002", 1);
      yield* insertActivity({
        activityId: "act-57fbb002-requested",
        threadId: "thread-57fbb002",
        kind: "user-input.requested",
        payloadJson: '{"requestId":"6bc37509-84cf-4768-b5c3-d840f2dc4597","questions":[]}',
        createdAt: "2026-07-27T06:42:17.283Z",
      });
      yield* insertActivity({
        activityId: "act-57fbb002-failed",
        threadId: "thread-57fbb002",
        kind: "provider.user-input.respond.failed",
        payloadJson:
          '{"requestId":"6bc37509-84cf-4768-b5c3-d840f2dc4597","detail":"No active provider session is bound to this thread."}',
        createdAt: "2026-07-28T05:39:00.000Z",
      });
      // The cancellation that WAS emitted but never persisted, now written by the
      // startup scan. The migration must see it and close the request.
      yield* insertActivity({
        activityId: "act-57fbb002-resolved",
        threadId: "thread-57fbb002",
        kind: "user-input.resolved",
        payloadJson:
          '{"requestId":"6bc37509-84cf-4768-b5c3-d840f2dc4597","answers":{},"outcome":"cancelled"}',
        createdAt: "2026-07-29T00:00:00.000Z",
      });

      // Thread 2: still genuinely open at migration time (its startup-scan
      // settlement happens after the migration in the same boot), so the honest
      // refolded count is 1 — the migration must not fake a resolution.
      yield* insertThread("thread-13653de6", 1);
      yield* insertActivity({
        activityId: "act-13653de6-requested",
        threadId: "thread-13653de6",
        kind: "user-input.requested",
        payloadJson: '{"requestId":"req-13653de6","questions":[]}',
        createdAt: "2026-07-28T02:30:31.889Z",
      });

      // Terminal-wins: a duplicate `requested` with a NEWER timestamp after the
      // resolution must not reopen the request. The previous latest-state fold
      // counted this as open, which is the resurrection bug.
      yield* insertThread("thread-duplicate", 0);
      yield* insertActivity({
        activityId: "act-dup-requested-1",
        threadId: "thread-duplicate",
        kind: "user-input.requested",
        payloadJson: '{"requestId":"req-dup","questions":[]}',
        createdAt: "2026-07-27T00:00:01.000Z",
      });
      yield* insertActivity({
        activityId: "act-dup-resolved",
        threadId: "thread-duplicate",
        kind: "user-input.resolved",
        payloadJson: '{"requestId":"req-dup","answers":{},"outcome":"dismissed"}',
        createdAt: "2026-07-27T00:00:02.000Z",
      });
      yield* insertActivity({
        activityId: "act-dup-requested-2",
        threadId: "thread-duplicate",
        kind: "user-input.requested",
        payloadJson: '{"requestId":"req-dup","questions":[]}',
        createdAt: "2026-07-27T00:00:03.000Z",
      });

      // A stale row the OLD fold would have cleared from prose. Resolution is now
      // the only clearing signal, so this stays open and honest.
      yield* insertThread("thread-prose", 0);
      yield* insertActivity({
        activityId: "act-prose-requested",
        threadId: "thread-prose",
        kind: "user-input.requested",
        payloadJson: '{"requestId":"req-prose","questions":[]}',
        createdAt: "2026-07-27T00:00:01.000Z",
      });
      yield* insertActivity({
        activityId: "act-prose-failed",
        threadId: "thread-prose",
        kind: "provider.user-input.respond.failed",
        payloadJson:
          '{"requestId":"req-prose","detail":"Stale pending user-input request: req-prose."}',
        createdAt: "2026-07-27T00:00:02.000Z",
      });

      yield* runAllMigrations({ toLoomMigrationInclusive: 1033 });

      assert.deepEqual(yield* counts, {
        // Genuinely still open: only the startup scan can settle it.
        "thread-13653de6": 1,
        // Settled by the scan's durable cancellation; the refold agrees.
        "thread-57fbb002": 0,
        // The migration does NOT invent a settlement it cannot observe.
        "thread-57fbb002-unsettled": 1,
        "thread-duplicate": 0,
        "thread-prose": 1,
      });
    }),
  );
});
