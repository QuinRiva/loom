import {
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
  type ServerProvider,
  ServerSettingsError,
} from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  applyUsageLimitsUpdate,
  removeUsageLimitWindows,
  resolveUsageLimitsAfterProbe,
} from "./providerUsageLimits.ts";
import type { ServerProviderShape } from "./Services/ServerProvider.ts";

interface ProviderSnapshotState {
  readonly snapshot: ServerProvider;
  readonly enrichmentGeneration: number;
}

function withUsageLimits(
  snapshot: ServerProvider,
  usageLimits: ServerProvider["usageLimits"],
): ServerProvider {
  if (snapshot.usageLimits === usageLimits) {
    return snapshot;
  }
  const { usageLimits: _previous, ...rest } = snapshot;
  return usageLimits ? { ...rest, usageLimits } : rest;
}

// loom: a base refresh must never publish a snapshot that lost palette content.
/**
 * Snapshot list fields whose content can regress across a refresh: the model
 * catalogue and the two command palettes.
 */
export type EnrichableField = "models" | "slashCommands" | "skills";

/**
 * Keep a periodic base refresh from publishing a snapshot that has *lost*
 * palette content the last one had.
 *
 * Two ways `checkProvider` regresses, and authority differs per field per
 * provider:
 *
 *  - Fields the enrichment step **owns** (`enrichmentOwnedFields`) are ones
 *    the base probe cannot see at all — pi's base snapshot reports a
 *    placeholder model shortlist and no commands, and only
 *    `enrichPiSnapshot`'s throwaway `pi --mode rpc` knows the real values. The
 *    previous value always wins there, because the base's is a placeholder
 *    rather than an observation.
 *  - Every other field stays **base-authoritative**, so live changes surface
 *    immediately (Claude re-reads `~/.claude/skills` from disk and Codex
 *    re-runs `skills/list` on every check). Those only carry forward when the
 *    base reports *empty*, which is the shape a failed or timed-out probe
 *    takes.
 *
 * Without this the `$` palette and model picker blank for the seconds until
 * enrichment lands — every refresh interval, forever.
 *
 * A base snapshot that reports the provider as *not installed* is never carried
 * forward from: its emptiness is an observation (the executable is gone), not a
 * probe that failed to see anything.
 *
 * Genuine loss still propagates: `enrichSnapshot` publishes its own
 * observations directly (pi now omits the palette fields when `get_commands`
 * fails or comes back empty, so its last good palette stands rather than being
 * overwritten with an empty one), a base-authoritative provider surfaces any
 * non-empty change immediately, and a disabled provider reports its emptiness
 * verbatim. The residual corner is a base-authoritative provider losing *all*
 * of its skills at once, which is indistinguishable from a failed probe and so
 * stays until the next restart or settings change.
 */
function carryForwardEnrichment(input: {
  readonly base: ServerProvider;
  readonly previous: ServerProvider;
  readonly enrichmentOwnedFields: ReadonlyArray<EnrichableField>;
}): ServerProvider {
  const carry = (field: EnrichableField) =>
    input.base.enabled &&
    input.base.installed &&
    input.previous[field].length > 0 &&
    (input.enrichmentOwnedFields.includes(field) || input.base[field].length === 0);
  return {
    ...input.base,
    ...(carry("models") ? { models: input.previous.models } : {}),
    ...(carry("slashCommands") ? { slashCommands: input.previous.slashCommands } : {}),
    ...(carry("skills") ? { skills: input.previous.skills } : {}),
  };
}

export const makeManagedServerProvider = Effect.fn("makeManagedServerProvider")(function* <
  Settings,
>(input: {
  readonly resolveMaintenance: ServerProviderShape["resolveMaintenance"];
  readonly getSettings: Effect.Effect<Settings, ServerSettingsError>;
  readonly streamSettings: Stream.Stream<Settings>;
  readonly haveSettingsChanged: (previous: Settings, next: Settings) => boolean;
  readonly initialSnapshot: (settings: Settings) => Effect.Effect<ServerProvider>;
  readonly checkProvider: Effect.Effect<ServerProvider, ServerSettingsError>;
  readonly enrichSnapshot?: (input: {
    readonly settings: Settings;
    readonly snapshot: ServerProvider;
    readonly getSnapshot: Effect.Effect<ServerProvider>;
    readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  }) => Effect.Effect<void>;
  /**
   * Fields `enrichSnapshot` re-probes and republishes itself, so the base
   * check's values for them are placeholders to be ignored rather than
   * observations. Only pi qualifies; every other driver's enrichment merely
   * attaches a version advisory and passes these fields through untouched.
   */
  readonly enrichmentOwnedFields?: ReadonlyArray<EnrichableField>;
  readonly refreshInterval?: Duration.Input;
  readonly refreshOnInterval?: boolean;
  readonly checkProviderOnSettingsChange?: (previous: Settings, next: Settings) => boolean;
}): Effect.fn.Return<
  ServerProviderShape,
  ServerSettingsError,
  Scope.Scope | BackgroundPolicy.BackgroundPolicy | ServerSettingsService
> {
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const serverSettings = yield* ServerSettingsService;
  const refreshSemaphore = yield* Semaphore.make(1);
  const changesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<ServerProvider>(),
    PubSub.shutdown,
  );
  const initialSettings = yield* input.getSettings;
  const initialSnapshot = yield* input.initialSnapshot(initialSettings);
  const snapshotStateRef = yield* Ref.make<ProviderSnapshotState>({
    snapshot: initialSnapshot,
    enrichmentGeneration: 0,
  });
  const settingsRef = yield* Ref.make(initialSettings);
  const enrichmentFiberRef = yield* Ref.make<Fiber.Fiber<void, unknown> | null>(null);
  const scope = yield* Effect.scope;

  const publishEnrichedSnapshot = Effect.fn("publishEnrichedSnapshot")(function* (
    generation: number,
    nextSnapshot: ServerProvider,
  ) {
    const snapshotToPublish = yield* Ref.modify(snapshotStateRef, (state) => {
      if (state.enrichmentGeneration !== generation) {
        return [null, state] as const;
      }
      // Enrichment derives from the snapshot it was handed; a runtime usage
      // update that landed since must not be reverted by it.
      const merged = withUsageLimits(nextSnapshot, state.snapshot.usageLimits);
      if (Equal.equals(state.snapshot, merged)) {
        return [null, state] as const;
      }
      return [merged, { ...state, snapshot: merged }] as const;
    });
    if (snapshotToPublish === null) {
      return;
    }
    yield* PubSub.publish(changesPubSub, snapshotToPublish);
  });

  const restartSnapshotEnrichment = Effect.fn("restartSnapshotEnrichment")(function* (
    settings: Settings,
    snapshot: ServerProvider,
    generation: number,
  ) {
    const previousFiber = yield* Ref.getAndSet(enrichmentFiberRef, null);
    if (previousFiber) {
      yield* Fiber.interrupt(previousFiber).pipe(Effect.ignore);
    }

    if (!input.enrichSnapshot) {
      return;
    }

    const fiber = yield* input
      .enrichSnapshot({
        settings,
        snapshot,
        getSnapshot: Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot)),
        publishSnapshot: (nextSnapshot) => publishEnrichedSnapshot(generation, nextSnapshot),
      })
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(scope));

    yield* Ref.set(enrichmentFiberRef, fiber);
  });

  const applySnapshotBase = Effect.fn("applySnapshot")(function* (
    nextSettings: Settings,
    options?: { readonly forceRefresh?: boolean },
  ) {
    const forceRefresh = options?.forceRefresh === true;
    const previousSettings = yield* Ref.get(settingsRef);
    if (!forceRefresh && !input.haveSettingsChanged(previousSettings, nextSettings)) {
      yield* Ref.set(settingsRef, nextSettings);
      return yield* Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot));
    }

    if (
      !forceRefresh &&
      input.checkProviderOnSettingsChange?.(previousSettings, nextSettings) === false
    ) {
      const state = yield* Ref.get(snapshotStateRef);
      const nextGeneration = state.enrichmentGeneration + 1;
      yield* Ref.set(snapshotStateRef, {
        ...state,
        enrichmentGeneration: nextGeneration,
      });
      yield* Ref.set(settingsRef, nextSettings);
      yield* restartSnapshotEnrichment(nextSettings, state.snapshot, nextGeneration);
      return state.snapshot;
    }

    const probedSnapshot = yield* input.checkProvider;
    const [nextSnapshot, nextGeneration] = yield* Ref.modify(snapshotStateRef, (state) => {
      const generation = input.enrichSnapshot
        ? state.enrichmentGeneration + 1
        : state.enrichmentGeneration;
      const snapshot = withUsageLimits(
        // loom: a regressed probe must not blank the palette content we already have.
        carryForwardEnrichment({
          base: probedSnapshot,
          previous: state.snapshot,
          enrichmentOwnedFields: input.enrichmentOwnedFields ?? [],
        }),
        resolveUsageLimitsAfterProbe({
          published: state.snapshot.usageLimits,
          probed: probedSnapshot.usageLimits,
          // loom: pi's probe reports no limits at all; only a signed-out
          // probe may clear what the usage poller published.
          probedAuthStatus: probedSnapshot.auth.status,
        }),
      );
      return [
        [snapshot, generation] as const,
        {
          snapshot,
          enrichmentGeneration: generation,
        },
      ] as const;
    });
    yield* Ref.set(settingsRef, nextSettings);
    yield* PubSub.publish(changesPubSub, nextSnapshot);
    yield* restartSnapshotEnrichment(nextSettings, nextSnapshot, nextGeneration);
    return nextSnapshot;
  });
  const applySnapshot = (nextSettings: Settings, options?: { readonly forceRefresh?: boolean }) =>
    refreshSemaphore.withPermits(1)(applySnapshotBase(nextSettings, options));

  /**
   * Runtime usage updates arrive between probes. They patch only
   * `usageLimits` on whatever snapshot is published and leave the enrichment
   * generation alone, so an in-flight enrichment still lands.
   */
  // loom: both usage-limit writers share this envelope "fold, republish only if
  // the fold moved something". The fold functions hand back the same object
  // when nothing changed, which is the common case for Codex's per-tick
  // notification and for every retraction after the first.
  const updateUsageLimits = (
    fold: (previous: ServerProvider["usageLimits"]) => ServerProvider["usageLimits"],
  ) =>
    Effect.gen(function* () {
      const snapshotToPublish = yield* Ref.modify(snapshotStateRef, (state) => {
        const usageLimits = fold(state.snapshot.usageLimits);
        if (usageLimits === state.snapshot.usageLimits) {
          return [null, state] as const;
        }
        const snapshot = withUsageLimits(state.snapshot, usageLimits);
        return [snapshot, { ...state, snapshot }] as const;
      });
      if (snapshotToPublish !== null) {
        yield* PubSub.publish(changesPubSub, snapshotToPublish);
      }
    });

  const applyUsageLimits: ServerProviderShape["applyUsageLimits"] = (update) =>
    updateUsageLimits((previous) =>
      applyUsageLimitsUpdate({ previous, update, checkedAt: update.checkedAt }),
    );

  // loom: the inverse write — a feeder that stood down takes its accounts'
  // windows off the card instead of leaving them frozen there.
  const retractUsageLimits: ServerProviderShape["retractUsageLimits"] = (input) =>
    updateUsageLimits((previous) => removeUsageLimitWindows({ ...input, previous }));

  const refreshSnapshot = Effect.fn("refreshSnapshot")(function* () {
    const nextSettings = yield* input.getSettings;
    return yield* applySnapshot(nextSettings, { forceRefresh: true });
  });

  const hasProviderStatusDemand = Effect.gen(function* () {
    const state = yield* Ref.get(snapshotStateRef);
    const instanceId = state.snapshot.instanceId;
    const [genericDemand, instanceDemand] = yield* Effect.all([
      backgroundPolicy.shouldRunScopeWork({ type: "provider-status" }),
      backgroundPolicy.shouldRunScopeWork({ type: "provider-status", instanceId }),
    ]);
    return genericDemand || instanceDemand;
  });

  const getRefreshInterval =
    input.refreshInterval !== undefined
      ? Effect.succeed(input.refreshInterval)
      : serverSettings.getSettings.pipe(
          Effect.map(
            (settings) =>
              resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
          ),
          Effect.orElseSucceed(() => DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL),
        );

  const refreshIntervalChanges = yield* Queue.sliding<void>(1);
  if (input.refreshInterval === undefined) {
    const serverSettingsChanges = yield* serverSettings.subscribeChanges;
    yield* serverSettingsChanges.pipe(
      Stream.map((settings) =>
        Duration.toMillis(
          resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
        ),
      ),
      Stream.changes,
      Stream.runForEach(() => Queue.offer(refreshIntervalChanges, undefined).pipe(Effect.asVoid)),
      Effect.forkScoped,
    );
  }

  yield* Stream.runForEach(input.streamSettings, (nextSettings) =>
    Effect.asVoid(applySnapshot(nextSettings)),
  ).pipe(Effect.forkScoped);

  yield* Effect.forever(
    getRefreshInterval.pipe(
      Effect.flatMap((refreshInterval) =>
        Effect.raceFirst(
          Effect.sleep(
            Duration.toMillis(Duration.fromInputUnsafe(refreshInterval)) <= 0
              ? "60 seconds"
              : refreshInterval,
          ).pipe(Effect.as(true)),
          Queue.take(refreshIntervalChanges).pipe(Effect.as(false)),
        ).pipe(
          Effect.flatMap((intervalElapsed) =>
            input.refreshOnInterval !== false &&
            intervalElapsed &&
            Duration.toMillis(Duration.fromInputUnsafe(refreshInterval)) > 0
              ? hasProviderStatusDemand.pipe(
                  Effect.flatMap((shouldRefresh) =>
                    shouldRefresh ? refreshSnapshot().pipe(Effect.asVoid) : Effect.void,
                  ),
                )
              : Effect.void,
          ),
        ),
      ),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.forkScoped);

  yield* applySnapshot(initialSettings, { forceRefresh: true }).pipe(
    Effect.ignoreCause({ log: true }),
    Effect.forkScoped,
  );

  return {
    resolveMaintenance: input.resolveMaintenance,
    getSnapshot: Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot)),
    refresh: refreshSnapshot().pipe(Effect.tapError(Effect.logError), Effect.orDie),
    applyUsageLimits,
    retractUsageLimits,
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
  } satisfies ServerProviderShape;
});
