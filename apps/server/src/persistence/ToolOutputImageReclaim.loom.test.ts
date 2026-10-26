import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EventId,
  NodeId,
  type OrchestrationV2TurnItem,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ToolOutputImageStore from "../orchestration-v2/ToolOutputImageStore.loom.ts";
import * as SqlitePersistence from "./Sqlite.ts";
import { reclaimToolOutputImages } from "./ToolOutputImageReclaim.loom.ts";

const layerTest = Layer.mergeAll(
  ProjectionMaintenance.layer.pipe(
    Layer.provideMerge(Layer.merge(EventStore.layer, ProjectionStore.layer)),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  ),
  ToolOutputImageStore.layer.pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "image-reclaim-" })),
  ),
).pipe(Layer.provideMerge(NodeServices.layer));

const threadId = ThreadId.make("thread:image-reclaim");
const runId = RunId.make("run:image-reclaim");
const nodeId = NodeId.make("node:image-reclaim");
const screenshot = Buffer.from("screenshot ".repeat(200)).toString("base64");
const imageRead = Buffer.from("image read ".repeat(200)).toString("base64");

it.layer(layerTest)("ToolOutputImageReclaim", (it) => {
  it.effect("moves inline images in rows and events to files, resumably and replay-safe", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fileSystem = yield* FileSystem.FileSystem;
      const { attachmentsDir } = yield* ServerConfig.ServerConfig;
      const eventStore = yield* EventStore.EventStoreV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      let sequence = 0;
      const update = (id: string, toolName: string, output: unknown) => {
        const payload: OrchestrationV2TurnItem = {
          id: TurnItemId.make(id),
          threadId,
          runId,
          nodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: sequence,
          status: output === undefined ? "running" : "completed",
          title: toolName,
          startedAt: now,
          completedAt: output === undefined ? null : now,
          updatedAt: now,
          type: "dynamic_tool",
          toolName,
          input: {},
          ...(output === undefined ? {} : { output }),
        };
        const event = {
          id: EventId.make(`event:image-reclaim:${sequence++}`),
          type: "turn-item.updated" as const,
          threadId,
          runId,
          occurredAt: now,
          payload,
        };
        return eventStore
          .append({ events: [event] })
          .pipe(Effect.andThen(projectionStore.apply(event)));
      };
      const image = (data: string) => ({ type: "image", data, mimeType: "image/png" });
      yield* update("item:shot", "browser_take_screenshot", undefined);
      yield* update("item:shot", "browser_take_screenshot", {
        content: [{ type: "text", text: "Took a screenshot" }, image(screenshot)],
      });
      yield* update("item:read", "read", {
        content: [{ type: "text", text: "Read image file [image/png]" }, image(imageRead)],
      });
      yield* update("item:same-shot", "browser_take_screenshot", { content: [image(screenshot)] });
      yield* update("item:text", "read", { content: [{ type: "text", text: "an image caption" }] });

      const storedJson = sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_v2_projection_turn_items
        UNION ALL SELECT payload_json FROM orchestration_events`.pipe(
        Effect.map((rows) => rows.map((row) => row.payload_json).join("\n")),
      );
      const before = yield* storedJson;

      const totals = yield* reclaimToolOutputImages({ batchRows: 2 });

      assert.equal(totals.rewrittenRows, 6);
      const after = yield* storedJson;
      assert.isFalse(after.includes(screenshot) || after.includes(imageRead));
      assert.equal(totals.bytesFreed, Buffer.byteLength(before) - Buffer.byteLength(after));
      const files = (yield* fileSystem.readDirectory(attachmentsDir)).toSorted();
      assert.lengthOf(files, 2);
      const contents = yield* Effect.forEach(files, (file) =>
        fileSystem.readFile(`${attachmentsDir}/${file}`),
      );
      assert.sameMembers(
        contents.map((bytes) => Buffer.from(bytes).toString("base64")),
        [screenshot, imageRead],
      );
      assert.equal((yield* reclaimToolOutputImages({ batchRows: 2 })).rewrittenRows, 0);

      const projectedRows = sql<{ readonly turn_item_id: string; readonly payload_json: string }>`
        SELECT turn_item_id, payload_json FROM orchestration_v2_projection_turn_items
        ORDER BY turn_item_id`;
      const reclaimed = yield* projectedRows;
      yield* (yield* ProjectionMaintenance.ProjectionMaintenanceV2).rebuild;
      assert.deepEqual(yield* projectedRows, reclaimed);
    }),
  );
});
