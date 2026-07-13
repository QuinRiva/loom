/**
 * Loom fork-owned server layer bundles.
 *
 * Loom (fork of `pingdotgg/t3code`) adds its own reactors, persistence lane,
 * provider sweeps, worktree provisioning, and MCP HTTP routes to the server
 * layer graph. To keep `server.ts` mergeable against upstream, those additions
 * live here as named bundles and are spliced into the upstream composition with
 * one `// loom:`-marked line each, rather than scattered `provideMerge` steps.
 *
 * Ordering is load-bearing: `Layer.provideMerge` makes each later step provide
 * to the earlier ones. The bundles below reproduce exactly the dependency
 * relationships the fork insertions had when interleaved into the upstream
 * pipes — verified by `vp run typecheck` (an unsatisfied requirement surfaces as
 * a non-`never` requirement channel on `makeServerLayer`) and `vp check`.
 *
 * @module loom/serverLayers
 */
import * as Layer from "effect/Layer";

import { layerConfig as SqliteReadLayerLive } from "../persistence/Layers/SqliteRead.ts";
import { WorkstreamLivenessSweepLive } from "../orchestration/Layers/WorkstreamLivenessSweep.ts";
import { ExhaustionResumeSweepLive } from "../orchestration/Layers/ExhaustionResumeSweep.ts";
import { ReasoningStreamBusLive } from "../orchestration/Layers/ReasoningStreamBus.ts";
import { WorkstreamDispatcherLive } from "../orchestration/Layers/WorkstreamDispatcher.ts";
import { WorkstreamFanInReactorLive } from "../orchestration/Layers/WorkstreamFanInReactor.ts";
import { WorktreeReaperLive } from "../orchestration/Layers/WorktreeReaper.ts";
import * as WorkstreamWorktreeStatus from "../orchestration/WorkstreamWorktreeStatus.ts";
import { AccountUsageRegistryLive } from "../provider/Services/AccountUsageRegistry.ts";
import { ProviderHealthRegistryLive } from "../provider/Services/ProviderHealthRegistry.ts";
import { SubscriptionUsagePollerLive } from "../provider/Layers/SubscriptionUsagePoller.ts";
import { layer as WorktreeProvisionerLive } from "../project/WorktreeProvisioner.ts";
import { layer as WorktreeMutationLockLive } from "../git/WorktreeMutationLock.ts";
import { UsageBreakdownQueryOnSqlReadClient } from "../persistence/Layers/SqliteLanes.ts";
import * as WorkstreamSpawnHttp from "../mcp/WorkstreamSpawnHttp.ts";
import * as GoalTaskHttp from "../mcp/GoalTaskHttp.ts";
import * as GoalHandoffHttp from "../mcp/GoalHandoffHttp.ts";
import * as ThreadForkHttp from "../mcp/ThreadForkHttp.ts";

/**
 * Fork reactors, spliced into `ReactorLayerLive` with a single `provideMerge`
 * positioned after `ThreadDeletionReactorLive`.
 *
 * Built as a pipe (not a flat `mergeAll`) because `WorkstreamWorktreeStatus`
 * consumes `WorktreeReaper`: the original interleaved ordering had
 * `WorkstreamWorktreeStatus` earliest and `WorktreeReaper` later (later provides
 * to earlier), so the reaper must `provideMerge` into the status layer here too.
 * `ReasoningStreamBusLive` is `provideMerge`'d last so it both feeds the fork
 * reactors AND is merged out — exported to the earlier upstream reactors
 * (`ProviderRuntimeIngestion` consumes it) and the routes/ws layer via the outer
 * `provideMerge` at the splice site.
 */
export const LoomReactorsLive = WorkstreamWorktreeStatus.layer.pipe(
  Layer.provideMerge(WorkstreamDispatcherLive),
  Layer.provideMerge(WorkstreamFanInReactorLive),
  Layer.provideMerge(WorktreeReaperLive),
  Layer.provideMerge(ReasoningStreamBusLive),
);

/** SQLite read-lane persistence; joins `PersistenceLayerLive`. */
export const LoomPersistenceLive = SqliteReadLayerLive;

/** Provider sweeps merged alongside `ProviderSessionReaperLive` in `ProviderRuntimeLayerLive`. */
export const LoomProviderRuntimeLive = Layer.mergeAll(
  WorkstreamLivenessSweepLive,
  ExhaustionResumeSweepLive,
  SubscriptionUsagePollerLive,
);

/**
 * Joins the `CheckpointingLayerLive` mergeAll step. `UsageBreakdownQueryLive`
 * (/usage dashboard aggregation) exposes `UsageBreakdownQuery` for the ws RPC
 * handler; `WorktreeProvisionerLive` is the shared provisioner for root
 * bootstrap + dispatcher promotion. Both resolve their SqlClient / git / setup /
 * orchestration deps from later `RuntimeCore` provideMerge steps.
 */
export const LoomRuntimeCoreLive = Layer.mergeAll(
  UsageBreakdownQueryOnSqlReadClient,
  WorktreeProvisionerLive,
);

/**
 * Per-worktree mutation lock shared by the provisioner and the fan-in reactor so
 * parent-worktree git ops never race. Joins the `SourceControlProviderRegistry`
 * mergeAll — a later, dependency-free step — so it feeds both the provisioner
 * (an earlier RuntimeCore step) and the fan-in reactor in the reactor layer.
 */
export const LoomWorktreeMutationLockLive = WorktreeMutationLockLive;

/**
 * Exhaustion state (`ProviderHealthRegistryLive`) + the ephemeral,
 * account-scoped usage store it derives marks from (`AccountUsageRegistryLive`,
 * nested-provided and merged out for its other consumers). Joins the
 * `ProviderEventLoggers` mergeAll so it is provided to the built-in drivers
 * (PiDriver requires ProviderHealthRegistry for quota classification). The
 * health registry also reads `providerFailover` from ServerSettings (a later
 * RuntimeCore step).
 */
export const LoomProviderHealthLive = ProviderHealthRegistryLive.pipe(
  Layer.provideMerge(AccountUsageRegistryLive),
);

/** Fork MCP HTTP routes, merged with `McpHttpServer.layer` in `makeRoutesLayer`. */
export const LoomMcpHttpLive = Layer.mergeAll(
  WorkstreamSpawnHttp.layer,
  GoalTaskHttp.layer,
  GoalHandoffHttp.layer,
  ThreadForkHttp.layer,
);
