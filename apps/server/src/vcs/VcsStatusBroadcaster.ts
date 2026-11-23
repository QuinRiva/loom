// @effect-diagnostics-next-line nodeBuiltinImport:off -- A synchronous digest of the ref snapshot already in memory.
import * as NodeCrypto from "node:crypto";

import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type {
  GitManagerServiceError,
  VcsStatusInput,
  VcsBranchStatus,
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsRefreshStatusResult,
  VcsStatusResult,
  VcsStatusStreamEvent,
  VcsStatusSubscriptionInput,
} from "@t3tools/contracts";
import { DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL } from "@t3tools/contracts";
import { mergeGitStatusParts } from "@t3tools/shared/git";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { refuseForeignHomeSideEffect } from "../workspace/foreignHomeGuard.loom.ts"; // loom: foreign-home guard (DL-191)
import type * as GitVcsDriver from "./GitVcsDriver.ts";
import { VcsAutomaticFetchInterval } from "./VcsAutomaticFetchInterval.ts";

// Spread the steady-state poll cadence so pollers for different worktrees whose
// timers align (e.g. after a reconnect opens many sessions at once) don't fire a
// synchronised burst of git subprocesses. Applied to the success delay only;
// failure backoff (remoteRefreshFailureDelay) stays deterministic.
const STATUS_REFRESH_JITTER_FRACTION = 0.2;
const VCS_STATUS_REFRESH_FAILURE_BASE_DELAY = Duration.seconds(30);
const VCS_STATUS_REFRESH_FAILURE_MAX_DELAY = Duration.minutes(15);
const VCS_STATUS_CACHE_CAPACITY = 256;
const MAX_FAILURE_DIAGNOSTIC_VALUES = 8;
// A held index.lock fails the read, and its removal moves no HEAD to trigger another.
const CHECKOUT_REFRESH_RETRY = Schedule.exponential(Duration.seconds(1)).pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(30))),
  ),
);
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

function remoteRefreshFailureDiagnostics(cause: Cause.Cause<unknown>) {
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

interface CachedRemoteStatus extends CachedValue<VcsStatusRemoteResult | null> {
  readonly branch: string | null;
}

interface CachedLocalStatus extends CachedValue<VcsStatusLocalResult> {
  readonly includesBranchChanges: boolean;
}

interface CachedVcsStatus {
  readonly local: CachedLocalStatus | null;
  readonly remote: CachedRemoteStatus | null;
}

interface RemoteStatusSubscriber {
  readonly count: number;
  readonly interval: Effect.Effect<Duration.Duration, never>;
}

interface ActiveHeadWatcher {
  readonly fiber: Fiber.Fiber<void, never>;
  readonly ready: Deferred.Deferred<void>;
  readonly subscriberCount: number;
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

export class VcsAutoPullPolicy extends Context.Reference<{
  readonly isEnabled: (cwd: string) => Effect.Effect<boolean, never>;
}>("t3/vcs/VcsAutoPullPolicy", {
  defaultValue: () => ({ isEnabled: () => Effect.succeed(false) }),
}) {}

export const layerAutoPullPolicy = Layer.effect(
  VcsAutoPullPolicy,
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    return {
      isEnabled: Effect.fn("VcsAutoPullPolicy.isEnabled")(
        function* (cwd: string) {
          const project = yield* projects.findActiveByWorkspaceRoot(cwd);
          if (project._tag === "None") return false;
          const settings = yield* serverSettings.getSettings;
          return resolveProjectSettings(settings, project.value.projectId).settings.defaultAutoPull;
        },
        Effect.orElseSucceed(() => false),
      ),
    };
  }),
);

const withRefreshJitter = (interval: Duration.Duration): Effect.Effect<Duration.Duration> =>
  Random.next.pipe(
    Effect.map((factor) =>
      Duration.millis(
        Math.round(Duration.toMillis(interval) * (1 + factor * STATUS_REFRESH_JITTER_FRACTION)),
      ),
    ),
  );

function remoteRefreshFailureDelay(
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
    readonly streamBranchStatus: (
      input: VcsStatusInput,
    ) => Stream.Stream<VcsBranchStatus, GitManagerServiceError>;
    readonly refreshBranchStatus: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsBranchStatus, GitManagerServiceError>;
    readonly streamBranchChanges: Stream.Stream<{
      readonly cwd: string;
      readonly refName: string | null;
    }>;
    readonly getStatus: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
    readonly refreshLocalStatus: (
      cwd: string,
    ) => Effect.Effect<VcsStatusLocalResult, GitManagerServiceError>;
    /**
     * For a checkout someone is waiting on. Returns once the new branch is published, so the
     * caller's reply does not outrun it, and finishes the slower remote read in the background.
     */
    readonly refreshAfterCheckout: (cwd: string) => Effect.Effect<void>;
    readonly refreshStatus: (
      cwd: string,
      options?: { readonly localOnly?: boolean },
    ) => Effect.Effect<VcsRefreshStatusResult, GitManagerServiceError>;
    readonly refreshPullRequestStatus: (
      cwd: string,
    ) => Effect.Effect<VcsStatusRemoteResult | null, GitManagerServiceError>;
    readonly streamStatus: (
      input: VcsStatusSubscriptionInput,
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

/** @public */
export const make = Effect.gen(function* () {
  const automaticFetchInterval = yield* VcsAutomaticFetchInterval;
  const autoPullPolicy = yield* VcsAutoPullPolicy;
  const workflow = yield* GitWorkflowService.GitWorkflowService;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const changesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<VcsStatusChange>(),
    (pubsub) => PubSub.shutdown(pubsub),
  );
  const branchChangesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<{
      readonly cwd: string;
      readonly refName: string | null;
      readonly isRepo: boolean;
      readonly revision: number;
    }>(),
    (pubsub) => PubSub.shutdown(pubsub),
  );
  const broadcasterScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const detailedSubscribers = new Map<string, number>();
  const branches = new Map<
    string,
    {
      readonly refName: string | null;
      readonly isRepo: boolean;
      readonly revision: number;
      readonly observation: number;
    }
  >();
  let branchRevision = 0;
  // A slow detailed read must not replace a newer HEAD-only observation.
  let branchObservation = 0;
  const publishBranch = Effect.fn("VcsStatusBroadcaster.publishBranch")(function* (
    cwd: string,
    { refName, isRepo }: { readonly refName: string | null; readonly isRepo: boolean },
    observation: number,
  ) {
    const previous = branches.get(cwd);
    if (previous && previous.observation > observation) return;
    if (previous?.refName === refName && previous.isRepo === isRepo) {
      branches.set(cwd, { ...previous, observation });
      return;
    }
    const revision = ++branchRevision;
    branches.set(cwd, { refName, isRepo, revision, observation });
    yield* PubSub.publish(branchChangesPubSub, { cwd, refName, isRepo, revision });
  });
  const localRefreshLocks = yield* KeyedLock.make<string>();
  const cacheRef = yield* Ref.make(new Map<string, CachedVcsStatus>());
  // One permit per cwd for remote reads that write the cache. Without it a
  // periodic poll that started before an agent creates a PR can finish after the
  // turn-end refresh and overwrite the fresh PR with its stale `pr: null`.
  const remoteWriteLocks = yield* KeyedLock.make<string>();
  const activeRemoteReads = new Map<string, number>();
  const withRemoteWriteLock = <A, E, R>(cwd: string, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => activeRemoteReads.set(cwd, (activeRemoteReads.get(cwd) ?? 0) + 1)),
      () => remoteWriteLocks.withLock(cwd, effect),
      () =>
        Effect.sync(() => {
          const remaining = (activeRemoteReads.get(cwd) ?? 1) - 1;
          if (remaining === 0) activeRemoteReads.delete(cwd);
          else activeRemoteReads.set(cwd, remaining);
        }).pipe(Effect.andThen(trimCachedStatuses)),
    );
  const pollersRef = yield* SynchronizedRef.make(new Map<string, ActiveRemotePoller>());
  const headWatchersRef = yield* SynchronizedRef.make(new Map<string, ActiveHeadWatcher>());
  // A refresh that started after a request saw every change that request could mean, so queued
  // callers share it instead of each running git status again.
  const localRefreshRequests = new Map<string, number>();
  // Upstream details the turn-end refreshLocalStatus just read, handed once to the PR lookup that
  // follows it so the same no-fetch read is not repeated. Any remote write in between drops them.
  const upstreamReads = new Map<string, GitVcsDriver.GitRemoteStatusDetails>();
  const localRefreshResults = new Map<
    string,
    {
      readonly startedAt: number;
      readonly local: VcsStatusLocalResult;
      readonly includesBranchChanges: boolean;
    }
  >();

  // Keep watched snapshots and remote operations coherent until their consumers finish.
  const evictExcessStatuses = (cache: Map<string, CachedVcsStatus>, retainedCwd?: string) => {
    for (const candidate of cache.keys()) {
      if (cache.size <= VCS_STATUS_CACHE_CAPACITY) break;
      if (
        candidate === retainedCwd ||
        detailedSubscribers.has(candidate) ||
        activeRemoteReads.has(candidate)
      )
        continue;
      cache.delete(candidate);
      // A queued caller can read git again. Keep the monotonic request counter so it cannot
      // mistake an older result for a later request.
      localRefreshResults.delete(candidate);
      upstreamReads.delete(candidate);
    }
    return cache;
  };
  const trimCachedStatuses = Ref.update(cacheRef, (cache) => evictExcessStatuses(new Map(cache)));
  const retainCachedStatus = (
    cache: ReadonlyMap<string, CachedVcsStatus>,
    cwd: string,
    status: CachedVcsStatus,
  ) => {
    const next = new Map(cache);
    next.delete(cwd);
    next.set(cwd, status);
    return evictExcessStatuses(next, cwd);
  };
  // loom: the per-repository poller batch writes several cwds at once, so it takes
  // every one of their locks, in sorted order so two batches cannot deadlock. A
  // caller already holding a cwd's lock (refreshStatus) runs the batch directly:
  // the lock is not re-entrant, and single-key holders never wait on a second key.
  const withRemoteWriteLocks = <A, E, R>(
    cwds: ReadonlyArray<string>,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    [...new Set(cwds)]
      .toSorted()
      .reduceRight((inner, cwd) => withRemoteWriteLock(cwd, inner), effect);
  const repositoryKeyByCwdRef = yield* Ref.make(new Map<string, string>());

  const getCachedStatus = Effect.fn("VcsStatusBroadcaster.getCachedStatus")(function* (
    cwd: string,
  ) {
    return yield* Ref.modify(cacheRef, (cache) => {
      const cached = cache.get(cwd) ?? null;
      return [cached, cached ? retainCachedStatus(cache, cwd, cached) : cache] as const;
    });
  });

  // Only full subscribers and direct reads show Changes totals. Command palette rows subscribe
  // without remote status and skip them, which halves the git processes a burst of rows spawns.
  const branchChangesDemand = new Map<string, number>();
  const wantsBranchChanges = (cwd: string) => branchChangesDemand.has(cwd);
  const acquireBranchChangesDemand = (cwd: string) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        branchChangesDemand.set(cwd, (branchChangesDemand.get(cwd) ?? 0) + 1);
      }),
      () =>
        Effect.sync(() => {
          const count = (branchChangesDemand.get(cwd) ?? 1) - 1;
          if (count > 0) branchChangesDemand.set(cwd, count);
          else branchChangesDemand.delete(cwd);
        }),
    );

  const readLocalStatus = Effect.fn("VcsStatusBroadcaster.readLocalStatus")(function* (
    cwd: string,
  ) {
    const includeBranchChanges = wantsBranchChanges(cwd);
    const local = yield* workflow.localStatus({ cwd }, { includeBranchChanges });
    // A subscriber that shows totals arrived during the read and must not receive it without them.
    if (!includeBranchChanges && wantsBranchChanges(cwd)) {
      return {
        local: yield* workflow.localStatus({ cwd }, { includeBranchChanges: true }),
        includesBranchChanges: true,
      };
    }
    return { local, includesBranchChanges: includeBranchChanges };
  });

  const updateCachedLocalStatus = Effect.fn("VcsStatusBroadcaster.updateCachedLocalStatus")(
    function* (
      cwd: string,
      read: { readonly local: VcsStatusLocalResult; readonly includesBranchChanges: boolean },
      observation: number,
      options?: { publish?: boolean },
    ) {
      const { local, includesBranchChanges } = read;
      const nextLocal = {
        fingerprint: fingerprintStatusPart(local),
        value: local,
        includesBranchChanges,
      };
      const [localChanged, remoteCleared] = yield* Ref.modify(cacheRef, (cache) => {
        const previous = cache.get(cwd) ?? { local: null, remote: null };
        const remote = previous.remote?.branch === local.refName ? previous.remote : null;
        return [
          [previous.local?.fingerprint !== nextLocal.fingerprint, previous.remote !== remote],
          retainCachedStatus(cache, cwd, { local: nextLocal, remote }),
        ] as const;
      });
      yield* publishBranch(cwd, local, observation);
      if (options?.publish && remoteCleared) {
        yield* PubSub.publish(changesPubSub, {
          cwd,
          event: { _tag: "remoteUpdated", remote: null },
        });
      }
      if (options?.publish && localChanged) {
        yield* PubSub.publish(changesPubSub, {
          cwd,
          event: { _tag: "localUpdated", local },
        });
      }
      return local;
    },
  );

  const updateCachedRemoteStatus = Effect.fn("VcsStatusBroadcaster.updateCachedRemoteStatus")(
    function* (cwd: string, remote: CachedRemoteStatus | null, options?: { publish?: boolean }) {
      upstreamReads.delete(cwd);
      const [changed, value] = yield* Ref.modify(cacheRef, (cache) => {
        const previous = cache.get(cwd) ?? { local: null, remote: null };
        const next = remote?.branch === previous.local?.value.refName ? remote : null;
        return [
          [previous.remote?.fingerprint !== next?.fingerprint, next?.value ?? null],
          retainCachedStatus(cache, cwd, { ...previous, remote: next }),
        ] as const;
      });
      if (options?.publish && changed) {
        yield* PubSub.publish(changesPubSub, {
          cwd,
          event: { _tag: "remoteUpdated", remote: value },
        });
      }
      return value;
    },
  );

  const loadLocalStatus = Effect.fn("VcsStatusBroadcaster.loadLocalStatus")(function* (
    cwd: string,
    options?: { publish?: boolean },
  ) {
    const observation = ++branchObservation;
    return yield* updateCachedLocalStatus(cwd, yield* readLocalStatus(cwd), observation, options);
  });

  const getOrLoadLocalStatusUnlocked = Effect.fn("VcsStatusBroadcaster.getOrLoadLocalStatus")(
    function* (cwd: string) {
      const cached = yield* getCachedStatus(cwd);
      if (cached?.local) {
        if (cached.local.includesBranchChanges || !wantsBranchChanges(cwd)) {
          const branch = yield* workflow.currentBranch(cwd);
          if (branch === cached.local.value.refName) return cached.local.value;
        }
        yield* workflow.invalidateLocalStatus(cwd);
        return yield* loadLocalStatus(cwd, { publish: true });
      }
      return yield* loadLocalStatus(cwd);
    },
  );

  const getOrLoadLocalStatus = (cwd: string) =>
    localRefreshLocks.withLock(cwd, getOrLoadLocalStatusUnlocked(cwd));

  const getStatusParts = Effect.fn("VcsStatusBroadcaster.getStatusParts")(function* (cwd: string) {
    const cached = yield* getCachedStatus(cwd);
    if (cached?.local) {
      return { local: cached.local.value, remote: cached.remote?.value ?? null };
    }
    return { local: yield* getOrLoadLocalStatus(cwd), remote: null };
  });

  const withFileSystem = Effect.provideService(FileSystem.FileSystem, fs);

  const getStatus: VcsStatusBroadcaster["Service"]["getStatus"] = Effect.fn(
    "VcsStatusBroadcaster.getStatus",
  )(function* (input) {
    const cwd = yield* withFileSystem(normalizeCwd(input.cwd));
    yield* acquireBranchChangesDemand(cwd);
    yield* getOrLoadLocalStatus(cwd);
    const cached = yield* getCachedStatus(cwd);
    if (cached?.local && cached.remote) {
      return mergeGitStatusParts(cached.local.value, cached.remote.value);
    }
    return yield* withRemoteWriteLock(
      cwd,
      Effect.gen(function* () {
        const latest = yield* getCachedStatus(cwd);
        const refreshUpstream = !Duration.isZero(yield* automaticFetchInterval);
        const remote = latest?.remote ?? (yield* readRemoteStatus(cwd, { refreshUpstream }));
        yield* updateCachedRemoteStatus(cwd, remote);
        const parts = yield* getStatusParts(cwd);
        return mergeGitStatusParts(parts.local, parts.remote);
      }),
    );
  }, Effect.scoped);

  const refreshLocalStatusCore = Effect.fn("VcsStatusBroadcaster.refreshLocalStatusCore")(
    function* (cwd: string) {
      const requestedAt = (localRefreshRequests.get(cwd) ?? 0) + 1;
      localRefreshRequests.set(cwd, requestedAt);
      return yield* localRefreshLocks.withLock(
        cwd,
        Effect.gen(function* () {
          const shared = localRefreshResults.get(cwd);
          if (
            shared !== undefined &&
            shared.startedAt >= requestedAt &&
            (shared.includesBranchChanges || !wantsBranchChanges(cwd))
          ) {
            return shared.local;
          }
          const startedAt = localRefreshRequests.get(cwd) ?? requestedAt;
          yield* workflow.invalidateLocalStatus(cwd);
          const observation = ++branchObservation;
          const read = yield* readLocalStatus(cwd);
          localRefreshResults.set(cwd, { startedAt, ...read });
          return yield* updateCachedLocalStatus(cwd, read, observation, { publish: true });
        }),
      );
    },
  );

  const refreshLocalStatus: VcsStatusBroadcaster["Service"]["refreshLocalStatus"] = Effect.fn(
    "VcsStatusBroadcaster.refreshLocalStatus",
  )(function* (rawCwd) {
    const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
    upstreamReads.delete(cwd);
    const previousRefName = (yield* getCachedStatus(cwd))?.local?.value.refName ?? null; // loom:
    const local = yield* refreshLocalStatusCore(cwd);
    // loom: only a genuine branch change makes the repository batch's cached remote row wrong
    // (it keys off the local refName), so only that wakes the poller (DL-1614).
    if (local.refName !== previousRefName) {
      const repositoryKey = (yield* Ref.get(repositoryKeyByCwdRef)).get(cwd);
      const poller = repositoryKey
        ? (yield* SynchronizedRef.get(pollersRef)).get(repositoryKey)
        : undefined;
      if (poller) yield* Queue.offer(poller.wake, undefined);
    }
    const cached = yield* getCachedStatus(cwd);
    // Divergence is local Git data; a slow forge lookup must not delay turn-end updates.
    if (cached?.remote?.value?.hasUpstream) {
      const divergence = yield* workflow.upstreamDivergence(cwd);
      const latest = yield* getCachedStatus(cwd);
      if (divergence && latest?.remote?.value && latest.remote.branch === divergence.refName) {
        const value = {
          ...latest.remote.value,
          aheadCount: divergence.aheadCount,
          behindCount: divergence.behindCount,
        };
        yield* updateCachedRemoteStatus(
          cwd,
          {
            branch: divergence.refName,
            value,
            fingerprint: fingerprintStatusPart(value),
          },
          { publish: true },
        );
        upstreamReads.set(cwd, divergence.details);
      }
    }
    return local;
  });

  const readRemoteStatus = Effect.fn("VcsStatusBroadcaster.readRemoteStatus")(function* (
    cwd: string,
    options?: Parameters<GitWorkflowService.GitWorkflowService["Service"]["remoteStatus"]>[1],
  ) {
    const branch = yield* workflow.currentBranch(cwd);
    // GitManager's remote TTL cache is keyed by cwd, not the checked-out branch.
    yield* workflow.invalidateRemoteStatus(cwd);
    const previousRemote = (yield* getCachedStatus(cwd))?.remote;
    const { statusDetails, ...remoteOptions } = options ?? {};
    const remote = yield* workflow.remoteStatus(
      { cwd },
      statusDetails?.branch === branch ? { ...remoteOptions, statusDetails } : remoteOptions,
    );
    const latest = yield* getCachedStatus(cwd);
    // An overlapping turn refresh and fetch can both move divergence during the forge lookup.
    const refreshed =
      remote?.hasUpstream && latest?.remote !== previousRemote && latest?.remote?.branch === branch
        ? yield* workflow.upstreamDivergence(cwd)
        : null;
    const value =
      remote && refreshed?.refName === branch
        ? { ...remote, aheadCount: refreshed.aheadCount, behindCount: refreshed.behindCount }
        : remote;
    const currentBranch = yield* workflow.currentBranch(cwd);
    const cached = yield* getCachedStatus(cwd);
    if (branch !== currentBranch || cached?.local?.value.refName !== currentBranch) {
      yield* refreshLocalStatusCore(cwd);
    }
    return branch === currentBranch
      ? { branch, value, fingerprint: fingerprintStatusPart(value) }
      : null;
  });

  const maybeAutoPull = Effect.fn("VcsStatusBroadcaster.maybeAutoPull")(function* (
    cwd: string,
    remoteRead: CachedRemoteStatus | null,
    policyCwds: ReadonlyArray<string>,
  ) {
    const remote = remoteRead?.value ?? null;
    let pullAttempted = false;
    return yield* Effect.gen(function* () {
      const autoPullEnabled = (yield* Effect.forEach(policyCwds, autoPullPolicy.isEnabled, {
        concurrency: "unbounded",
      })).some(Boolean);
      if (
        remote === null ||
        !remote.hasUpstream ||
        remote.aheadCount > 0 ||
        remote.behindCount <= 0 ||
        !autoPullEnabled
      ) {
        return null;
      }
      // loom: a status-poll pull rewrites a checkout this home may not own when
      // the server booted on another home's database copy (DL-188/DL-191).
      if (yield* refuseForeignHomeSideEffect("VcsStatusBroadcaster.maybeAutoPull", cwd)) {
        return null;
      }

      yield* workflow.invalidateLocalStatus(cwd);
      const local = yield* workflow.localStatus({ cwd });
      if (
        !local.isRepo ||
        !local.isDefaultRef ||
        local.hasWorkingTreeChanges ||
        local.refName !== remoteRead?.branch
      )
        return null;

      pullAttempted = true;
      yield* workflow.pullCurrentBranch(cwd);
      yield* workflow.invalidateStatus(cwd);
      yield* refreshLocalStatusCore(cwd);
      const refreshedRemote = yield* readRemoteStatus(cwd, { refreshUpstream: false });
      yield* updateCachedRemoteStatus(cwd, refreshedRemote, { publish: true });
      return yield* getStatusParts(cwd);
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("Automatic project pull failed", {
            cwdLength: cwd.length,
            errorTag: error._tag,
          });
          if (!pullAttempted) return null;
          // A pull or its follow-up reads can fail after local state has changed.
          // Let a failed reconciliation reach the caller instead of publishing old status.
          yield* refreshLocalStatusCore(cwd);
          yield* updateCachedRemoteStatus(cwd, remoteRead, { publish: true });
          return yield* getStatusParts(cwd);
        }),
      ),
    );
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
    options?: {
      readonly refreshUpstream?: boolean;
      readonly policyCwds?: ReadonlyArray<string>;
    },
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
        // loom: the repo batch applies upstream's auto-pull and local re-read
        // re-read per entry; its callers hold every entry's remote write lock
        // (withRemoteWriteLocks in the poller, the single cwd's in refreshStatus).
        Effect.gen(function* () {
          const remote = remotes[index] ?? null;
          // loom: the batch read the entry's cached branch; the cache drops it if the branch moved
          const remoteRead = {
            branch: entry.branch,
            value: remote,
            fingerprint: fingerprintStatusPart(remote),
          };
          // loom: upstream auto-pulls inside its per-cwd remote refresh; the repo
          // batch does it per entry, defaulting the policy scope to this
          // repository's subscribers (upstream's demandCwds).
          // loom: upstream skips the pull without a fetch (a cached behind count cannot justify it).
          const pulled =
            options?.refreshUpstream === false
              ? null
              : yield* maybeAutoPull(
                  entry.cwd,
                  remoteRead,
                  options?.policyCwds ?? [...poller.subscribers.keys()],
                );
          if (pulled !== null) return;
          // Base refs and merge bases can move without changing divergence counts.
          yield* refreshLocalStatusCore(entry.cwd);
          yield* updateCachedRemoteStatus(entry.cwd, remoteRead, { publish: true });
        }),
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

  const makeRemoteRefreshLoop = Effect.fn("VcsStatusBroadcaster.makeRemoteRefreshLoop")(function* (
    repositoryKey: string,
    wake: Queue.Queue<void>,
    registered: Deferred.Deferred<void>,
  ) {
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
        nonZeroIntervals[0] ?? DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL, // loom: per-repository poller
      );
      return { poller, enabled, activeInterval };
    });

    const initial = yield* readCycle;
    if (!initial) return;
    if (initial.poller.initialPending.size === 0) {
      yield* Queue.take(wake).pipe(
        Effect.timeoutOrElse({ duration: initial.activeInterval, orElse: () => Effect.void }),
      );
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
        (yield* Effect.forEach(
          cwds,
          (demandCwd) =>
            backgroundPolicy.shouldRunScopeWork({ type: "vcs-status", cwd: demandCwd }),
          { concurrency: "unbounded" },
        )).some(Boolean);
      if (cwds.length > 0 && policyAllows) {
        const exit = yield* withRemoteWriteLocks(
          cwds, // loom: upstream's stale-poll race fix, on the batch path (DL-99)
          refreshRepositoryRemoteStatus(repositoryKey, cwds, {
            refreshUpstream: cycle.enabled.some(({ interval }) => !Duration.isZero(interval)),
          }),
        ).pipe(Effect.exit);
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
      yield* Queue.take(wake).pipe(
        Effect.timeoutOrElse({ duration: nextDelay, orElse: () => Effect.void }),
      );
    }
  });

  const refreshRemoteStatus = Effect.fn("VcsStatusBroadcaster.refreshRemoteStatus")(function* (
    cwd: string,
    options?: {
      readonly refreshUpstream?: boolean;
      readonly policyCwds?: ReadonlyArray<string>;
      /** Refs seen by this caller's last local read; skips the re-read while they hold. */
      readonly refsAtLocalRead?: Ref.Ref<string | null>;
    },
  ) {
    return yield* withRemoteWriteLock(
      cwd,
      Effect.gen(function* () {
        const remoteRead = yield* readRemoteStatus(cwd, options);
        const pulled =
          options?.refreshUpstream === false
            ? null
            : yield* maybeAutoPull(cwd, remoteRead, options?.policyCwds ?? [cwd]);
        if (pulled !== null) return pulled.remote;
        // Base refs and merge bases can move without changing divergence counts.
        const refsAtLocalRead = options?.refsAtLocalRead;
        if (refsAtLocalRead === undefined) {
          yield* refreshLocalStatusCore(cwd);
        } else {
          const refs = yield* workflow.readLocalStatusRefSnapshot(cwd);
          if (refs === null || refs !== (yield* Ref.get(refsAtLocalRead))) {
            yield* Ref.set(refsAtLocalRead, null);
            yield* refreshLocalStatusCore(cwd);
            yield* Ref.set(refsAtLocalRead, refs);
          }
        }
        return yield* updateCachedRemoteStatus(cwd, remoteRead, { publish: true });
      }),
    );
  });

  const refreshRemoteAndLocalTotals = Effect.fn("VcsStatusBroadcaster.refreshRemoteAndLocalTotals")(
    function* (cwd: string, policyCwd: string, refsBeforeLocalRead: string | null) {
      return yield* withRemoteWriteLock(
        cwd,
        Effect.gen(function* () {
          const refreshUpstream = !Duration.isZero(yield* automaticFetchInterval);
          // Bump the PR lookup epoch after earlier remote writers have finished.
          yield* workflow.invalidateStatus(cwd);
          // loom: a cwd with a repository poller reads through its batch (DL-1614). The batch
          // auto-pulls and re-reads local per entry; the caller's local read set the branch it keys off.
          const repositoryKey = (yield* Ref.get(repositoryKeyByCwdRef)).get(cwd);
          if (repositoryKey) {
            yield* refreshRepositoryRemoteStatus(repositoryKey, [cwd], {
              refreshUpstream,
              policyCwds: [policyCwd],
            });
            const parts = yield* getStatusParts(cwd);
            return {
              status: mergeGitStatusParts(parts.local, parts.remote),
              refs:
                refsBeforeLocalRead === null
                  ? null
                  : yield* workflow.readLocalStatusRefSnapshot(cwd),
            };
          }
          const remoteRead = yield* readRemoteStatus(cwd, { refreshUpstream });
          // Without a fetch, the cached behind count cannot justify an automatic pull.
          const pulled = refreshUpstream
            ? yield* maybeAutoPull(cwd, remoteRead, [policyCwd])
            : null;
          if (pulled !== null) {
            return { status: mergeGitStatusParts(pulled.local, pulled.remote), refs: null };
          }
          yield* updateCachedRemoteStatus(cwd, remoteRead, { publish: true });
          // A fetch, ours or not, can move the base used for local Changes totals.
          const refs =
            refsBeforeLocalRead === null ? null : yield* workflow.readLocalStatusRefSnapshot(cwd);
          if (refs === null || refs !== refsBeforeLocalRead) {
            yield* refreshLocalStatusCore(cwd);
          }
          const parts = yield* getStatusParts(cwd);
          return { status: mergeGitStatusParts(parts.local, parts.remote), refs };
        }),
      );
    },
  );

  const refreshStatus: VcsStatusBroadcaster["Service"]["refreshStatus"] = Effect.fn(
    "VcsStatusBroadcaster.refreshStatus",
  )(function* (rawCwd, options) {
    const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
    yield* acquireBranchChangesDemand(cwd);
    // Lets the client keep its cached branch list when refs and worktree paths match its last refresh.
    const withRefsDigest = (status: VcsStatusResult, refs: string | null) =>
      refs === null
        ? status
        : {
            ...status,
            refsDigest: NodeCrypto.createHash("sha256").update(refs).digest("hex").slice(0, 32),
          };
    if (options?.localOnly) {
      const [refs] = yield* Effect.all(
        [workflow.readRefSnapshot(cwd), refreshLocalStatusCore(cwd)],
        { concurrency: "unbounded" },
      );
      // Never cache a remote here: readers take `value: null` as "read and found no PR".
      const parts = yield* getStatusParts(cwd);
      return withRefsDigest(mergeGitStatusParts(parts.local, parts.remote), refs);
    }
    const refsBeforeLocalRead = yield* workflow.readLocalStatusRefSnapshot(cwd);
    yield* refreshLocalStatusCore(cwd);
    const { status, refs } = yield* refreshRemoteAndLocalTotals(cwd, rawCwd, refsBeforeLocalRead);
    return withRefsDigest(
      status,
      refs === null ? null : yield* workflow.readRefSnapshot(cwd, refs),
    );
  }, Effect.scoped);

  const refreshAfterCheckout: VcsStatusBroadcaster["Service"]["refreshAfterCheckout"] = Effect.fn(
    "VcsStatusBroadcaster.refreshAfterCheckout",
  )(function* (rawCwd) {
    const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
    const localDone = yield* Deferred.make<void>();
    // Owned by the broadcaster so a client disconnecting mid-switch still leaves status correct.
    yield* refreshLocalStatusCore(cwd).pipe(
      Effect.ensuring(Deferred.succeed(localDone, undefined)),
      Effect.andThen(refreshRemoteAndLocalTotals(cwd, rawCwd, null)),
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(broadcasterScope),
    );
    yield* Deferred.await(localDone);
  });

  // loom: upstream keys pollers by cwd and reads `poller.demandCwds`; loom keys
  // them by repositoryKey with a `subscribers` map, so the background-policy
  // gate consults this repo's subscribed cwds instead.
  const refreshPullRequestStatus: VcsStatusBroadcaster["Service"]["refreshPullRequestStatus"] =
    Effect.fn("VcsStatusBroadcaster.refreshPullRequestStatus")(function* (rawCwd) {
      const cwd = yield* withFileSystem(normalizeCwd(rawCwd));
      return yield* withRemoteWriteLock(
        cwd,
        Effect.gen(function* () {
          const cached = yield* getCachedStatus(cwd);
          if (!cached || cached.remote?.value === null) return null;
          // Turn completion must update divergence even when background polling is paused.
          const statusDetails = upstreamReads.get(cwd);
          upstreamReads.delete(cwd);
          const remoteRead = yield* readRemoteStatus(cwd, {
            refreshUpstream: false,
            refreshMissingPullRequest: true,
            ...(statusDetails ? { statusDetails } : {}),
          });
          return yield* updateCachedRemoteStatus(cwd, remoteRead, { publish: true });
        }),
      );
    });

  const retainRemotePoller = Effect.fn("VcsStatusBroadcaster.retainRemotePoller")(function* (
    cwd: string,
    demandCwd: string,
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
          interval: subscriber?.interval ?? automaticFetchInterval,
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
          subscribers: new Map([[cwd, { count: 1, interval: automaticFetchInterval }]]),
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
    _demandCwd: string, // loom: the repository poller gates on its subscribed cwds (DL-1614)
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

  // A request made during a refresh needs a read that starts after it, so overlapping requests
  // share one follow-up. Keyed by raw cwd because auto-pull policy depends on it.
  // Missing means idle; null means running with no follow-up queued.
  type SharedRefresh = Deferred.Deferred<VcsRefreshStatusResult, GitManagerServiceError>;
  const queuedRefreshesRef = yield* Ref.make(new Map<string, SharedRefresh | null>());

  const runQueuedRefreshes = Effect.fn("VcsStatusBroadcaster.runQueuedRefreshes")(function* (
    rawCwd: string,
    first: SharedRefresh,
  ) {
    let next: SharedRefresh | null = first;
    while (next !== null) {
      yield* Deferred.into(refreshStatus(rawCwd), next);
      next = yield* Ref.modify(queuedRefreshesRef, (queued) => {
        const followUp = queued.get(rawCwd) ?? null;
        const nextQueued = new Map(queued);
        if (followUp === null) {
          nextQueued.delete(rawCwd);
        } else {
          nextQueued.set(rawCwd, null);
        }
        return [followUp, nextQueued] as const;
      });
    }
  });

  const shareQueuedRefreshStatus: VcsStatusBroadcaster["Service"]["refreshStatus"] = Effect.fn(
    "VcsStatusBroadcaster.shareQueuedRefreshStatus",
  )(function* (rawCwd, options) {
    if (options?.localOnly) return yield* refreshStatus(rawCwd, options);
    const requested = yield* Deferred.make<VcsRefreshStatusResult, GitManagerServiceError>();
    // Registering and forking together keeps an interrupt from leaving an entry with no worker.
    const shared = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const followUp = yield* Ref.modify(
          queuedRefreshesRef,
          (queued): readonly [SharedRefresh | undefined, Map<string, SharedRefresh | null>] => {
            if (!queued.has(rawCwd)) return [undefined, new Map(queued).set(rawCwd, null)];
            const followUp = queued.get(rawCwd) ?? requested;
            return [followUp, new Map(queued).set(rawCwd, followUp)];
          },
        );
        if (followUp !== undefined) return followUp;
        // The broadcaster scope owns the work, so one caller's interrupt does not cancel it for the rest.
        yield* runQueuedRefreshes(rawCwd, requested).pipe(Effect.forkIn(broadcasterScope));
        return requested;
      }),
    );
    return yield* Deferred.await(shared);
  });

  const readHeadBranch = Effect.fn("VcsStatusBroadcaster.readHeadBranch")(function* (cwd: string) {
    const observation = ++branchObservation;
    const refName = yield* workflow.currentBranch(cwd);
    // A null branch is a detached HEAD or a checkout that is gone, such as a removed worktree.
    const isRepo = refName !== null || (yield* workflow.repositoryRoot(cwd)) !== null;
    return { observation, refName, isRepo };
  });

  // Keep cache invalidation serialized with detailed reads and refreshes.
  const refreshBranchStatusCore = Effect.fn("VcsStatusBroadcaster.refreshBranchStatusCore")(
    (cwd: string) =>
      localRefreshLocks.withLock(
        cwd,
        Effect.gen(function* () {
          if (detailedSubscribers.has(cwd)) {
            const local = yield* getOrLoadLocalStatusUnlocked(cwd);
            return (
              branches.get(cwd) ?? { refName: local.refName, isRepo: local.isRepo, revision: 0 }
            );
          }
          const { observation, refName, isRepo } = yield* readHeadBranch(cwd);
          // HEAD cannot certify working-tree totals, even when it has not moved.
          localRefreshResults.delete(cwd);
          yield* workflow.invalidateLocalStatus(cwd);
          yield* Ref.update(cacheRef, (cache) => {
            const previous = cache.get(cwd);
            return previous ? new Map(cache).set(cwd, { ...previous, local: null }) : cache;
          });
          if (detailedSubscribers.has(cwd)) {
            const local = yield* loadLocalStatus(cwd, { publish: true });
            return (
              branches.get(cwd) ?? { refName: local.refName, isRepo: local.isRepo, revision: 0 }
            );
          }
          yield* publishBranch(cwd, { refName, isRepo }, observation);
          return branches.get(cwd) ?? { refName, isRepo, revision: 0 };
        }),
      ),
  );

  // A checkout outside T3 Code, such as `git switch` in the terminal, calls no refresh RPC.
  // Rereading remote too, without a fetch, sends the new branch with its own PR and counts.
  const publishCheckedOutRef = Effect.fn("VcsStatusBroadcaster.publishCheckedOutRef")(function* (
    cwd: string,
  ) {
    if (!detailedSubscribers.has(cwd)) return yield* refreshBranchStatusCore(cwd);
    const { observation, refName, isRepo } = yield* readHeadBranch(cwd);
    yield* publishBranch(cwd, { refName, isRepo }, observation);
  });

  const reconcileCheckedOutRef = Effect.fn("VcsStatusBroadcaster.reconcileCheckedOutRef")(
    function* (cwd: string) {
      if (!detailedSubscribers.has(cwd)) return;
      if ((yield* getCachedStatus(cwd))?.remote) {
        yield* refreshRemoteStatus(cwd, { refreshUpstream: false });
      } else {
        yield* refreshLocalStatusCore(cwd);
      }
    },
  );

  const retryCheckedOutRef = <E>(cwd: string, refresh: Effect.Effect<unknown, E>) =>
    refresh.pipe(
      Effect.retry(CHECKOUT_REFRESH_RETRY),
      Effect.catchCause((cause) =>
        Effect.logWarning("VCS checked-out ref refresh failed", {
          cwdLength: cwd.length,
          ...remoteRefreshFailureDiagnostics(cause),
        }),
      ),
    );

  // Runs for the subscription lifetime, so tracing would leave a span open indefinitely.
  const watchHead = Effect.fnUntraced(function* (cwd: string, ready: Deferred.Deferred<void>) {
    const headPath = yield* workflow.headPath(cwd);
    if (headPath === null) return;
    const headDirectory = path.dirname(headPath);
    // Git replaces HEAD by renaming HEAD.lock, which a watch on the file itself would lose.
    yield* fs
      .watch(headDirectory, {
        onReady: () => Deferred.doneUnsafe(ready, Exit.void),
      })
      .pipe(
        // On Windows a watch outlives its deleted directory and reports it ~150k times a second.
        Stream.takeUntilEffect((event) =>
          event._tag === "Remove"
            ? fs.exists(headDirectory).pipe(Effect.map((exists) => !exists))
            : Effect.succeed(false),
        ),
        Stream.filter((event) => path.basename(event.path) === "HEAD"),
        // A rebase moves HEAD many times; refresh once for whatever arrived during a refresh.
        Stream.buffer({ capacity: 1, strategy: "sliding" }),
        Stream.mapEffect(() => retryCheckedOutRef(cwd, publishCheckedOutRef(cwd))),
        // Detailed status waits behind its own reads; the branch keeps up on the stage above.
        Stream.buffer({ capacity: 1, strategy: "sliding" }),
        Stream.runForEach(() => retryCheckedOutRef(cwd, reconcileCheckedOutRef(cwd))),
      );
  });

  const retainHeadWatcher = Effect.fn("VcsStatusBroadcaster.retainHeadWatcher")(function* (
    cwd: string,
  ) {
    const ready = yield* SynchronizedRef.modifyEffect(headWatchersRef, (activeWatchers) => {
      const existing = activeWatchers.get(cwd);
      if (existing && existing.fiber.pollUnsafe() === undefined) {
        const nextWatchers = new Map(activeWatchers).set(cwd, {
          ...existing,
          subscriberCount: existing.subscriberCount + 1,
        });
        return Effect.succeed([existing.ready, nextWatchers] as const);
      }
      // A watch that ended, say before the repository existed, restarts for everyone holding it.
      return Effect.gen(function* () {
        const ready = yield* Deferred.make<void>();
        const fiber = yield* watchHead(cwd, ready).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("VCS HEAD watch failed", {
              cwdLength: cwd.length,
              ...remoteRefreshFailureDiagnostics(cause),
            }),
          ),
          // Subscribers wait for the watch, so one that cannot start must not hold them.
          Effect.ensuring(Deferred.succeed(ready, undefined)),
          Effect.forkIn(broadcasterScope),
        );
        const nextWatchers = new Map(activeWatchers).set(cwd, {
          fiber,
          ready,
          subscriberCount: (existing?.subscriberCount ?? 0) + 1,
        });
        return [ready, nextWatchers] as const;
      });
    });
    yield* Deferred.await(ready);
  });

  const releaseHeadWatcher = Effect.fn("VcsStatusBroadcaster.releaseHeadWatcher")(function* (
    cwd: string,
  ) {
    const watcherToInterrupt = yield* SynchronizedRef.modify(headWatchersRef, (activeWatchers) => {
      const existing = activeWatchers.get(cwd);
      if (!existing) return [null, activeWatchers] as const;
      const nextWatchers = new Map(activeWatchers);
      if (existing.subscriberCount > 1) {
        nextWatchers.set(cwd, { ...existing, subscriberCount: existing.subscriberCount - 1 });
        return [null, nextWatchers] as const;
      }
      nextWatchers.delete(cwd);
      return [existing.fiber, nextWatchers] as const;
    });
    if (watcherToInterrupt) {
      yield* Fiber.interrupt(watcherToInterrupt).pipe(Effect.ignore);
    }
  });

  const streamStatus: VcsStatusBroadcaster["Service"]["streamStatus"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const cwd = yield* withFileSystem(normalizeCwd(input.cwd));
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const previous = detailedSubscribers.get(cwd) ?? 0;
            detailedSubscribers.set(cwd, previous + 1);
          }),
          () =>
            Effect.sync(() => {
              const remaining = (detailedSubscribers.get(cwd) ?? 1) - 1;
              if (remaining === 0) detailedSubscribers.delete(cwd);
              else detailedSubscribers.set(cwd, remaining);
            }).pipe(Effect.andThen(trimCachedStatuses)),
        );
        if (input.includeRemote !== false) yield* acquireBranchChangesDemand(cwd);
        const subscription = yield* PubSub.subscribe(changesPubSub);
        // Watch before reading so a checkout in between still publishes.
        yield* Effect.acquireRelease(retainHeadWatcher(cwd), () => releaseHeadWatcher(cwd));
        const initialLocal = yield* getOrLoadLocalStatus(cwd);
        const cachedStatus = yield* getCachedStatus(cwd);
        const initialRemote = cachedStatus?.remote?.value ?? null;
        if (input.includeRemote !== false) {
          yield* retainRemotePoller(
            cwd,
            input.cwd,
            cachedStatus?.remote === null || cachedStatus?.remote === undefined,
          );
        }
        const release =
          input.includeRemote === false
            ? Effect.void
            : releaseRemotePoller(cwd, input.cwd).pipe(Effect.ignore, Effect.asVoid);

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

  const refreshBranchStatus: VcsStatusBroadcaster["Service"]["refreshBranchStatus"] = Effect.fn(
    "VcsStatusBroadcaster.refreshBranchStatus",
  )(function* (input) {
    const cwd = yield* withFileSystem(normalizeCwd(input.cwd));
    if (!detailedSubscribers.has(cwd)) {
      const { refName, isRepo } = yield* refreshBranchStatusCore(cwd);
      return { refName, isRepo };
    }
    const { observation, refName, isRepo } = yield* readHeadBranch(cwd);
    yield* publishBranch(cwd, { refName, isRepo }, observation);
    yield* refreshBranchStatusCore(cwd).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("VCS branch refresh failed", {
          cwdLength: cwd.length,
          ...remoteRefreshFailureDiagnostics(cause),
        }),
      ),
      Effect.forkIn(broadcasterScope),
    );
    return { refName, isRepo };
  });

  const streamBranchStatus: VcsStatusBroadcaster["Service"]["streamBranchStatus"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const cwd = yield* withFileSystem(normalizeCwd(input.cwd));
        const subscription = yield* PubSub.subscribe(branchChangesPubSub);
        yield* Effect.acquireRelease(retainHeadWatcher(cwd), () => releaseHeadWatcher(cwd));
        const branch = yield* refreshBranchStatusCore(cwd);
        return Stream.concat(
          Stream.make({ refName: branch.refName, isRepo: branch.isRepo }),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((event) => event.cwd === cwd && event.revision > branch.revision),
            Stream.map(({ refName, isRepo }) => ({ refName, isRepo })),
          ),
        ).pipe(
          Stream.changesWith(
            (left, right) => left.refName === right.refName && left.isRepo === right.isRepo,
          ),
        );
      }),
    );

  return VcsStatusBroadcaster.of({
    streamBranchStatus,
    refreshBranchStatus,
    streamBranchChanges: Stream.fromPubSub(branchChangesPubSub).pipe(
      Stream.map(({ cwd, refName }) => ({ cwd, refName })),
    ),
    getStatus,
    refreshLocalStatus,
    refreshAfterCheckout,
    refreshStatus: shareQueuedRefreshStatus,
    refreshPullRequestStatus,
    streamStatus,
  });
});

export const layer = Layer.effect(VcsStatusBroadcaster, make);
