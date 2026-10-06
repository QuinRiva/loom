/**
 * Loom fork-owned server layer bundles.
 *
 * Loom (fork of `pingdotgg/t3code`) adds its own provider sweeps to the server
 * layer graph. To keep `server.ts` mergeable against upstream, those additions
 * live here as named bundles and are spliced into the upstream composition with
 * one `// loom:`-marked line each, rather than scattered `provideMerge` steps.
 *
 * Pull 9 (Phase 1) split this file: the V1-engine bundles (reactors, read lane,
 * provisioner, worktree lock/lease, MCP HTTP routes) are in
 * `quarantine/apps/server/src/loom/serverLayers.ts` (detach ledger DT-24); the
 * provider-layer halves below have no engine dependency and survive.
 *
 * @module loom/serverLayers
 */
import * as Layer from "effect/Layer";

import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import { ProviderHealthRegistryLive } from "../provider/Services/ProviderHealthRegistry.ts";
import { LoomAgentRoutesLive } from "./http/loomAgentRoutes.ts";
import { LoomReDriveReactor } from "./orchestration/redrive.ts";
import * as LoomGoalBroadcast from "./projection/LoomGoalBroadcast.ts";
import * as LoomStore from "./projection/LoomStore.ts";
import * as LoomThreadConsult from "./workstream/consult.ts";
import { LoomSessionComposerRealLive } from "./prompt/sessionComposerLive.ts";
import { SubscriptionUsagePollerLive } from "../provider/Layers/SubscriptionUsagePoller.ts";
import { LoomAskReactorLive } from "./userInput/askUserQuestion.ts";

/** Provider sweeps merged into the provider runtime layer. */
export const LoomProviderRuntimeLive = SubscriptionUsagePollerLive;

/**
 * Exhaustion state (`ProviderHealthRegistryLive`), which also holds the
 * ephemeral account-usage telemetry the marks derive from (fed by
 * `SubscriptionUsagePoller`). Its `providerFailover` settings subscription is
 * detached in pull 9 (ledger DT-92).
 */
export const LoomProviderHealthLive = ProviderHealthRegistryLive;

/**
 * Loom's sidecar store and the goal broadcast (with its cascade reactor),
 * exposed to the runtime so `ws.ts` (and Phase 3a's handlers) can read goals
 * and publish/subscribe goal shell items; and the re-drive reactor that moves
 * cascades and gate legs until Phase 3b's dispatcher absorbs it. Pull 9 Phase 2 §4.
 * Also `consult_thread`'s fork transport (3a-3), which the MCP toolkit captures.
 */
export const LoomGoalBroadcastLive = Layer.mergeAll(
  LoomGoalBroadcast.layerWithReactor,
  LoomThreadConsult.layer,
  LoomReDriveReactor.pipe(Layer.provide(CommandReceiptStore.layer)), // loom: re-drive (D16)
).pipe(Layer.provideMerge(LoomStore.layer));

/**
 * The open-session composer `ProviderSessionManager` asks for each thread's
 * prompt, skills, extensions and env (driver plan §4; Phase 3a-5). Its own
 * reads (projection, projects, Loom store, extension path) are provided inside;
 * ServerConfig, ServerSettings, SqlClient and the platform come from the server.
 */
export const LoomSessionComposerLive = LoomSessionComposerRealLive;

/**
 * Loom's pi-extension surface (seam 19): the session-profile and
 * mcp__t3-code__ask_user_question routes beside `/mcp`, and the reactor that hands answers
 * to live waiters and closes superseded or orphaned questions. Mounted with the
 * HTTP routes in `server.ts` (the router exists only there).
 */
export const LoomAgentHttpLive = Layer.mergeAll(LoomAgentRoutesLive, LoomAskReactorLive);
