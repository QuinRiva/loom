import { assert, it } from "@effect/vitest";
import { ControlPayload, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as EventSink from "../EventSink.ts";
import * as EventStore from "../EventStore.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as LegacyV1ThreadImporter from "./LegacyV1ThreadImporter.ts";

const layerStores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const layerEventSink = EventSink.layer.pipe(Layer.provide(layerStores));
const layerTest = Layer.mergeAll(
  layerStores,
  layerEventSink,
  LegacyV1ThreadImporter.layer.pipe(Layer.provide(Layer.mergeAll(layerStores, layerEventSink))),
);

const at = "2026-01-01T00:00:00.000Z";
const payload: ControlPayload = {
  kind: "yield",
  heading: "A sub-thread yielded.",
  items: [
    {
      threadId: ThreadId.make("thread:child"),
      role: "reviewer",
      title: "Yielded",
      status: "yielded",
    },
  ],
};
const payloadJson = Schema.encodeSync(Schema.fromJsonString(ControlPayload))(payload);

it.layer(layerTest)("LegacyV1ThreadImporter (loom)", (it) => {
  it.effect("imports V1 Loom origins as agent messages carrying message.loom (DL-610)", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:loom-import");
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, default_model_selection_json, scripts_json, created_at, updated_at, deleted_at)
        VALUES ('project:loom-import', 'Loom', '/tmp/loom', NULL, '[]', ${at}, ${at}, NULL)`;
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, branch, worktree_path, latest_turn_id, created_at, updated_at, deleted_at)
        VALUES (${threadId}, 'project:loom-import', 'Parent', NULL, 'full-access', 'default', NULL, NULL, NULL, ${at}, ${at}, NULL)`;
      yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, attachments_json, is_streaming, created_at, updated_at, origin, control_payload_json) VALUES
        ('m:human', ${threadId}, NULL, 'user', 'Please do it', '[]', 0, '2026-01-01T01:00:00.000Z', '2026-01-01T01:00:00.000Z', NULL, NULL),
        ('m:kickoff', ${threadId}, NULL, 'user', 'You are a coder', '[]', 0, '2026-01-01T02:00:00.000Z', '2026-01-01T02:00:00.000Z', 'kickoff', NULL),
        ('m:yield', ${threadId}, NULL, 'user', '[T3 Workstream control plane] yielded', '[]', 0, '2026-01-01T03:00:00.000Z', '2026-01-01T03:00:00.000Z', 'control_notice', ${payloadJson})`;

      yield* importer.reconcileShells;
      yield* importer.ensureTranscript(threadId);
      const projection = yield* projections.getThreadProjection(threadId);
      const byId = new Map(projection.messages.map((message) => [message.id, message]));
      assert.deepStrictEqual(
        ["m:human", "m:kickoff", "m:yield"].map((id) => [
          byId.get(id as never)?.createdBy,
          byId.get(id as never)?.loom,
        ]),
        [
          ["user", undefined],
          ["agent", { origin: "kickoff", humanAuthored: false }],
          ["agent", { origin: "control_notice", humanAuthored: false, controlPayload: payload }],
        ],
      );
      assert.deepStrictEqual(
        projection.turnItems.flatMap((item) =>
          item.type === "user_message" ? [[item.messageId, item.createdBy]] : [],
        ),
        [
          ["m:human", "user"],
          ["m:kickoff", "agent"],
          ["m:yield", "agent"],
        ],
      );
    }),
  );
});
