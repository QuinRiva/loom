import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type {
  GitManagerServiceError,
  VcsStatusInput,
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "@t3tools/contracts";
import { mergeGitStatusParts } from "@t3tools/shared/git";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";

const DEFAULT_VCS_STATUS_REFRESH_INTERVAL = Duration.seconds(30);
// Spread the steady-state poll cadence so pollers for different worktrees whose
// timers align (e.g. after a reconnect opens many sessions at once) don't fire a
// synchronised burst of git subprocesses. Applied to the success delay only;
// failure backoff (remoteRefreshFailureDelay) stays deterministic.
const STATUS_REFRESH_JITTER_FRACTION = 0.2;
const VCS_STATUS_REFRESH_FAILURE_BASE_DELAY = Duration.seconds(30);
const VCS_STATUS_REFRESH_FAILURE_MAX_DELAY = Duration.minutes(15);
const MAX_FAILURE_DIAGNOSTIC_VALUES = 8;
const MAX_FAILURE_DIAGNOSTIC_VALUE_LENGTH = 128;

function boundedDiagnosticValue(value: string): string {
  return value.slice(0, MAX_FAILURE_DIAGNOSTIC_VALUE_LENGTH);
}

function diagnosticValueTag(value: unknown): string {
  try {
    if (
      typeof value === "object" &&
      value !== null &&
      "_tag" in value &&
      typeof value._tag === "string"
    ) {
      return boundedDiagnosticValue(value._tag);
    }
    if (value instanceof Error) {
      return boundedDiagnosticValue(value.name);
    }
    return typeof value;
  } catch {
    return "Uninspectable";
  }
}

function diagnosticFailureOperation(value: unknown): string | undefined {
  try {
    if (
      typeof value === "object" &&
      value !== null &&
      "operation" in value &&
      typeof value.operation === "string"
    ) {
      return boundedDiagnosticValue(value.operation);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function addUniqueDiagnosticValue(values: Array<string>, value: string | undefined): void {
  if (
    value !== undefined &&
    values.length < MAX_FAILURE_DIAGNOSTIC_VALUES &&
    !values.includes(value)
  ) {
    values.push(value);
  }
}

export function remoteRefreshFailureDiagnostics(cause: Cause.Cause<unknown>) {
  const failureTags: Array<string> = [];
  const failureOperations: Array<string> = [];
  const defectTags: Array<string> = [];
  let failureCount = 0;
  let defectCount = 0;
  let interruptionCount = 0;

  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason)) {
      failureCount += 1;
      addUniqueDiagnosticValue(failureTags, diagnosticValueTag(reason.error));
      addUniqueDiagnosticValue(failureOperations, diagnosticFailureOperation(reason.error));
      continue;
    }
    if (Cause.isDieReason(reason)) {
      defectCount += 1;
      addUniqueDiagnosticValue(defectTags, diagnosticValueTag(reason.defect));
      continue;
    }
    interruptionCount += 1;
  }

  return {
    reasonCount: cause.reasons.length,
    failureCount,
    failureTags,
    failureOperations,
    defectCount,
    defectTags,
    interruptionCount,
  };
}

interface VcsStatusChange {
  readonly cwd: string;
  readonly event: VcsStatusStreamEvent;
}

interface CachedValue<T> {
  readonly fingerprint: string;
  readonly value: T;
}

interface CachedVcsStatus {
  readonly local: CachedValue<VcsStatusLocalResult> | null;
  readonly remote: CachedValue<VcsStatusRemoteResult | null> | null;
}

interface RemoteStatusSubscriber {
  readonly count: number;
  readonly interval: Effect.Effect<Duration.Duration, never>;
}

interface ActiveRemotePoller {
  readonly fiber: Fiber.Fiber<void, never>;
  readonly wake: Queue.Queue<void>;
  readonly repository: { readonly gitCommonDir: string; readonly repositoryCwd: string } | null;
  readonly subscribers: ReadonlyMap<string, RemoteStatusSubscriber>;
  readonly initialPending: ReadonlySet<string>;
}

interface PollerRegistration {
  readonly wakeNow: Queue.Queue<void> | null;
  readonly registered: Deferred.Deferred<void> | null;
}

interface StreamStatusOptions {
  readonly automaticRemoteRefreshInterval?: Effect.Effect<Duration.Duration, never>;
}

const withRefreshJitter = (interval: Duration.Duration): Effect.Effect<Duration.Duration> =>
  Random.next.pipe(
    Effect.map((factor) =>
      Duration.millis(
        Math.round(Duration.toMillis(interval) * (1 + factor * STATUS_REFRESH_JITTER_FRACTION)),
      ),
    ),
  );

export function remoteRefreshFailureDelay(
  consecutiveFailures: number,
  configuredInterval: Duration.Duration,
) {
  const exponent = Math.max(0, consecutiveFailures - 1);
  const backoffMs =
    Duration.toMillis(VCS_STATUS_REFRESH_FAILURE_BASE_DELAY) * Math.pow(2, exponent);
  const cappedBackoff = Duration.min(
    Duration.millis(backoffMs),
    VCS_STATUS_REFRESH_FAILURE_MAX_DELAY,
  );
  return Duration.max(configuredInterval, cappedBackoff);
}

export class VcsStatusBroadcaster extends Context.Service<
  VcsStatusBroadcaster,
  {
    readonly getStatus: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
    readonly refreshLocalStatus: (
      cwd: string,
    ) => Effect.Effect<VcsStatusLocalResult, GitManagerServiceError>;
    readonly refreshStatus: (cwd: string) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
    readonly streamStatus: (
      input: VcsStatusInput,
      options?: StreamStatusOptions,
    ) => Stream.Stream<VcsStatusStreamEvent, GitManagerServiceError>;
  }
>()("t3/vcs/VcsStatusBroadcaster") {}

function fingerprintStatusPart(status: unknown): string {
  return JSON.stringify(status);
}

const normalizeCwd = (cwd: string) =>
  Effect.service(FileSystem.FileSystem).pipe(
    Effect.flatMap((fs) => fs.realPath(cwd)),
    Effect.orElseSucceed(() => cwd),
  );

export const make = Effect.gen(function* () {
  const workflow = yield* GitWorkflowService.GitWorkflowService;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const fs = yield* FileSystem.FileSystem;
  const changesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<VcsStatusChange>(),
    (pubsub) => PubSub.shutdown(pubsub),
  );
  const broadcasterScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const cacheRef = yield* Ref.make(new Map<string, CachedVcsStatus>());
  const pollersRef = yield* SynchronizedRef.make(new Map<string, ActiveRemotePoller>());
  const repositoryKeyByCwdRef = yield* Ref.make(new Map<string, string>());

  const getCachedStatus = Effect.fn("VcsStatusBroadcaster.getCachedStatus")(function* (
    cwd: string,
  ) {
    return yield* Ref.get(cacheRef).pipe(Effect.map((cache) => cache.get(cwd) ?? null));
  });

  const updateCachedLocalStatus = Effect.fn("VcsStatusBroadcaster.updateCachedLocalStatus")(
    function* (cwd: string, local: VcsStatusLocalResult, options?: { publish?: boolean }) {
      const nextLocal = {
        fingerprint: fingerprintStatusPart(local),
        value: local,
      } satisfies CachedValue<VcsStatusLocalResult>;
      const shouldPublish = yield* Ref.modify(cacheRef, (cache) => {
        const previous = cache.get(cwd) ?? { local: null, remote: null };
        const nextCache = new Map(cache);
        nextCache.set(cwd, {
          ...previous,
          local: nextLocal,
        });
        return [previous.local?.fingerprint !== nextLocal.fingerprint, nextCache] as const;
      });

      if (options?.publish && shouldPublish) {
        yield* PubSub.publish(changesPubSub, {
          cwd,
          event: {
            _tag: "localUpdated",
            local,
          },
        });
      }

      return local;
    },
  );

  const updateCachedRemoteStatus = Effect.fn("VcsStatusBroadcaster.updateCachedRemoteStatus")(
    function* (cwd: string, remote: VcsStatusRemoteResult | null, options?: { publish?: boolean }) {
      const nextRemote = {
        fingerprint: fingerprintStatusPart(remote),
        value: remote,
      } satisfies CachedValue<VcsStatusRemoteResult | null>;
      const shouldPublish = yield* Ref.modify(cacheRef, (cache) => {
        const previous = cache.get(cwd) ?? { local: null, remote: null };
        const nextCache = new Map(cache);
        nextCache.set(cwd, {
          ...previous,
          remote: nextRemote,
        });
        return [previous.remote?.fingerprint !== nextRemote.fingerprint, nextCache] as const;
      });

      if (options?.publish && shouldPublish) {
        yield* PubSub.publish(changesPubSub, {
          cwd,
          event: {
            _tag: "remoteUpdated",
            remote,
          },
        });
      }

      return remote;
    },
  );

  const updateCachedStatus = Effect.fn("VcsStatusBroadcaster.updateCachedStatus")(function* (
    cwd: string,
    local: VcsStatusLocalResult,
    remote: VcsStatusRemoteResult | null,
    options?: { publish?: boolean },
  ) {
    const nextLocal = {
      fingerprint: fingerprintStatusPart(local),
      value: local,
    } satisfies CachedValue<VcsStatusLocalResult>;
    const nextRemote = {
      fingerprint: fingerprintStatusPart(remote),
      value: remote,
    } satisfies CachedValue<VcsStatusRemoteResult | null>;
    const shouldPublish = yield* Ref.modify(cacheRef, (cache) => {
      const previous = cache.get(cwd) ?? { local: null, remote: null };
      const nextCache = new Map(cache);
      nextCache.set(cwd, {
        local: nextLocal,
        remote: nextRemote,
      });
      return [
        previous.local?.fingerprint !== nextLocal.fingerprint ||
          previous.remote?.fingerprint !== nextRemote.fingerprint,
        nextCache,
      ] as const;
    });

    if (options?.publish && shouldPublish) {
      yield* PubSub.publish(changesPubSub, {
        cwd,
        event: {
          _tag: "snapshot",
          local,
          remote,
        },
      });
    }

    return mergeGitStatusParts(local, remote);
  });

  const loadLocalStatus = Effect.fn("VcsStatusBroadcaster.loadLocalStatus")(function* (
    cwd: string,
  ) {
    const local = yield* workflow.localStatus({ cwd });
    return yield* updateCachedLocalStatus(cwd, local);
  });

  const getOrLoadLocalStatus = Effect.fn("VcsStatusBroadcaster.getOrLoadLocalStatus")(function* (
    cwd: string,
  ) {
    const cached = yield* getCachedStatus(cwd);
    if (cached?.local) {
      return cached.local.value;
    }
    return yield* loadLocalStatus(cwd);
  });

  const withFileSystem = Effect.provideService(FileSystem.FileSystem, fs);

  const getStatus: VcsStatusBroadcaster["Service"]["getStatus"] = Effect.fn(
    "VcsStatusBroadcaster.getStatus",
  )(function* (input) {
    const cwd = yield* withFileSystem(normalizeCwd(input.cwd));
    const cached = yield* getCachedStatus(cwd);
    if (cached?.local && cached.remote) {
      return mergeGitStatusParts(cached.local.value, cached.remote.value);
    }
    const [local, remote] = yield* Effect.all(
      [
        cached?.local ? Effect.succeed(cached.local.value) : workflow.localStatus({ cwd }),
        cached?.remote ? Effect.succeed(cached.remote.value) : workflow.remoteStatus({ cwd }),
      ],
      { concurrency: "unbounded" },
    );
    return yield* updateCachedStatus(cwd, local, remote);
  });

  const refreshLocalStatusCore = Effect.fn("VcsStatusBroadcaster.refreshLocalStatusCore")(
    function* (cwd: string) {
      yield* workflow.invalidateLocalStatus(cwd);
      const local = yield* workflow.localStatus({ cwd });
      return yield* updateCachedLocalStatus(cwd, local, { publish: true });
    },
  );

  const refreshLocalStatus: VcsStatusBroadcaster["Service"]["refreshLocalStatus"] = Effect.fn(
    "VcsStatusBroadcaster.refreshLocalStatus",
  )(function* (rawCwd) {
    const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
    const previousRefName = (yield* getCachedStatus(cwd))?.local?.value.refName ?? null;
    const local = yield* refreshLocalStatusCore(cwd);
    // A local refresh fires on every turn completion. It must never bump the PR
    // epoch (the repo PR list stays on its own ~2 min TTL) and must not wake the
    // repo batch on the common no-op case — only a genuine branch change makes
    // the cached remote row wrong, because the batch keys off the local refName.
    if (local.refName !== previousRefName) {
      const repositoryKey = (yield* Ref.get(repositoryKeyByCwdRef)).get(cwd);
      const poller = repositoryKey
        ? (yield* SynchronizedRef.get(pollersRef)).get(repositoryKey)
        : undefined;
      if (poller) yield* Queue.offer(poller.wake, undefined);
    }
    return local;
  });

  const pollerIntervals = (poller: ActiveRemotePoller) =>
    Effect.forEach(poller.subscribers, ([cwd, subscriber]) =>
      subscriber.interval.pipe(Effect.map((interval) => ({ cwd, interval }))),
    );

  const refreshRepositoryRemoteStatus = Effect.fn(
    "VcsStatusBroadcaster.refreshRepositoryRemoteStatus",
  )(function* (
    repositoryKey: string,
    cwds: ReadonlyArray<string>,
    options?: { readonly refreshUpstream?: boolean },
  ) {
    const poller = (yield* SynchronizedRef.get(pollersRef)).get(repositoryKey);
    if (!poller || cwds.length === 0) return;
    const cache = yield* Ref.get(cacheRef);
    const entries = cwds.flatMap((cwd) => {
      const local = cache.get(cwd)?.local?.value;
      return local ? [{ cwd, branch: local.refName }] : [];
    });
    if (entries.length === 0) return;

    const remotes = poller.repository
      ? yield* workflow.remoteStatuses(
          {
            repositoryKey,
            repositoryCwd: poller.repository.repositoryCwd,
            gitCommonDir: poller.repository.gitCommonDir,
            entries,
          },
          options,
        )
      : yield* Effect.gen(function* () {
          if (options?.refreshUpstream !== false) {
            yield* Effect.forEach(entries, (entry) => workflow.invalidateRemoteStatus(entry.cwd), {
              discard: true,
            });
          }
          return yield* Effect.forEach(entries, (entry) =>
            workflow.remoteStatus({ cwd: entry.cwd }, options),
          );
        });
    yield* Effect.forEach(
      entries,
      (entry, index) =>
        updateCachedRemoteStatus(entry.cwd, remotes[index] ?? null, { publish: true }),
      { discard: true },
    );
  });

  const clearInitialPending = (repositoryKey: string, cwds: ReadonlyArray<string>) =>
    SynchronizedRef.update(pollersRef, (pollers) => {
      const poller = pollers.get(repositoryKey);
      if (!poller) return pollers;
      const initialPending = new Set(poller.initialPending);
      for (const cwd of cwds) initialPending.delete(cwd);
      const next = new Map(pollers);
      next.set(repositoryKey, { ...poller, initialPending });
      return next;
    });

  const logRefreshFailure = (
    repositoryKey: string,
    cause: Cause.Cause<unknown>,
    consecutiveFailures: number,
    nextDelay: Duration.Duration,
  ) =>
    Effect.logWarning("VCS remote status refresh failed", {
      repositoryKeyLength: repositoryKey.length,
      ...remoteRefreshFailureDiagnostics(cause),
      consecutiveFailures,
      nextDelayMs: Duration.toMillis(nextDelay),
    });

  const makeRemoteRefreshLoop = (
    repositoryKey: string,
    wake: Queue.Queue<void>,
    registered: Deferred.Deferred<void>,
  ) =>
    Effect.gen(function* () {
      // The fiber is forked before the poller record commits to `pollersRef`;
      // wait for the registration rather than relying on scheduler ordering (a
      // missed read would exit the loop for good and wedge the repo).
      yield* Deferred.await(registered);
      const consecutiveFailuresRef = yield* Ref.make(0);
      const readCycle = Effect.gen(function* () {
        const poller = (yield* SynchronizedRef.get(pollersRef)).get(repositoryKey);
        if (!poller) return null;
        const intervals = yield* pollerIntervals(poller);
        const enabled = intervals.filter(
          ({ cwd, interval }) => !Duration.isZero(interval) || poller.initialPending.has(cwd),
        );
        const nonZeroIntervals = intervals
          .map(({ interval }) => interval)
          .filter((interval) => !Duration.isZero(interval));
        const activeInterval = nonZeroIntervals.reduce(
          (shortest, interval) =>
            Duration.toMillis(shortest) <= Duration.toMillis(interval) ? shortest : interval,
          nonZeroIntervals[0] ?? DEFAULT_VCS_STATUS_REFRESH_INTERVAL,
        );
        return { poller, enabled, activeInterval };
      });

      const initial = yield* readCycle;
      if (!initial) return;
      if (initial.poller.initialPending.size === 0) {
        yield* Effect.raceFirst(Effect.sleep(initial.activeInterval), Queue.take(wake));
      }

      while (true) {
        const cycle = yield* readCycle;
        if (!cycle) return;
        const cwds = cycle.enabled.map(({ cwd }) => cwd);
        let nextDelay = cycle.activeInterval;
        let failed = false;
        // Upstream's background-policy gate, re-homed onto the per-repository
        // poller: a tick runs only while at least one subscribed cwd still wants
        // background work (an initial refresh always does — the subscriber is
        // waiting on its first status).
        const policyAllows =
          cycle.poller.initialPending.size > 0 ||
          (yield* Effect.all(
            cwds.map((demandCwd) =>
              backgroundPolicy.shouldRunScopeWork({ type: "vcs-status", cwd: demandCwd }),
            ),
            { concurrency: "unbounded" },
          )).some(Boolean);
        if (cwds.length > 0 && policyAllows) {
          const exit = yield* refreshRepositoryRemoteStatus(repositoryKey, cwds, {
            refreshUpstream: cycle.enabled.some(({ interval }) => !Duration.isZero(interval)),
          }).pipe(Effect.exit);
          if (Exit.isSuccess(exit)) {
            yield* clearInitialPending(repositoryKey, cwds);
            yield* Ref.set(consecutiveFailuresRef, 0);
            nextDelay = yield* withRefreshJitter(cycle.activeInterval);
          } else {
            failed = true;
            const interruptionReasons = exit.cause.reasons.filter(Cause.isInterruptReason);
            if (interruptionReasons.length > 0) {
              return yield* Effect.failCause(Cause.fromReasons<never>(interruptionReasons));
            }
            const consecutiveFailures = yield* Ref.updateAndGet(
              consecutiveFailuresRef,
              (count) => count + 1,
            );
            nextDelay = remoteRefreshFailureDelay(consecutiveFailures, cycle.activeInterval);
            yield* logRefreshFailure(repositoryKey, exit.cause, consecutiveFailures, nextDelay);
          }
        }

        const current = (yield* SynchronizedRef.get(pollersRef)).get(repositoryKey);
        if (!failed && current?.initialPending.size) continue;
        yield* Effect.raceFirst(Effect.sleep(nextDelay), Queue.take(wake));
      }
    });

  const refreshStatus: VcsStatusBroadcaster["Service"]["refreshStatus"] = Effect.fn(
    "VcsStatusBroadcaster.refreshStatus",
  )(function* (rawCwd) {
    const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
    yield* workflow.invalidateStatus(cwd);
    const repositoryKey = (yield* Ref.get(repositoryKeyByCwdRef)).get(cwd);
    if (!repositoryKey) {
      const [local, remote] = yield* Effect.all(
        [workflow.localStatus({ cwd }), workflow.remoteStatus({ cwd })],
        { concurrency: "unbounded" },
      );
      return yield* updateCachedStatus(cwd, local, remote, { publish: true });
    }

    // An explicit refresh is scoped to the requesting cwd: the repo-wide reads it
    // performs are shared anyway, and its siblings (including ones with automatic
    // refresh disabled) keep their own cadence.
    const local = yield* updateCachedLocalStatus(cwd, yield* workflow.localStatus({ cwd }), {
      publish: true,
    });
    yield* refreshRepositoryRemoteStatus(repositoryKey, [cwd], { refreshUpstream: true });
    const remote = (yield* getCachedStatus(cwd))?.remote?.value ?? null;
    return mergeGitStatusParts(local, remote);
  });

  const retainRemotePoller = Effect.fn("VcsStatusBroadcaster.retainRemotePoller")(function* (
    cwd: string,
    demandCwd: string,
    automaticRemoteRefreshInterval: Effect.Effect<Duration.Duration, never>,
    refreshImmediately: boolean,
  ) {
    const repository = yield* workflow.resolveRemoteStatusRepository(cwd);
    const repositoryKey = repository?.gitCommonDir ?? cwd;
    yield* Ref.update(repositoryKeyByCwdRef, (byCwd) => new Map(byCwd).set(cwd, repositoryKey));
    const started = yield* SynchronizedRef.modifyEffect(pollersRef, (activePollers) => {
      const existing = activePollers.get(repositoryKey);
      if (existing) {
        const subscriber = existing.subscribers.get(cwd);
        const subscribers = new Map(existing.subscribers);
        subscribers.set(cwd, {
          count: (subscriber?.count ?? 0) + 1,
          interval: subscriber?.interval ?? automaticRemoteRefreshInterval,
        });
        const initialPending = new Set(existing.initialPending);
        if (refreshImmediately) initialPending.add(cwd);
        const nextPollers = new Map(activePollers);
        nextPollers.set(repositoryKey, { ...existing, subscribers, initialPending });
        const registration: PollerRegistration = {
          wakeNow: refreshImmediately && existing.initialPending.size === 0 ? existing.wake : null,
          registered: null,
        };
        return Effect.succeed([registration, nextPollers] as const);
      }

      return Effect.gen(function* () {
        const wake = yield* Queue.dropping<void>(1);
        const registered = yield* Deferred.make<void>();
        const fiber = yield* makeRemoteRefreshLoop(repositoryKey, wake, registered).pipe(
          Effect.forkIn(broadcasterScope),
        );
        const nextPollers = new Map(activePollers);
        nextPollers.set(repositoryKey, {
          fiber,
          wake,
          repository,
          subscribers: new Map([[cwd, { count: 1, interval: automaticRemoteRefreshInterval }]]),
          initialPending: refreshImmediately ? new Set([cwd]) : new Set(),
        });
        const registration: PollerRegistration = { wakeNow: null, registered };
        return [registration, nextPollers] as const;
      });
    });
    if (started.registered) yield* Deferred.succeed(started.registered, undefined);
    if (started.wakeNow) yield* Queue.offer(started.wakeNow, undefined);
  });

  const releaseRemotePoller = Effect.fn("VcsStatusBroadcaster.releaseRemotePoller")(function* (
    cwd: string,
    demandCwd: string,
  ) {
    const repositoryKey = (yield* Ref.get(repositoryKeyByCwdRef)).get(cwd) ?? cwd;
    const pollerToInterrupt = yield* SynchronizedRef.modify(pollersRef, (activePollers) => {
      const existing = activePollers.get(repositoryKey);
      const subscriber = existing?.subscribers.get(cwd);
      if (!existing || !subscriber) return [null, activePollers] as const;
      if (subscriber.count > 1) {
        const subscribers = new Map(existing.subscribers);
        subscribers.set(cwd, { ...subscriber, count: subscriber.count - 1 });
        const nextPollers = new Map(activePollers);
        nextPollers.set(repositoryKey, { ...existing, subscribers });
        return [null, nextPollers] as const;
      }
      const subscribers = new Map(existing.subscribers);
      subscribers.delete(cwd);
      const initialPending = new Set(existing.initialPending);
      initialPending.delete(cwd);
      const nextPollers = new Map(activePollers);
      if (subscribers.size > 0) {
        nextPollers.set(repositoryKey, { ...existing, subscribers, initialPending });
        return [null, nextPollers] as const;
      }
      nextPollers.delete(repositoryKey);
      return [{ fiber: existing.fiber, wake: existing.wake }, nextPollers] as const;
    });

    const stillSubscribed = (yield* SynchronizedRef.get(pollersRef))
      .get(repositoryKey)
      ?.subscribers.has(cwd);
    if (!stillSubscribed) {
      yield* Ref.update(repositoryKeyByCwdRef, (byCwd) => {
        const next = new Map(byCwd);
        next.delete(cwd);
        return next;
      });
    }
    if (pollerToInterrupt) {
      yield* Fiber.interrupt(pollerToInterrupt.fiber).pipe(Effect.ignore);
      yield* Queue.shutdown(pollerToInterrupt.wake).pipe(Effect.ignore);
    }
  });

  const streamStatus: VcsStatusBroadcaster["Service"]["streamStatus"] = (input, options) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const cwd = yield* withFileSystem(normalizeCwd(input.cwd));
        const subscription = yield* PubSub.subscribe(changesPubSub);
        const initialLocal = yield* getOrLoadLocalStatus(cwd);
        const cachedStatus = yield* getCachedStatus(cwd);
        const initialRemote = cachedStatus?.remote?.value ?? null;
        yield* retainRemotePoller(
          cwd,
          input.cwd,
          options?.automaticRemoteRefreshInterval ??
            Effect.succeed(DEFAULT_VCS_STATUS_REFRESH_INTERVAL),
          cachedStatus?.remote === null || cachedStatus?.remote === undefined,
        );

        const release = releaseRemotePoller(cwd, input.cwd).pipe(Effect.ignore, Effect.asVoid);

        return Stream.concat(
          Stream.make({
            _tag: "snapshot" as const,
            local: initialLocal,
            remote: initialRemote,
          }),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((event) => event.cwd === cwd),
            Stream.map((event) => event.event),
          ),
        ).pipe(Stream.ensuring(release));
      }),
    );

  return VcsStatusBroadcaster.of({
    getStatus,
    refreshLocalStatus,
    refreshStatus,
    streamStatus,
  });
});

export const layer = Layer.effect(VcsStatusBroadcaster, make);
