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
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import {
  LoomPiAdapterHooks,
  passthroughLoomPiAdapterHooks,
  type LoomPiAdapterHooksShape,
} from "../provider/Drivers/Pi/loomAdapterHooks.loom.ts";
import { classifyPiFailure } from "../provider/Drivers/Pi/piQuotaClassifier.loom.ts";
import {
  ProviderHealthRegistry,
  ProviderHealthRegistryLive,
} from "../provider/Services/ProviderHealthRegistry.ts";
import { LoomReDriveReactor } from "./orchestration/redrive.ts";
import * as LoomGoalBroadcast from "./projection/LoomGoalBroadcast.ts";
import * as LoomStore from "./projection/LoomStore.ts";
import { LoomSessionComposerDefaultLive } from "./prompt/sessionComposer.ts";
import { SubscriptionUsagePollerLive } from "../provider/Layers/SubscriptionUsagePoller.ts";

/** Provider sweeps merged into the provider runtime layer. */
export const LoomProviderRuntimeLive = SubscriptionUsagePollerLive;

/**
 * The pi adapter's Loom hooks (Phase 3 track 3c): the quota classifier reads the
 * health marks at classification time, so a quota error with no reset in its
 * text takes the account window's. The sanitiser (3c-2) and steer stash (3c-3)
 * are still the passthroughs.
 */
export const LoomPiAdapterHooksLive = Layer.effect(
  LoomPiAdapterHooks,
  Effect.gen(function* () {
    const health = yield* ProviderHealthRegistry;
    return {
      ...passthroughLoomPiAdapterHooks,
      classifier: (errorText, selection) =>
        Effect.all([health.snapshot, Clock.currentTimeMillis]).pipe(
          Effect.map(([marks, now]) => classifyPiFailure(errorText, selection, marks, now)),
        ),
    } satisfies LoomPiAdapterHooksShape;
  }),
);

/**
 * Exhaustion state (`ProviderHealthRegistryLive`), which also holds the
 * ephemeral account-usage telemetry the marks derive from (fed by
 * `SubscriptionUsagePoller`). Its `providerFailover` settings subscription is
 * detached in pull 9 (ledger DT-92).
 *
 * It also carries {@link LoomPiAdapterHooksLive}: this export sits below the
 * provider-instance registry in `server.ts`, so every `PiAdapterV2Driver.create`
 * yields the live hooks with no `server.ts` line of their own.
 */
export const LoomProviderHealthLive = LoomPiAdapterHooksLive.pipe(
  Layer.provideMerge(ProviderHealthRegistryLive),
);

/**
 * Loom's sidecar store and the goal broadcast (with its cascade reactor),
 * exposed to the runtime so `ws.ts` (and Phase 3a's handlers) can read goals
 * and publish/subscribe goal shell items; and the re-drive reactor that moves
 * cascades and gate legs until Phase 3b's dispatcher absorbs it. Pull 9 Phase 2 §4.
 */
export const LoomGoalBroadcastLive = Layer.mergeAll(
  LoomGoalBroadcast.layerWithReactor,
  LoomReDriveReactor.pipe(Layer.provide(CommandReceiptStore.layer)), // loom: re-drive (D16)
).pipe(Layer.provideMerge(LoomStore.layer));

/**
 * The open-session composer `ProviderSessionManager` asks for each thread's
 * prompt, skills and extensions (driver plan §4). Empty until Phase 3a re-points
 * this one export at the real composer.
 */
export const LoomSessionComposerLive = LoomSessionComposerDefaultLive;
