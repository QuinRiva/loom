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
import { ProjectionUsageLedgerOnSqlReadClient } from "../persistence/Layers/SqliteLanes.ts";
import { WorkstreamLivenessSweepLive } from "../orchestration/Layers/WorkstreamLivenessSweep.ts";
import { ExhaustionResumeSweepLive } from "../orchestration/Layers/ExhaustionResumeSweep.ts";
import { WorkstreamDispatcherLive } from "../orchestration/Layers/WorkstreamDispatcher.ts";
import { WorkstreamFanInReactorLive } from "../orchestration/Layers/WorkstreamFanInReactor.ts";
import { HandoffDrafterReactorLive } from "../orchestration/Layers/HandoffDrafterReactor.ts";
import { WorktreeReaperLive } from "../orchestration/Layers/WorktreeReaper.ts";
import * as WorkstreamWorktreeStatus from "../orchestration/WorkstreamWorktreeStatus.ts";
import { ProviderHealthRegistryLive } from "../provider/Services/ProviderHealthRegistry.ts";
import { SubscriptionUsagePollerLive } from "../provider/Layers/SubscriptionUsagePoller.ts";
import { layer as WorktreeProvisionerLive } from "../project/WorktreeProvisioner.ts";
import { layer as WorktreeMutationLockLive } from "../git/WorktreeMutationLock.ts";
import { layer as WorkspaceLeaseLive } from "../workspace/WorkspaceOccupancyLease.ts";
import * as WorkstreamSpawnHttp from "../mcp/WorkstreamSpawnHttp.ts";
import * as GoalTaskHttp from "../mcp/GoalTaskHttp.ts";
import * as GoalHandoffHttp from "../mcp/GoalHandoffHttp.ts";
import * as ThreadForkHttp from "../mcp/ThreadForkHttp.ts";
import * as UserInputHttp from "../mcp/UserInputHttp.ts";

/**
 * Fork reactors, spliced into `ReactorLayerLive` with a single `provideMerge`
 * positioned after `ThreadDeletionReactorLive`.
 *
 * Built as a pipe (not a flat `mergeAll`) because `WorkstreamWorktreeStatus`
 * consumes `WorktreeReaper`: the original interleaved ordering had
 * `WorkstreamWorktreeStatus` earliest and `WorktreeReaper` later (later provides
 * to earlier), so the reaper must `provideMerge` into the status layer here too.
 */
export const LoomReactorsLive = WorkstreamWorktreeStatus.layer.pipe(
  Layer.provideMerge(WorkstreamDispatcherLive),
  Layer.provideMerge(WorkstreamFanInReactorLive),
  // `/handoff` fork-drafter settlement (plan D5/D6).
  Layer.provideMerge(HandoffDrafterReactorLive),
  Layer.provideMerge(WorktreeReaperLive),
);

/**
 * SQLite read-lane persistence; joins `PersistenceLayerLive`. The usage-ledger
 * repository rides the same lane so the ws layer can answer the Usage page's
 * top-spending-threads read without touching the write connection.
 */
export const LoomPersistenceLive = ProjectionUsageLedgerOnSqlReadClient.pipe(
  Layer.provideMerge(SqliteReadLayerLive),
);

/** Provider sweeps merged alongside `ProviderSessionReaperLive` in `ProviderRuntimeLayerLive`. */
export const LoomProviderRuntimeLive = Layer.mergeAll(
  WorkstreamLivenessSweepLive,
  ExhaustionResumeSweepLive,
  SubscriptionUsagePollerLive,
);

/**
 * Joins the `CheckpointingLayerLive` mergeAll step. `WorktreeProvisionerLive`
 * is the shared provisioner for root bootstrap + dispatcher promotion; it
 * resolves its SqlClient / git / setup / orchestration deps from later
 * `RuntimeCore` provideMerge steps.
 */
export const LoomRuntimeCoreLive = WorktreeProvisionerLive;

/**
 * Per-worktree mutation lock shared by the provisioner and the fan-in reactor so
 * parent-worktree git ops never race. Joins the `SourceControlProviderRegistry`
 * mergeAll — a later, dependency-free step — so it feeds both the provisioner
 * (an earlier RuntimeCore step) and the fan-in reactor in the reactor layer.
 */
export const LoomWorktreeMutationLockLive = WorktreeMutationLockLive;

/**
 * `WorkspaceLease` — the single occupancy authority: the provider service takes
 * a hold before spawning a process, and every worktree remover (fan-in reactor,
 * reaper, maintenance panel) runs inside its exclusive gate. It must therefore
 * be provided to BOTH the reactor layer and the provider runtime, which sit at
 * different steps of the RuntimeCore pipe, so it rides its own late,
 * dependency-free `provideMerge` positioned after `ProviderRuntimeLayerLive`
 * (later provides to earlier, so one step below every consumer covers them all).
 */
export const LoomWorkspaceLeaseLive = WorkspaceLeaseLive;

/**
 * Exhaustion state (`ProviderHealthRegistryLive`), which also holds the
 * ephemeral account-usage telemetry the marks derive from (fed by
 * `SubscriptionUsagePoller`). Joins the `ProviderEventLoggers` mergeAll so it
 * is provided to the built-in drivers (PiDriver requires ProviderHealthRegistry
 * for quota classification). The health registry also reads `providerFailover`
 * from ServerSettings (a later RuntimeCore step).
 */
export const LoomProviderHealthLive = ProviderHealthRegistryLive;

/** Fork MCP HTTP routes, merged with `McpHttpServer.layer` in `makeRoutesLayer`. */
export const LoomMcpHttpLive = Layer.mergeAll(
  WorkstreamSpawnHttp.layer,
  GoalTaskHttp.layer,
  GoalHandoffHttp.layer,
  ThreadForkHttp.layer,
  UserInputHttp.layer,
);
