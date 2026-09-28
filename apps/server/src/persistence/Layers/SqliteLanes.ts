import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationCommandReceiptRepositoryLive } from "./OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "./OrchestrationEventStore.ts";
import { makeProjectionUsageLedgerRepository } from "./ProjectionUsageLedger.ts";
import { SqlReadClient } from "./SqliteRead.ts";
import type { ProjectionUsageLedgerRepositoryShape } from "../Services/ProjectionUsageLedger.ts";
import { OrchestrationEngineLive } from "../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../orchestration/Layers/ProjectionPipeline.ts";
import { makeProjectionSnapshotQuery } from "../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../orchestration/ThreadPlanProgress.ts";

/**
 * Runs a repository constructor against the worker read lane. The substitution
 * happens inside the constructor, so the layer built from it names
 * `SqlReadClient` in its requirement channel and no layer-memo order can move it
 * to the writer. Never re-provide the shared `SqlClient` tag to a layer, and
 * never `Layer.fresh` a repository: both leave the lane to build order.
 */
const onReadLane = <A, E, R>(make: Effect.Effect<A, E, R>) =>
  make.pipe(Effect.provideServiceEffect(SqlClient.SqlClient, SqlReadClient));

/** The one `ProjectionSnapshotQuery` in the server build; its reads run on the worker lane. */
export const ProjectionSnapshotQueryLanes = Layer.effect(
  ProjectionSnapshotQuery,
  onReadLane(makeProjectionSnapshotQuery),
);

/**
 * The usage ledger's read side, for the Usage page's top-spending-threads read.
 * Ingestion's writes use `ProjectionUsageLedgerRepository` on the default client.
 */
export class ProjectionUsageLedgerReader extends Context.Service<
  ProjectionUsageLedgerReader,
  ProjectionUsageLedgerRepositoryShape
>()("t3/persistence/Layers/SqliteLanes/ProjectionUsageLedgerReader") {}

export const ProjectionUsageLedgerReaderLive = Layer.effect(
  ProjectionUsageLedgerReader,
  onReadLane(makeProjectionUsageLedgerRepository),
);

// Upstream's `OrchestrationLayerLive` (orchestration/runtimeLayer.ts) with the
// lane-aware snapshot query in place of `OrchestrationProjectionSnapshotQueryLive`.
const OrchestrationInfrastructureLanes = Layer.mergeAll(
  ProjectionSnapshotQueryLanes,
  OrchestrationEventStoreLive,
  OrchestrationCommandReceiptRepositoryLive,
  OrchestrationProjectionPipelineLive.pipe(Layer.provide(OrchestrationEventStoreLive)),
).pipe(
  Layer.provideMerge(ThreadBackgroundLiveness.layer),
  Layer.provideMerge(ThreadPlanProgress.layer),
);

export const OrchestrationLayerOnSqlReadClient = Layer.mergeAll(
  OrchestrationInfrastructureLanes,
  OrchestrationEngineLive.pipe(Layer.provide(OrchestrationInfrastructureLanes)),
);
