import type { ServerProvider } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";

import type { ServerProviderShape } from "./Services/ServerProvider.ts";
import { ServerSettingsError } from "@t3tools/contracts";

interface ProviderSnapshotState {
  readonly snapshot: ServerProvider;
  readonly enrichmentGeneration: number;
}

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
  readonly maintenanceCapabilities: ServerProviderShape["maintenanceCapabilities"];
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
}): Effect.fn.Return<ServerProviderShape, ServerSettingsError, Scope.Scope> {
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
      if (state.enrichmentGeneration !== generation || Equal.equals(state.snapshot, nextSnapshot)) {
        return [null, state] as const;
      }
      return [
        nextSnapshot,
        {
          ...state,
          snapshot: nextSnapshot,
        },
      ] as const;
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

    const baseSnapshot = yield* input.checkProvider;
    const [nextSnapshot, nextGeneration] = yield* Ref.modify(snapshotStateRef, (state) => {
      const generation = input.enrichSnapshot
        ? state.enrichmentGeneration + 1
        : state.enrichmentGeneration;
      const snapshot = carryForwardEnrichment({
        base: baseSnapshot,
        previous: state.snapshot,
        enrichmentOwnedFields: input.enrichmentOwnedFields ?? [],
      });
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

  const refreshSnapshot = Effect.fn("refreshSnapshot")(function* () {
    const nextSettings = yield* input.getSettings;
    return yield* applySnapshot(nextSettings, { forceRefresh: true });
  });

  yield* Stream.runForEach(input.streamSettings, (nextSettings) =>
    Effect.asVoid(applySnapshot(nextSettings)),
  ).pipe(Effect.forkScoped);

  yield* Effect.forever(
    Effect.sleep(input.refreshInterval ?? "60 seconds").pipe(
      Effect.flatMap(() => refreshSnapshot()),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.forkScoped);

  yield* applySnapshot(initialSettings, { forceRefresh: true }).pipe(
    Effect.ignoreCause({ log: true }),
    Effect.forkScoped,
  );

  return {
    maintenanceCapabilities: input.maintenanceCapabilities,
    getSnapshot: Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot)),
    refresh: refreshSnapshot().pipe(Effect.tapError(Effect.logError), Effect.orDie),
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
  } satisfies ServerProviderShape;
});
