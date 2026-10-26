/**
 * Loom's server layer bundles, spliced into upstream's `server.ts` with one `// loom:` line each so
 * that file stays mergeable.
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
  sanitisePiSessionFile,
  slugRoutesToAnthropic,
} from "@t3tools/provider-pi/server/loom";
import { classifyPiFailure } from "../provider/Drivers/Pi/piQuotaClassifier.loom.ts";
import { subscriptionScopeForSelection } from "../provider/exhaustionMapping.ts";
import * as LoomUsageLedger from "./economics/LoomUsageLedger.ts";
import { RerouteSweepLive } from "./economics/RerouteSweep.ts";
import { UsageLedgerReactorLive } from "./economics/UsageLedgerReactor.ts";
import { HandoffDrafterReactorLive } from "./handoff/HandoffDrafterReactor.ts";
import { HandoffDuplicateJudgePiLive } from "./handoff/handoffDuplicates.ts";
import { ReviewSnapshotReactorLive } from "./review/ReviewSnapshotReactor.ts";
import { WorkstreamDispatcherStartedLive } from "./orchestration/dispatcher/WorkstreamDispatcher.ts";
import {
  EmergentGoalGeneratorPiLive,
  EmergentGoalReactorLive,
  EmergentGoalsLive,
} from "./orchestration/EmergentGoalReactor.ts";
import { WorkstreamLivenessSweepLive } from "./orchestration/liveness/WorkstreamLivenessSweep.ts";
import * as LoomCacheBroadcast from "./projection/LoomCacheBroadcast.ts";
import * as LoomGoalBroadcast from "./projection/LoomGoalBroadcast.ts";
import * as LoomStore from "./projection/LoomStore.ts";
import * as PendingSteering from "./steering/pendingSteering.ts";
import {
  ProviderHealthRegistry,
  ProviderHealthRegistryLive,
} from "../provider/ProviderHealthRegistry.ts";
import { LoomAgentRoutesLive } from "./http/loomAgentRoutes.ts";
import * as LoomThreadConsult from "./workstream/consult.ts";
import { LoomSessionComposerRealLive } from "./prompt/sessionComposerLive.ts";
import { SubscriptionUsagePollerLive } from "../provider/SubscriptionUsagePoller.ts";
import { LoomAskReactorLive } from "./userInput/askUserQuestion.ts";

/**
 * Reroute sweep, usage-ledger reactor and spend queries, plus the Loom sidecar store. The pi adapter
 * hooks cannot sit here: drivers are built inside the provider-instance registry, which captures its
 * context below this position, so they ride {@link LoomProviderHealthLive}.
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
 * The quota classifier marks a found usage limit on the model (until reset, else 30 min), which the
 * reroute sweep waits on; the sanitiser rewrites codex tool ids before an Anthropic resume; the steer
 * stash keeps accepted steers until their turn ends; cache touches go to {@link LoomCacheBroadcast}.
 */
export const LoomPiAdapterHooksLive = Layer.effect(
  LoomPiAdapterHooks,
  Effect.gen(function* () {
    const health = yield* ProviderHealthRegistry;
    const cache = yield* LoomCacheBroadcast.LoomCacheBroadcast;
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
        write: (threadId, runId, steering, sessionFile) =>
          PendingSteering.write(threadId, runId, steering, sessionFile).pipe(
            Effect.provide(stashContext),
          ),
        read: (threadId) => PendingSteering.read(threadId).pipe(Effect.provide(stashContext)),
      },
      cache: cache.update,
    } satisfies LoomPiAdapterHooksShape;
  }),
);

/**
 * Exhaustion state and account-usage telemetry, plus {@link LoomPiAdapterHooksLive} and the cache
 * broadcast: this export sits below the provider-instance registry in `server.ts`, so every pi
 * driver and the runtime share one instance with no `server.ts` line of their own.
 */
export const LoomProviderHealthLive = LoomPiAdapterHooksLive.pipe(
  Layer.provideMerge(Layer.mergeAll(ProviderHealthRegistryLive, LoomCacheBroadcast.layer)),
);

/**
 * Loom's sidecar store, goal broadcast and cascade reactor for `ws.ts` and the handlers; also
 * `consult_thread`'s fork transport, the emergent-goal deriver, the `goal_handoff` duplicate
 * checker's model, and the writer persisting cache touches.
 */
export const LoomGoalBroadcastLive = EmergentGoalsLive.pipe(
  Layer.provide(EmergentGoalGeneratorPiLive),
  Layer.provideMerge(
    Layer.mergeAll(
      LoomGoalBroadcast.layerWithReactor,
      LoomThreadConsult.layer,
      LoomCacheBroadcast.touchWriterLive,
      HandoffDuplicateJudgePiLive,
    ),
  ),
  Layer.provideMerge(LoomStore.layer),
);

/**
 * The workstream control plane, every worker started after activation: dispatcher pass, liveness
 * sweep, emergent-goal, `/handoff` drafter and review-snapshot reactors. The startup pass is
 * `loomStartupRecovery`'s.
 */
export const LoomControlPlaneLive = Layer.mergeAll(
  WorkstreamLivenessSweepLive, // loom: 3b-3 — the sweep hands slow-tool/spinning advisories to the dispatcher
  // The same layer reference as server.ts's entry, so the broadcast and the deriver are shared.
  EmergentGoalReactorLive.pipe(Layer.provide(LoomGoalBroadcastLive)),
  HandoffDrafterReactorLive, // loom: 3b-5 — archives a drafter once its handoff is recorded
  ReviewSnapshotReactorLive,
).pipe(
  Layer.provideMerge(WorkstreamDispatcherStartedLive),
  Layer.provide([CommandReceiptStore.layer, LoomStore.layer]),
);

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
