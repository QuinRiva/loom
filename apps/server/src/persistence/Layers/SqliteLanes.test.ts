import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
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
