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
import { WorkstreamDispatcherStartedLive } from "./orchestration/dispatcher/WorkstreamDispatcher.ts";
import {
  EmergentGoalGeneratorPiLive,
  EmergentGoalReactorLive,
} from "./orchestration/EmergentGoalReactor.ts";
import { WorkstreamLivenessSweepLive } from "./orchestration/liveness/WorkstreamLivenessSweep.ts";
import * as LoomGoalBroadcast from "./projection/LoomGoalBroadcast.ts";
import * as LoomStore from "./projection/LoomStore.ts";
import { LoomSessionComposerDefaultLive } from "./prompt/sessionComposer.ts";
import { SubscriptionUsagePollerLive } from "../provider/Layers/SubscriptionUsagePoller.ts";

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
 * and publish/subscribe goal shell items. Pull 9 Phase 2 §4.
 */
export const LoomGoalBroadcastLive = LoomGoalBroadcast.layerWithReactor.pipe(
  Layer.provideMerge(LoomStore.layer),
);

/**
 * The workstream control plane (Phase 3 Track 3b): the dispatcher pass —
 * re-drive, promotion and every wake — and the liveness sweep (which advises
 * through the dispatcher), both started after server activation.
 * 3b-4/5 merge their layers here.
 */
export const LoomControlPlaneLive = Layer.mergeAll(
  WorkstreamLivenessSweepLive, // loom: 3b-3 — the sweep hands slow-tool/spinning advisories to the dispatcher
  EmergentGoalReactorLive.pipe(
    Layer.provide(EmergentGoalGeneratorPiLive),
    // The same layer reference as server.ts's entry, so the broadcast is one shared PubSub.
    Layer.provide(LoomGoalBroadcastLive),
  ),
).pipe(
  Layer.provideMerge(WorkstreamDispatcherStartedLive),
  Layer.provide([CommandReceiptStore.layer, LoomStore.layer]),
);

/**
 * The open-session composer `ProviderSessionManager` asks for each thread's
 * prompt, skills and extensions (driver plan §4). Empty until Phase 3a re-points
 * this one export at the real composer.
 */
export const LoomSessionComposerLive = LoomSessionComposerDefaultLive;
