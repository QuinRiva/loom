import { CommandId, EventId, ProjectId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import * as Sqlite from "./Sqlite.ts";
import * as SqliteRead from "./SqliteRead.ts";
import { OrchestrationLayerOnSqlReadClient } from "./SqliteLanes.ts";

it.live("starts the orchestration engine with reader-routed snapshots and replay", () =>
  Effect.gen(function* () {
    const configLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-sqlite-lanes-",
    }).pipe(Layer.provide(NodeServices.layer));
    const layer = OrchestrationLayerOnSqlReadClient.pipe(
      Layer.provideMerge(RepositoryIdentityResolver.layer),
      Layer.provideMerge(Sqlite.layerConfig),
      Layer.provideMerge(SqliteRead.layerConfig),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(configLayer),
    );

    yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      yield* snapshotQuery.getCommandReadModel();
      yield* snapshotQuery.getSnapshot();
      yield* snapshotQuery.getShellSnapshot();
      yield* snapshotQuery.getArchivedShellSnapshot();
      yield* Stream.runCollect(engine.readEvents(0));
    }).pipe(Effect.provide(layer));
  }),
);

// loom: the reader lane once re-declared `readEvents` by hand and dropped the
// `limit` argument, so every caller silently inherited the event store's
// page-bounded default (1,000) instead of the range it asked for. That truncated
// thread catch-up replay and left clients confidently stale across machines.
// See plans/2026-07-28-thread-catchup-silent-truncation.md.
it.live("forwards an explicit read limit through the reader lane", () =>
  Effect.gen(function* () {
    const configLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-sqlite-lanes-limit-",
    }).pipe(Layer.provide(NodeServices.layer));
    const layer = OrchestrationLayerOnSqlReadClient.pipe(
      Layer.provideMerge(RepositoryIdentityResolver.layer),
      Layer.provideMerge(Sqlite.layerConfig),
      Layer.provideMerge(SqliteRead.layerConfig),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(configLayer),
    );

    // One past the store's default page bound, so a dropped limit truncates.
    const eventCount = 1_001;

    yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const eventStore = yield* OrchestrationEventStore;

      for (let index = 0; index < eventCount; index += 1) {
        const now = "2026-01-01T00:00:00.000Z";
        const projectId = ProjectId.make(`project-lane-limit-${index}`);
        const commandId = CommandId.make(`cmd-lane-limit-${index}`);
        yield* eventStore.append({
          type: "project.created",
          eventId: EventId.make(`evt-lane-limit-${index}`),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: now,
          commandId,
          causationEventId: null,
          correlationId: commandId,
          metadata: { adapterKey: "codex" },
          payload: {
            projectId,
            title: `Lane Limit ${index}`,
            workspaceRoot: `/tmp/${projectId}`,
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });
      }

      const events = yield* Stream.runCollect(engine.readEvents(0, Number.MAX_SAFE_INTEGER));
      assert.equal(Array.from(events).length, eventCount);
    }).pipe(Effect.provide(layer));
  }),
);
