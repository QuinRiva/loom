import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as LoomStore from "../loom/projection/LoomStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const layerStores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer, LoomStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const TestLayer = ProjectionMaintenance.layer.pipe(Layer.provideMerge(layerStores));

const T = (minute: number) => `2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`;

it.layer(TestLayer)("ProjectionMaintenance (loom)", (it) => {
  // Upstream's compaction deletes the V1 events of a thread whose transcript is
  // imported; Loom's pre-V2 workstream timeline exists nowhere else.
  it.effect("keeps an imported V1 thread's workstream history and drops the rest", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const store = yield* LoomStore.LoomStoreV2;
      const threadId = "thread:v1-workstream";
      const v1 = (n: number, type: string, payload: object) =>
        sql`INSERT INTO orchestration_events ${sql.insert({
          event_id: `event:v1:${n}`,
          aggregate_kind: "thread",
          stream_id: threadId,
          stream_version: n,
          event_type: type,
          occurred_at: T(n),
          actor_kind: "server",
          payload_json: JSON.stringify({ threadId, updatedAt: T(n), ...payload }),
          metadata_json: "{}",
          application_event_version: 1,
        })}`;
      yield* v1(1, "thread.message-appended", { text: "hi" });
      yield* v1(2, "thread.report-set", { reportPath: "/r/t.md" });
      yield* v1(3, "thread.outcome-recorded", { outcome: "clean", decision: "resolve", round: 1 });
      yield* v1(4, "thread.attention-raised", { reason: "needs_guidance" });
      yield* v1(5, "thread.attention-cleared", {});
      yield* v1(6, "thread.route-taken", { to: "thread:coder", round: 1 });
      yield* v1(7, "thread.plan-lane-set", { planLane: "done" });
      yield* v1(8, "thread.activity-appended", {});
      yield* sql`
        INSERT INTO orchestration_v2_legacy_imports (
          thread_id, source_updated_at, shell_imported_at, transcript_imported_at,
          imported_message_count, last_error
        )
        VALUES (${threadId}, ${T(9)}, ${T(9)}, ${T(9)}, 1, NULL)
      `;
      const historyBefore = yield* store.history(ThreadId.make(threadId));

      const summary = yield* maintenance.pruneEventStore();

      assert.equal(summary.deletedEventCount, 2);
      const remaining = yield* sql<{ readonly event_type: string }>`
        SELECT event_type FROM orchestration_events WHERE stream_id = ${threadId} ORDER BY sequence
      `;
      assert.deepEqual(
        remaining.map((row) => row.event_type),
        [
          "thread.report-set",
          "thread.outcome-recorded",
          "thread.attention-raised",
          "thread.attention-cleared",
          "thread.route-taken",
          "thread.plan-lane-set",
        ],
      );
      assert.lengthOf(historyBefore, 5);
      assert.deepEqual(yield* store.history(ThreadId.make(threadId)), historyBefore);
    }),
  );

  // Upstream's due pass deletes every V2 row older than the mark that is not a stream head;
  // Loom's V2 workstream history rows must survive it.
  it.effect("keeps V2 workstream history through a due prune pass", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const store = yield* LoomStore.LoomStoreV2;
      const threadId = "thread:v2-workstream";
      const v2 = (n: number, type: string, payload: object) =>
        sql`INSERT INTO orchestration_events ${sql.insert({
          event_id: `event:v2:${n}`,
          aggregate_kind: "thread",
          stream_id: threadId,
          stream_version: n,
          event_type: type,
          occurred_at: T(n),
          actor_kind: "server",
          payload_json: JSON.stringify(payload),
          metadata_json: "{}",
          application_event_version: 2,
        })}`;
      yield* v2(1, "node.updated", {});
      yield* v2(2, "thread.outcome-recorded", { outcome: "clean", decision: "resolve", round: 1 });
      yield* v2(3, "thread.route-taken", { to: "thread:coder", round: 1, kind: "loop" });
      yield* v2(4, "node.updated", {});
      const head = yield* sql<{ readonly sequence: number }>`
        SELECT MAX(sequence) AS sequence FROM orchestration_events
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_metadata (
          projection_name, schema_version, last_sequence, updated_at
        )
        VALUES (
          'thread-projections', ${ProjectionStore.ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION},
          ${head[0]!.sequence}, ${T(4)}
        )
        ON CONFLICT(projection_name) DO UPDATE SET last_sequence = excluded.last_sequence
      `;
      const historyBefore = yield* store.history(ThreadId.make(threadId));

      // The first pass only writes the mark; the second, a day later, prunes through it.
      yield* maintenance.pruneEventStore();
      yield* TestClock.adjust("1 day");
      const summary = yield* maintenance.pruneEventStore();

      assert.equal(summary.deletedEventCount, 1);
      const remaining = yield* sql<{ readonly event_id: string }>`
        SELECT event_id FROM orchestration_events WHERE stream_id = ${threadId} ORDER BY sequence
      `;
      assert.deepEqual(
        remaining.map((row) => row.event_id),
        ["event:v2:2", "event:v2:3", "event:v2:4"],
      );
      assert.lengthOf(historyBefore, 2);
      assert.deepEqual(yield* store.history(ThreadId.make(threadId)), historyBefore);
    }).pipe(Effect.provide(TestLayer)),
  );
});
