import {
  ORCHESTRATION_WS_METHODS,
  type EnvironmentId,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamItem,
  type ServerConfig,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { connectionProjectionPhase } from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { subscribe } from "../rpc/client.ts";
import { ShellSnapshotLoader } from "./shellSnapshotHttp.ts";
import { applyShellStreamEvent } from "./shellReducer.ts";
import type { EnvironmentCatalogState } from "./connections.ts";
import { followStreamInEnvironment } from "./runtime.ts";

export type EnvironmentShellStatus = "empty" | "cached" | "synchronizing" | "live";

export interface EnvironmentShellState {
  readonly snapshot: Option.Option<OrchestrationShellSnapshot>;
  readonly status: EnvironmentShellStatus;
  readonly error: Option.Option<string>;
}

const EMPTY_SHELL_STATE: EnvironmentShellState = {
  snapshot: Option.none(),
  status: "empty",
  error: Option.none(),
};

function shellStatusForSnapshot(
  snapshot: Option.Option<OrchestrationShellSnapshot>,
): EnvironmentShellStatus {
  return Option.isSome(snapshot) ? "cached" : "empty";
}

const SHELL_SYNCHRONIZATION_ERROR_MESSAGE = "Could not synchronize environment data.";

export const makeEnvironmentShellState = Effect.fn("EnvironmentShellState.make")(function* () {
  const supervisor = yield* EnvironmentSupervisor;
  const cache = yield* EnvironmentCacheStore;
  const snapshotLoader = yield* ShellSnapshotLoader;
  const environmentId = supervisor.target.environmentId;
  const cachedSnapshot = yield* cache.loadShell(environmentId).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not load cached environment shell.").pipe(
        Effect.annotateLogs({
          environmentId,
          ...safeErrorLogAttributes(error),
        }),
        Effect.as(Option.none<OrchestrationShellSnapshot>()),
      ),
    ),
  );
  const state = yield* SubscriptionRef.make<EnvironmentShellState>({
    snapshot: cachedSnapshot,
    status: shellStatusForSnapshot(cachedSnapshot),
    error: Option.none(),
  });
  const persistence = yield* Queue.sliding<OrchestrationShellSnapshot>(1);

  const persist = Effect.fn("EnvironmentShellState.persist")(function* (
    snapshot: OrchestrationShellSnapshot,
  ) {
    yield* cache.saveShell(environmentId, snapshot).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not persist environment shell cache.").pipe(
          Effect.annotateLogs({
            environmentId,
            ...safeErrorLogAttributes(error),
          }),
        ),
      ),
    );
  });

  yield* Stream.fromQueue(persistence).pipe(
    Stream.debounce("500 millis"),
    Stream.runForEach(persist),
    Effect.forkScoped,
  );

  const setDisconnected = SubscriptionRef.update(state, (current) => ({
    ...current,
    status: shellStatusForSnapshot(current.snapshot),
  }));
  const setSynchronizing = SubscriptionRef.update(state, (current) => ({
    ...current,
    status: "synchronizing" as const,
    error: Option.none(),
  }));
  const setReady = SubscriptionRef.update(state, (current) =>
    current.status === "live"
      ? current
      : {
          ...current,
          status: "synchronizing" as const,
          error: Option.none(),
        },
  );
  const setStreamError = (error: unknown) =>
    Effect.logWarning("Could not synchronize the environment shell.").pipe(
      Effect.annotateLogs({
        environmentId,
        ...safeErrorLogAttributes(error),
      }),
      Effect.andThen(
        SubscriptionRef.update(state, (current) => ({
          ...current,
          status: shellStatusForSnapshot(current.snapshot),
          error: Option.some(SHELL_SYNCHRONIZATION_ERROR_MESSAGE),
        })),
      ),
    );

  // Fold a BURST of stream items into ONE state update. The events of a
  // single command cascade (e.g. thread.archive → goal.archived) are committed
  // in one DB transaction but streamed individually; applying them one
  // SubscriptionRef.set at a time renders every intermediate state — the
  // sidebar briefly shows an empty goal header between the thread-removed and
  // goal-removed frames. A short coalescing window collapses the whole cascade
  // (and any busy-turn event burst) into a single render.
  const applyItems = Effect.fn("EnvironmentShellState.applyItems")(function* (
    items: ReadonlyArray<OrchestrationShellStreamItem>,
  ) {
    const current = yield* SubscriptionRef.get(state);
    let nextSnapshot = Option.getOrNull(current.snapshot);
    for (const item of items) {
      if (item.kind === "snapshot") {
        nextSnapshot = item.snapshot;
      } else if (nextSnapshot !== null && item.sequence > nextSnapshot.snapshotSequence) {
        nextSnapshot = applyShellStreamEvent(nextSnapshot, item);
      }
    }
    if (nextSnapshot === null || nextSnapshot === Option.getOrNull(current.snapshot)) {
      return;
    }

    yield* SubscriptionRef.set(state, {
      snapshot: Option.some(nextSnapshot),
      status: "live",
      error: Option.none(),
    });
    yield* Queue.offer(persistence, nextSnapshot);
  });

  // Load the cold-path base: the full shell snapshot over HTTP (gzip-
  // compressible, and off the socket). Used both when there is no cached
  // snapshot and as the self-healing fallback when a warm cache cannot be
  // resumed. If no base can be established we return none so the caller falls
  // back to the socket-embedded snapshot.
  const loadColdBase = Effect.fn("EnvironmentShellState.loadColdBase")(function* () {
    const prepared = yield* SubscriptionRef.changes(supervisor.prepared).pipe(
      Stream.filter(Option.isSome),
      Stream.map((current) => current.value),
      Stream.runHead,
    );
    return Option.isSome(prepared)
      ? yield* snapshotLoader.load(prepared.value)
      : Option.none<OrchestrationShellSnapshot>();
  });

  // loom: coalesce the live-stream leg into one state update per burst
  // (groupedWithin) so a single command cascade renders once. The base snapshot
  // is established via upstream's HTTP/afterSequence flow. On the cold path a
  // replay failure is terminal and surfaces as an error; the warm-cache path
  // (below) overrides that with self-healing.
  const runShellSyncLeg = (base: Option.Option<OrchestrationShellSnapshot>) =>
    Effect.gen(function* () {
      if (Option.isSome(base)) {
        yield* applyItems([{ kind: "snapshot", snapshot: base.value }]);
      }
      const subscribeInput = Option.match(base, {
        onNone: () => ({}),
        onSome: (snapshot) => ({ afterSequence: snapshot.snapshotSequence }),
      });
      yield* subscribe(ORCHESTRATION_WS_METHODS.subscribeShell, subscribeInput, {
        onExpectedFailure: (cause) => setStreamError(Cause.squash(cause)),
        // loom: cold-leg resilience completion for the silent-drop fix. Server
        // lookup failures are now loud (they fail the stream instead of silently
        // dropping an event), so a transient failure on an established
        // connection must not park the cold leg on the error banner until the
        // next session change. Resubscribe after 5s reusing the same
        // afterSequence; the replay re-covers the interval and applyItems dedupes
        // by sequence, so the retry is idempotent. onExpectedFailure still fires,
        // so the sync warning shows during the retry window. (The WARM leg keeps
        // no-retry: its failure self-heals to this cold path with a fresh
        // snapshot, and retrying its identical replay was round 1's wedge.)
        retryExpectedFailureAfter: "5 seconds",
      }).pipe(Stream.groupedWithin(64, "20 millis"), Stream.runForEach(applyItems));
    });

  yield* Effect.forkScoped(
    Effect.gen(function* () {
      // Establish the base shell snapshot to resume from, minimizing bytes over
      // the wire. A warm cache reuses the cached snapshot (zero network) and
      // resumes via `afterSequence`; a cold cache loads the full snapshot over
      // HTTP first. Overlapping/replayed events are deduped by sequence in
      // applyItems.
      if (Option.isSome(cachedSnapshot)) {
        // loom: self-heal a poisoned warm cache. A warm-cache `afterSequence`
        // resume can fail permanently when the offline gap spans a schema
        // migration that makes a stored event undecodable server-side — the
        // catch-up replay errors, and because the same cache drives every
        // reconnect the client would otherwise retry the identical replay and
        // wedge on a stale thread list forever. On that failure we discard the
        // cache and fall through to the cold path, whose fresh snapshot is
        // re-persisted by applyItems (overwriting the poison). Worst case is a
        // one-time slower load, not a permanent wedge.
        yield* applyItems([{ kind: "snapshot", snapshot: cachedSnapshot.value }]);
        const resumeFailed = yield* Deferred.make<void>();
        yield* subscribe(
          ORCHESTRATION_WS_METHODS.subscribeShell,
          { afterSequence: cachedSnapshot.value.snapshotSequence },
          {
            onExpectedFailure: (cause) =>
              Effect.logWarning(
                "Could not resume the warm shell cache; discarding it and reloading a full snapshot.",
              ).pipe(
                Effect.annotateLogs({
                  environmentId,
                  ...safeErrorLogAttributes(Cause.squash(cause)),
                }),
                Effect.andThen(Deferred.succeed(resumeFailed, undefined)),
                Effect.asVoid,
              ),
          },
        ).pipe(
          Stream.groupedWithin(64, "20 millis"),
          Stream.runForEach(applyItems),
          // The subscription leg never completes on its own; it is interrupted
          // when the resume fails so control falls through to the cold path.
          Effect.race(Deferred.await(resumeFailed)),
        );
      }

      // Reached on a cold start, or after a warm-cache resume failed above and
      // lost the race: load the full snapshot over HTTP and resume from it.
      yield* runShellSyncLeg(yield* loadColdBase());
    }),
  );
  yield* SubscriptionRef.changes(supervisor.state).pipe(
    Stream.runForEach((connectionState) => {
      switch (connectionProjectionPhase(connectionState)) {
        case "synchronizing":
          return setSynchronizing;
        case "disconnected":
          return setDisconnected;
        case "ready":
          return setReady;
      }
    }),
    Effect.forkScoped,
  );

  return state;
});

export function shellStateChanges(environmentId: EnvironmentId) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(makeEnvironmentShellState().pipe(Effect.map(SubscriptionRef.changes))),
  );
}

export interface EnvironmentShellSummary {
  readonly hasSnapshot: boolean;
  readonly hasSynchronizingShell: boolean;
  readonly hasCachedShell: boolean;
  readonly hasLiveShell: boolean;
  readonly firstError: string | null;
  readonly latestSnapshotUpdatedAt: string | null;
}

const EMPTY_ENVIRONMENT_SHELL_SUMMARY: EnvironmentShellSummary = Object.freeze({
  hasSnapshot: false,
  hasSynchronizingShell: false,
  hasCachedShell: false,
  hasLiveShell: false,
  firstError: null,
  latestSnapshotUpdatedAt: null,
});

const EMPTY_SERVER_CONFIGS: ReadonlyMap<EnvironmentId, ServerConfig> = new Map();

function shellSummariesEqual(
  left: EnvironmentShellSummary,
  right: EnvironmentShellSummary,
): boolean {
  return (
    left.hasSnapshot === right.hasSnapshot &&
    left.hasSynchronizingShell === right.hasSynchronizingShell &&
    left.hasCachedShell === right.hasCachedShell &&
    left.hasLiveShell === right.hasLiveShell &&
    left.firstError === right.firstError &&
    left.latestSnapshotUpdatedAt === right.latestSnapshotUpdatedAt
  );
}

function mapsEqual<K, V>(left: ReadonlyMap<K, V>, right: ReadonlyMap<K, V>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [key, value] of left) {
    if (right.get(key) !== value) {
      return false;
    }
  }
  return true;
}

export function createEnvironmentShellSummaryAtom(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly shellStateValueAtom: (environmentId: EnvironmentId) => Atom.Atom<EnvironmentShellState>;
}) {
  let previousSummary = EMPTY_ENVIRONMENT_SHELL_SUMMARY;
  return Atom.make((get) => {
    let hasSnapshot = false;
    let hasSynchronizingShell = false;
    let hasCachedShell = false;
    let hasLiveShell = false;
    let firstError: string | null = null;
    let latestSnapshotUpdatedAt: string | null = null;

    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      const state = get(input.shellStateValueAtom(environmentId));
      hasSynchronizingShell ||= state.status === "synchronizing";
      hasCachedShell ||= state.status === "cached";
      hasLiveShell ||= state.status === "live";
      if (firstError === null) {
        firstError = Option.getOrNull(state.error);
      }
      if (Option.isNone(state.snapshot)) {
        continue;
      }
      hasSnapshot = true;
      const updatedAt = state.snapshot.value.updatedAt;
      if (latestSnapshotUpdatedAt === null || updatedAt > latestSnapshotUpdatedAt) {
        latestSnapshotUpdatedAt = updatedAt;
      }
    }

    const next: EnvironmentShellSummary = {
      hasSnapshot,
      hasSynchronizingShell,
      hasCachedShell,
      hasLiveShell,
      firstError,
      latestSnapshotUpdatedAt,
    };
    if (shellSummariesEqual(previousSummary, next)) {
      return previousSummary;
    }
    previousSummary = next;
    return previousSummary;
  }).pipe(Atom.withLabel("environment-shell-summary"));
}

export function createEnvironmentServerConfigsAtom(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly serverConfigValueAtom: (environmentId: EnvironmentId) => Atom.Atom<ServerConfig | null>;
}) {
  let previousServerConfigs = EMPTY_SERVER_CONFIGS;
  return Atom.make((get) => {
    const next = new Map<EnvironmentId, ServerConfig>();
    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      const config = get(input.serverConfigValueAtom(environmentId));
      if (config !== null) {
        next.set(environmentId, config);
      }
    }
    if (mapsEqual(previousServerConfigs, next)) {
      return previousServerConfigs;
    }
    previousServerConfigs = next;
    return previousServerConfigs;
  }).pipe(Atom.withLabel("environment-server-configs"));
}

export function createEnvironmentShellAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    EnvironmentRegistry | EnvironmentCacheStore | ShellSnapshotLoader | R,
    E
  >,
) {
  const stateAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime.atom(shellStateChanges(environmentId), {
      initialValue: EMPTY_SHELL_STATE,
    }),
  );

  const stateValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      Option.getOrElse(AsyncResult.value(get(stateAtom(environmentId))), () => EMPTY_SHELL_STATE),
    ).pipe(Atom.withLabel(`environment-shell-state-value:${environmentId}`)),
  );

  return {
    stateAtom,
    stateValueAtom,
  };
}

export * from "./models.ts";
export * from "./shellCommands.ts";
export * from "./shellReducer.ts";
export * from "./shellSnapshotHttp.ts";
export * from "./snapshots.ts";
