import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationCommandReceiptRepositoryLive } from "./OrchestrationCommandReceipts.ts";
import { ProjectionUsageLedgerRepositoryLive } from "./ProjectionUsageLedger.ts";
import { OrchestrationEventStoreLive } from "./OrchestrationEventStore.ts";
import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import { OrchestrationEngineLive } from "../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ThreadBackgroundLiveness from "../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../orchestration/ThreadPlanProgress.ts";
import { SqlReadClient } from "./SqliteRead.ts";

const SqlReadClientAsSqlClient = Layer.effect(SqlClient.SqlClient, SqlReadClient);

const ProjectionSnapshotQueryOnSqlReadClient = OrchestrationProjectionSnapshotQueryLive.pipe(
  Layer.provide(SqlReadClientAsSqlClient),
);

const OrchestrationEventStoreOnSqlReadClient = OrchestrationEventStoreLive.pipe(
  Layer.provide(SqlReadClientAsSqlClient),
);

/**
 * The usage ledger's read side, for the Usage page's top-spending-threads
 * section. Ingestion `Layer.provide`s `ProjectionUsageLedgerRepositoryLive` for
 * its writes; `Layer.fresh` keeps that a separate write-lane instance.
 */
// loom: Effect memoises layers by object identity across the whole server build,
// so without `Layer.fresh` whichever copy builds first is shared by both. This
// read-lane copy built first, and ingestion's ledger inserts silently failed on
// the `query_only` connection (swallowed into a warning) from 2026-09-23.
export const ProjectionUsageLedgerOnSqlReadClient = Layer.fresh(
  ProjectionUsageLedgerRepositoryLive,
).pipe(Layer.provide(SqlReadClientAsSqlClient));

class OrchestrationEngineReaderReplay extends Context.Service<
  OrchestrationEngineReaderReplay,
  OrchestrationEngineShape
>()("t3/persistence/Layers/SqliteLanes/OrchestrationEngineReaderReplay") {}

const OrchestrationEngineReaderReplayLive = Layer.effect(
  OrchestrationEngineReaderReplay,
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const readerEventStore = yield* OrchestrationEventStore;
    return OrchestrationEngineReaderReplay.of({
      ...engine,
      // loom: delegate opaquely. A hand-written `(from) => ...(from)` wrapper
      // silently dropped `limit`, so every caller inherited the store's
      // page-bounded default instead of the range it asked for — see
      // plans/2026-07-28-thread-catchup-silent-truncation.md. Forwarding the
      // reference itself cannot drop this argument, or any added later.
      readEvents: readerEventStore.readFromSequence,
      readStreamEvents: readerEventStore.readStreamFromSequence,
    });
  }),
).pipe(Layer.provide(OrchestrationEventStoreOnSqlReadClient));

const routeEngineReplayToSqlReadClient = <E, R>(
  engineLayer: Layer.Layer<OrchestrationEngineService, E, R>,
) =>
  Layer.effect(OrchestrationEngineService, OrchestrationEngineReaderReplay).pipe(
    Layer.provide(OrchestrationEngineReaderReplayLive),
    Layer.provide(engineLayer),
  );

const OrchestrationEventInfrastructureLayerLive = Layer.mergeAll(
  OrchestrationEventStoreLive,
  OrchestrationCommandReceiptRepositoryLive,
);

const OrchestrationProjectionPipelineLayerLive = OrchestrationProjectionPipelineLive.pipe(
  Layer.provide(OrchestrationEventStoreLive),
);

const OrchestrationInfrastructureOnSqlReadClient = Layer.mergeAll(
  ProjectionSnapshotQueryOnSqlReadClient,
  OrchestrationEventInfrastructureLayerLive,
  OrchestrationProjectionPipelineLayerLive,
  // Mirrors upstream's `OrchestrationInfrastructureLayerLive`: the shared
  // background-liveness and plan-progress registries are written by runtime
  // ingestion and read by the snapshot query, so the same instance must be fed
  // here and re-exported for ingestion.
).pipe(
  Layer.provideMerge(ThreadBackgroundLiveness.layer),
  Layer.provideMerge(ThreadPlanProgress.layer),
);

export const OrchestrationLayerOnSqlReadClient = Layer.mergeAll(
  OrchestrationInfrastructureOnSqlReadClient,
  routeEngineReplayToSqlReadClient(
    OrchestrationEngineLive.pipe(Layer.provide(OrchestrationInfrastructureOnSqlReadClient)),
  ),
);
