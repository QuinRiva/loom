/**
 * Instrumentation and liveness for the bounded provider-runtime pipeline
 * (plans/ingestion-backpressure §3.1 liveness, §3.5).
 *
 * - The `provider runtime ingestion interval` log line, built on the engine's
 *   `orchestration command queue interval` pattern: bucket histograms flushed
 *   from the worker once a minute is due, so an idle server logs nothing.
 * - The liveness watchdog. With every hop bounded, a wedged consumer freezes
 *   every agent instead of growing the heap until V8 aborts (which, with the
 *   systemd restart, was the only recovery that existed). The watchdog restores
 *   that recovery deliberately: after `INGESTION_STALL_CHECKS` minutes with work
 *   pending and no progress it logs the sample and exits the process non-zero.
 *
 * @module ProviderRuntimeIngestionTelemetry
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import type { DrainableWorker } from "@t3tools/shared/DrainableWorker";

import { piStdoutBackpressure } from "../provider/Layers/Pi/RpcProcess.ts";

const INTERVAL_MS = 60_000;
// Consecutive once-a-minute checks with work pending and no progress before the
// process exits: 5 minutes. Long enough that no legitimate single event (the
// engine is serial, and dispatch awaits it) comes near it; short enough to beat
// today's OOM restart. Counted in observed checks rather than wall-clock time so
// a machine waking from sleep with work queued is not mistaken for a stall.
const INGESTION_STALL_CHECKS = 5;
const LAG_BUCKETS_MS = [
  0,
  10,
  50,
  100,
  250,
  500,
  1_000,
  2_000,
  5_000,
  10_000,
  30_000,
  60_000,
  120_000,
  300_000,
  600_000,
  1_800_000,
  Number.POSITIVE_INFINITY,
] as const;
const PROCESSING_BUCKETS_MS = [
  0,
  1,
  2,
  5,
  10,
  20,
  50,
  100,
  250,
  500,
  1_000,
  3_000,
  10_000,
  30_000,
  Number.POSITIVE_INFINITY,
] as const;

/**
 * Written by `ProviderService` around each runtime-event `publish`, which
 * suspends while the bounded PubSub is full. `sinceMs` is when the current run
 * of in-flight publishes began.
 */
export const runtimeEventPublishBackpressure = { inFlight: 0, sinceMs: 0, suspendedMsTotal: 0 };

export const trackRuntimeEventPublish = <A>(publish: Effect.Effect<A>): Effect.Effect<A> =>
  Clock.currentTimeMillis.pipe(
    Effect.tap((nowMs) =>
      Effect.sync(() => {
        if (runtimeEventPublishBackpressure.inFlight++ === 0) {
          runtimeEventPublishBackpressure.sinceMs = nowMs;
        }
      }),
    ),
    Effect.andThen(publish),
    Effect.ensuring(
      Clock.currentTimeMillis.pipe(
        Effect.map((nowMs) => {
          if (--runtimeEventPublishBackpressure.inFlight === 0) {
            runtimeEventPublishBackpressure.suspendedMsTotal +=
              nowMs - runtimeEventPublishBackpressure.sinceMs;
          }
        }),
      ),
    ),
  );

// The engine's unbounded `eventPubSub` — the next fan-out to watch (§3.6).
let engineEventPubSubSize: Effect.Effect<number> = Effect.succeed(0);
export const registerEngineEventPubSubSize = (size: Effect.Effect<number>): void => {
  engineEventPubSubSize = size;
};

/**
 * Time the ingestion worker spends waiting while processing one event, split so
 * the interval shows what a concurrent worker could overlap: the async SQLite
 * read lane and the serial engine dispatch. Synchronous work (including the
 * in-process write connection) is the remainder.
 */
interface IngestionWaits {
  sqlReadMs: number;
  engineDispatchMs: number;
}
const CurrentIngestionWaits = Context.Reference<IngestionWaits | undefined>(
  "t3/diagnostics/ProviderRuntimeIngestionTelemetry/CurrentIngestionWaits",
  { defaultValue: () => undefined },
);

/** Adds `effect`'s duration to the current ingestion item's waits; free elsewhere. */
export const timeIngestionWait = <A, E, R>(
  key: keyof IngestionWaits,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.withFiber((fiber) => {
    const waits = fiber.getRef(CurrentIngestionWaits);
    if (waits === undefined) return effect;
    return Clock.currentTimeNanos.pipe(
      Effect.flatMap((startedAt) =>
        Effect.ensuring(
          effect,
          Clock.currentTimeNanos.pipe(
            Effect.map((endedAt) => {
              waits[key] += Number(endedAt - startedAt) / 1e6;
            }),
          ),
        ),
      ),
    );
  });

type IngestionLiveness = "ok" | "warn" | "escalate";

/**
 * One watchdog check. A check is stalled when ingestion has work it is not
 * getting through — items queued or in flight, or the pipeline blocked since
 * before the previous check — and no item has started or finished since the
 * previous check. `blockedSinceMs` is the earliest of a suspended runtime-event
 * publish (the PubSub full behind some subscriber) and a paused pi stdout (a
 * wedge anywhere between the reader and ingestion, e.g. the adapter fibre stuck
 * in SQL before it publishes); `Infinity` when neither. Warns on any stalled
 * check; escalates after `thresholdChecks` in a row.
 */
export const decideIngestionLiveness = (
  check: {
    readonly previousCheckAtMs: number;
    readonly lastProgressAtMs: number;
    readonly queueDepth: number;
    readonly blockedSinceMs: number;
    readonly stalledChecks: number;
  },
  thresholdChecks = INGESTION_STALL_CHECKS,
): { readonly liveness: IngestionLiveness; readonly stalledChecks: number } => {
  const pending = check.queueDepth > 0 || check.blockedSinceMs <= check.previousCheckAtMs;
  const stalledChecks =
    pending && check.lastProgressAtMs <= check.previousCheckAtMs ? check.stalledChecks + 1 : 0;
  return {
    stalledChecks,
    liveness: stalledChecks === 0 ? "ok" : stalledChecks >= thresholdChecks ? "escalate" : "warn",
  };
};

const makeHistogram = (buckets: ReadonlyArray<number>) => ({
  counts: buckets.map(() => 0),
  maxMs: 0,
  totalMs: 0,
  record(ms: number) {
    const index = buckets.findIndex((upperBound) => ms <= upperBound);
    this.counts[index < 0 ? this.counts.length - 1 : index]! += 1;
    this.maxMs = Math.max(this.maxMs, ms);
    this.totalMs += ms;
  },
  percentile(percentile: number): number {
    const total = this.counts.reduce((sum, count) => sum + count, 0);
    if (total === 0) return 0;
    const target = Math.ceil(total * percentile);
    let observed = 0;
    for (const [index, count] of this.counts.entries()) {
      observed += count;
      if (observed >= target) {
        const upperBound = buckets[index]!;
        return Number.isFinite(upperBound) ? upperBound : this.maxMs;
      }
    }
    return this.maxMs;
  },
});

const makeInterval = (startedAtMs: number) => ({
  startedAtMs,
  enqueued: 0,
  processed: 0,
  queueDepthMax: 0,
  intakeSuspendedMs: 0,
  lag: makeHistogram(LAG_BUCKETS_MS),
  processing: makeHistogram(PROCESSING_BUCKETS_MS),
  sqlReadWaitMs: 0,
  engineDispatchWaitMs: 0,
  publishSuspendedMsAtStart: runtimeEventPublishBackpressure.suspendedMsTotal,
});

/**
 * Wraps the ingestion worker: `instrumentProcess` records lag, processing time
 * and waits per item and flushes the interval when due; `instrumentWorker`
 * counts enqueues and the time they spend suspended; `watchLiveness` is the
 * watchdog fibre body.
 */
export const makeIngestionTelemetry = Effect.gen(function* () {
  const startedAtMs = yield* Clock.currentTimeMillis;
  let interval = makeInterval(startedAtMs);
  let enqueuedTotal = 0;
  let processedTotal = 0;
  // Advanced when an item starts as well as when it finishes, so a quiet spell
  // before an item never counts towards that item's stall.
  let lastProgressAtMs = startedAtMs;

  const sample = (nowMs: number) =>
    engineEventPubSubSize.pipe(
      Effect.map((enginePubSubSize) => {
        const { lag, processing } = interval;
        const publishSuspendedForMs =
          runtimeEventPublishBackpressure.inFlight > 0
            ? nowMs - runtimeEventPublishBackpressure.sinceMs
            : 0;
        return {
          intervalMs: nowMs - interval.startedAtMs,
          enqueued: interval.enqueued,
          processed: interval.processed,
          // An item can finish before its enqueuer resumes to count it.
          queueDepthNow: Math.max(0, enqueuedTotal - processedTotal),
          queueDepthMax: interval.queueDepthMax,
          intakeSuspendedMs: Math.round(interval.intakeSuspendedMs),
          lagP50Ms: lag.percentile(0.5),
          lagP95Ms: lag.percentile(0.95),
          lagMaxMs: Math.round(lag.maxMs),
          processingP50Ms: processing.percentile(0.5),
          processingP95Ms: processing.percentile(0.95),
          processingMaxMs: Math.round(processing.maxMs),
          processingTotalMs: Math.round(processing.totalMs),
          sqlReadWaitMs: Math.round(interval.sqlReadWaitMs),
          engineDispatchWaitMs: Math.round(interval.engineDispatchWaitMs),
          remainderMs: Math.round(
            processing.totalMs - interval.sqlReadWaitMs - interval.engineDispatchWaitMs,
          ),
          publishSuspendedMs:
            runtimeEventPublishBackpressure.suspendedMsTotal - interval.publishSuspendedMsAtStart,
          publishSuspendedForMs,
          lastProgressAgoMs: nowMs - lastProgressAtMs,
          enginePubSubSize,
        };
      }),
    );

  const logIntervalIfDue = Clock.currentTimeMillis.pipe(
    Effect.flatMap((nowMs) => {
      if (nowMs - interval.startedAtMs < INTERVAL_MS) return Effect.void;
      return sample(nowMs).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            interval = makeInterval(nowMs);
          }),
        ),
        Effect.flatMap((fields) => Effect.logInfo("provider runtime ingestion interval", fields)),
      );
    }),
  );

  const instrumentProcess =
    <A extends { readonly event: { readonly createdAt: string } }, E, R>(
      handle: (item: A) => Effect.Effect<void, E, R>,
    ) =>
    (item: A): Effect.Effect<void, E, R> =>
      Effect.gen(function* () {
        const startedAtMs = yield* Clock.currentTimeMillis;
        const startedAtNs = yield* Clock.currentTimeNanos;
        lastProgressAtMs = startedAtMs;
        interval.lag.record(Math.max(0, startedAtMs - Date.parse(item.event.createdAt)));
        const waits: IngestionWaits = { sqlReadMs: 0, engineDispatchMs: 0 };
        yield* handle(item).pipe(
          Effect.provideService(CurrentIngestionWaits, waits),
          Effect.ensuring(
            Effect.gen(function* () {
              const endedAtNs = yield* Clock.currentTimeNanos;
              lastProgressAtMs = yield* Clock.currentTimeMillis;
              processedTotal += 1;
              interval.processed += 1;
              interval.processing.record(Number(endedAtNs - startedAtNs) / 1e6);
              interval.sqlReadWaitMs += waits.sqlReadMs;
              interval.engineDispatchWaitMs += waits.engineDispatchMs;
              yield* logIntervalIfDue;
            }),
          ),
        );
      });

  const instrumentWorker = <A>(inner: DrainableWorker<A>): DrainableWorker<A> => ({
    drain: inner.drain,
    enqueue: (item) =>
      Effect.gen(function* () {
        const startedAtNs = yield* Clock.currentTimeNanos;
        yield* inner.enqueue(item);
        const endedAtNs = yield* Clock.currentTimeNanos;
        enqueuedTotal += 1;
        interval.enqueued += 1;
        interval.queueDepthMax = Math.max(interval.queueDepthMax, enqueuedTotal - processedTotal);
        interval.intakeSuspendedMs += Number(endedAtNs - startedAtNs) / 1e6;
      }),
  });

  let previousCheckAtMs = startedAtMs;
  let stalledChecks = 0;
  const watchLiveness = Effect.gen(function* () {
    yield* Effect.sleep(INTERVAL_MS);
    const nowMs = yield* Clock.currentTimeMillis;
    const fields = yield* sample(nowMs);
    const piStdoutPausedSinceMs = Math.min(...piStdoutBackpressure.pausedSince.values());
    const decision = decideIngestionLiveness({
      previousCheckAtMs,
      lastProgressAtMs,
      queueDepth: fields.queueDepthNow,
      blockedSinceMs: Math.min(
        runtimeEventPublishBackpressure.inFlight > 0
          ? runtimeEventPublishBackpressure.sinceMs
          : Number.POSITIVE_INFINITY,
        piStdoutPausedSinceMs,
      ),
      stalledChecks,
    });
    const details = {
      ...fields,
      piStdoutPausedNow: piStdoutBackpressure.pausedSince.size,
      piStdoutPausedForMs: Number.isFinite(piStdoutPausedSinceMs)
        ? nowMs - piStdoutPausedSinceMs
        : 0,
      stalledChecks: decision.stalledChecks,
    };
    previousCheckAtMs = nowMs;
    stalledChecks = decision.stalledChecks;
    if (decision.liveness === "warn") {
      yield* Effect.logWarning("provider runtime ingestion is not making progress", details);
    }
    if (decision.liveness === "escalate") {
      // `Effect.die` here would end only this fibre; the point is a process
      // exit that the supervisor (systemd) restarts, as the OOM abort used to.
      yield* Effect.logError(
        "provider runtime ingestion stalled; exiting so the supervisor restarts the server",
        details,
      );
      globalThis.process.exit(1);
    }
  }).pipe(Effect.forever);

  return { instrumentProcess, instrumentWorker, watchLiveness };
});
