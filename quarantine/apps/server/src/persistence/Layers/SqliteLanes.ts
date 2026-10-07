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
import { ThreadEmbedderLive } from "../../orchestration/Layers/ThreadEmbedder.loom.ts";

/**
 * Runs a repository constructor against the worker read lane. The substitution
 * happens inside the constructor, so the layer built from it names
 * `SqlReadClient` in its requirement channel and no layer-memo order can move it
 * to the writer. Never re-provide the shared `SqlClient` tag to a layer, and
 * never `Layer.fresh` a repository: both leave the lane to build order.
 */
const onReadLane = <A, E, R>(make: Effect.Effect<A, E, R>) =>
  make.pipe(Effect.provideServiceEffect(SqlClient.SqlClient, SqlReadClient));

/**
 * The one `ProjectionSnapshotQuery` in the server build. Every method runs on
 * the worker lane except `POINT_READS`: measured hot-path reads whose cost does
 * not grow with a thread's history, run in-process on the default client
 * (synchronously on the event loop) instead of queueing on the worker's permit
 * behind snapshot transactions. Forward the references; never re-declare a
 * signature.
 */
export const ProjectionSnapshotQueryLanes = Layer.effect(
  ProjectionSnapshotQuery,
  Effect.gen(function* () {
    const worker = yield* onReadLane(makeProjectionSnapshotQuery);
    const inProcess = yield* makeProjectionSnapshotQuery;
    return ProjectionSnapshotQuery.of({
      ...worker,
      // POINT_READS — ingestion's per-event thread lookup: one primary-key join.
      getThreadRuntimeContext: inProcess.getThreadRuntimeContext,
    });
  }),
).pipe(
  // Thread search's semantic half. Its sweep writes on the default client; the
  // lexical query and fusion run with the rest of `searchThreads` on the worker.
  Layer.provide(ThreadEmbedderLive),
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
