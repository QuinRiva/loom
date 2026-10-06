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
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";

import type * as ServerConfig from "../config.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import {
  LoomPiAdapterHooks,
  type LoomPiAdapterHooksShape,
} from "../provider/Drivers/Pi/loomAdapterHooks.loom.ts";
import { classifyPiFailure } from "../provider/Drivers/Pi/piQuotaClassifier.loom.ts";
import {
  sanitisePiSessionFile,
  slugRoutesToAnthropic,
} from "../provider/Drivers/Pi/SessionIdSanitiser.loom.ts";
import { subscriptionScopeForSelection } from "../provider/exhaustionMapping.ts";
import {
  ProviderHealthRegistry,
  ProviderHealthRegistryLive,
} from "../provider/Services/ProviderHealthRegistry.ts";
import * as LoomUsageLedger from "./economics/LoomUsageLedger.ts";
import { RerouteSweepLive } from "./economics/RerouteSweep.ts";
import { UsageLedgerReactorLive } from "./economics/UsageLedgerReactor.ts";
import { LoomReDriveReactor } from "./orchestration/redrive.ts";
import * as LoomGoalBroadcast from "./projection/LoomGoalBroadcast.ts";
import * as LoomStore from "./projection/LoomStore.ts";
import { LoomSessionComposerDefaultLive } from "./prompt/sessionComposer.ts";
import * as PendingSteering from "./steering/pendingSteering.ts";
import { SubscriptionUsagePollerLive } from "../provider/Layers/SubscriptionUsagePoller.ts";

/**
 * Track 3c's driver economics (plan seam 19), reaching the runtime through
 * `LoomProviderRuntimeLive`:
 *
 * - `RerouteSweepLive` — the cross-vendor reroute, move-back and no-reset resume
 *   for pi threads stopped on a usage limit (3c-2; `loom_thread_reroute`, 1050).
 * - `UsageLedgerReactorLive` — one `loom_usage_ledger` row per terminal provider
 *   turn (3c-3; 1049).
 * - `LoomUsageLedger.layer` — seam 11's `threadSpend` / `topSpend`, exposed to
 *   the runtime for 3d's ws methods.
 *
 * The fourth member, the pi adapter's live hooks ({@link LoomPiAdapterHooksLive}:
 * quota classifier, resume sanitiser, steer stash), cannot sit here: drivers
 * are built inside the provider-instance registry, which captures its context
 * below this position, so the hooks ride {@link LoomProviderHealthLive}.
 * Every service these read is already in the runtime here except the Loom
 * sidecar store, which this export brings.
 */
export const LoomDriverEconomicsLive = Layer.mergeAll(
  RerouteSweepLive,
  UsageLedgerReactorLive,
  LoomUsageLedger.layer,
).pipe(Layer.provide(LoomStore.layer));

/** Provider sweeps merged into the provider runtime layer. */
export const LoomProviderRuntimeLive = Layer.mergeAll(
  SubscriptionUsagePollerLive,
  LoomDriverEconomicsLive,
);

/**
 * The pi adapter's Loom hooks (Phase 3 track 3c). The quota classifier reads
 * the health marks at classification time, so a quota error with no reset in
 * its text takes the account window's; a usage limit it finds is marked on the
 * model (until its reset, or the registry's 30-minute default), which is what
 * the reroute sweep waits on before resuming a failure upstream cannot arm. The
 * sanitiser rewrites codex tool ids before an Anthropic-family resume (3c-2);
 * the steer stash keeps steers pi accepted in `<stateDir>/pending-steering/`
 * until their turn ends, for 3b's startup pass to redeliver (3c-3, seam 20).
 */
export const LoomPiAdapterHooksLive = Layer.effect(
  LoomPiAdapterHooks,
  Effect.gen(function* () {
    const health = yield* ProviderHealthRegistry;
    const stashContext = yield* Effect.context<
      ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path
    >();
    return {
      classifier: (errorText, selection) =>
        Effect.all([health.snapshot, Clock.currentTimeMillis]).pipe(
          Effect.map(([marks, now]) => classifyPiFailure(errorText, selection, marks, now)),
          Effect.tap((classified) => {
            const { accountKey, modelId } = subscriptionScopeForSelection(
              selection,
              new Set([selection.instanceId]),
            );
            return classified.usageLimit && accountKey !== null
              ? health.markExhausted({
                  accountKey,
                  modelScope: modelId,
                  until: classified.resetAt ?? null,
                  source: "error",
                })
              : Effect.void;
          }),
        ),
      sanitiser: (sessionFilePath, modelSlug) =>
        slugRoutesToAnthropic(modelSlug)
          ? Effect.sync(() => sanitisePiSessionFile(sessionFilePath))
          : Effect.void,
      steerStash: {
        append: (threadId, text) =>
          PendingSteering.append(threadId, text).pipe(Effect.provide(stashContext)),
        clear: (threadId) => PendingSteering.clear(threadId).pipe(Effect.provide(stashContext)),
      },
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
