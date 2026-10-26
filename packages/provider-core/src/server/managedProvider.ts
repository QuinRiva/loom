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

import * as ProviderHost from "./ProviderHost.ts";
import {
  applyUsageLimitsUpdate,
  removeUsageLimitWindows, // loom: retraction for the subscription-usage feeder
  resolveUsageLimitsAfterProbe,
} from "./usageLimits.ts";
import type { ManagedServerProvider } from "./snapshot.ts";

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
 * Stops a periodic base refresh publishing a snapshot that lost palette content (the `$` palette and
 * model picker would blank until enrichment lands). Enrichment-owned fields keep the previous value;
 * others stay base-authoritative, carried forward only when the base is empty (a failed probe) and
 * not "not installed". A base-authoritative provider losing every skill at once stays until restart.
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
  readonly resolveMaintenance: ManagedServerProvider["resolveMaintenance"];
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
   * Fields `enrichSnapshot` re-probes and republishes itself, so the base check's values for them are
   * placeholders, not observations. No live driver passes this today.
   */
  readonly enrichmentOwnedFields?: ReadonlyArray<EnrichableField>;
  readonly refreshInterval?: Duration.Input;
  readonly refreshOnInterval?: boolean | ((snapshot: ServerProvider) => boolean);
  readonly checkProviderOnSettingsChange?: (previous: Settings, next: Settings) => boolean;
}): Effect.fn.Return<
  ManagedServerProvider,
  ServerSettingsError,
  Scope.Scope | ProviderHost.ProviderHost
> {
  const host = yield* ProviderHost.ProviderHost;
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
      // Enrichment must not revert usage updates newer than its input snapshot.
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

    if (!input.enrichSnapshot || !snapshot.enabled) {
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
    const { snapshot: nextSnapshot, generation: nextGeneration } = yield* Ref.modify(
      snapshotStateRef,
      (state) => {
        const generation = input.enrichSnapshot
          ? state.enrichmentGeneration + 1
          : state.enrichmentGeneration;
        // Failed reads retain limits only for the same account and original workspace.
        const previous = state.snapshot.auth;
        const differs = (a: string | undefined, b: string | undefined) =>
          a !== undefined && b !== undefined && a !== b;
        const switchedAccount =
          differs(probedSnapshot.auth.email?.toLowerCase(), previous.email?.toLowerCase()) ||
          (probedSnapshot.auth.workspaceId !== undefined &&
            probedSnapshot.auth.workspaceId !== previous.workspaceId);
        const usageLimits = switchedAccount
          ? probedSnapshot.usageLimits
          : resolveUsageLimitsAfterProbe({
              published: state.snapshot.usageLimits,
              probed: probedSnapshot.usageLimits,
              // loom: pi's probe reports no limits at all; only a signed-out
              // probe may clear what the usage poller published.
              probedAuthStatus: probedSnapshot.auth.status,
            });
        const workspaceId =
          usageLimits === probedSnapshot.usageLimits ? undefined : state.snapshot.auth.workspaceId;
        const snapshot = withUsageLimits(
          // loom: a regressed probe must not blank the palette content we already have.
          carryForwardEnrichment({
            base:
              workspaceId && !probedSnapshot.auth.workspaceId
                ? { ...probedSnapshot, auth: { ...probedSnapshot.auth, workspaceId } }
                : probedSnapshot,
            previous: state.snapshot,
            enrichmentOwnedFields: input.enrichmentOwnedFields ?? [],
          }),
          usageLimits,
        );
        return [
          { snapshot, generation },
          { snapshot, enrichmentGeneration: generation },
        ] as const;
      },
    );
    yield* Ref.set(settingsRef, nextSettings);
    yield* PubSub.publish(changesPubSub, nextSnapshot);
    yield* restartSnapshotEnrichment(nextSettings, nextSnapshot, nextGeneration);
    return nextSnapshot;
  });
  const applySnapshot = (nextSettings: Settings, options?: { readonly forceRefresh?: boolean }) =>
    refreshSemaphore.withPermits(1)(applySnapshotBase(nextSettings, options));

  // Providers call this on every token-usage tick, usually without changing the snapshot.
  // loom: both usage-limit writers share this "fold, republish only if it moved" envelope; folds
  // return the same object when nothing changed (Codex's per-tick notification, repeat retractions).
  const updateUsageLimits = Effect.fnUntraced(function* (
    fold: (previous: ServerProvider["usageLimits"]) => ServerProvider["usageLimits"],
  ) {
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

  const applyUsageLimits: ManagedServerProvider["applyUsageLimits"] = (update) =>
    updateUsageLimits((previous) =>
      applyUsageLimitsUpdate({ previous, update, checkedAt: update.checkedAt }),
    );

  // loom: the inverse write — a feeder that stood down takes its accounts'
  // windows off the card instead of leaving them frozen there.
  const retractUsageLimits: ManagedServerProvider["retractUsageLimits"] = (input) =>
    updateUsageLimits((previous) => removeUsageLimitWindows({ ...input, previous }));

  const refreshSnapshot = Effect.fn("refreshSnapshot")(function* () {
    const nextSettings = yield* input.getSettings;
    return yield* applySnapshot(nextSettings, { forceRefresh: true });
  });

  const shouldRefreshOnInterval = Effect.gen(function* () {
    const state = yield* Ref.get(snapshotStateRef);
    // A disabled instance has nothing to probe; a periodic check would only
    // republish a snapshot that differs in checkedAt.
    if (
      !state.snapshot.enabled ||
      input.refreshOnInterval === false ||
      (typeof input.refreshOnInterval === "function" && !input.refreshOnInterval(state.snapshot))
    ) {
      return false;
    }
    const instanceId = state.snapshot.instanceId;
    const [genericDemand, instanceDemand] = yield* Effect.all([
      host.shouldRunBackgroundWork({ type: "provider-status" }),
      host.shouldRunBackgroundWork({ type: "provider-status", instanceId }),
    ]);
    return genericDemand || instanceDemand;
  });

  const getRefreshInterval =
    input.refreshInterval !== undefined
      ? Effect.succeed(input.refreshInterval)
      : host.settings.get.pipe(
          Effect.map(
            (settings) =>
              resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
          ),
          Effect.orElseSucceed(() => DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL),
        );

  const refreshIntervalChanges = yield* Queue.sliding<void>(1);
  if (input.refreshInterval === undefined) {
    const serverSettingsChanges = yield* host.settings.subscribe;
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
        // @effect-diagnostics-next-line raceFirstWithSleepToTimeout:off - races the interval against a settings-change signal, not a timeout
        Effect.raceFirst(
          Effect.sleep(
            Duration.toMillis(Duration.fromInputUnsafe(refreshInterval)) <= 0
              ? "60 seconds"
              : refreshInterval,
          ).pipe(Effect.as(true)),
          Queue.take(refreshIntervalChanges).pipe(Effect.as(false)),
        ).pipe(
          Effect.flatMap((intervalElapsed) =>
            intervalElapsed && Duration.toMillis(Duration.fromInputUnsafe(refreshInterval)) > 0
              ? shouldRefreshOnInterval.pipe(
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
    refresh: input
      .resolveMaintenance({ fresh: true })
      .pipe(Effect.andThen(refreshSnapshot), Effect.tapError(Effect.logError), Effect.orDie),
    applyUsageLimits,
    retractUsageLimits,
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
  } satisfies ManagedServerProvider;
});
