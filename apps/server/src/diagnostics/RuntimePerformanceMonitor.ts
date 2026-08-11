// @effect-diagnostics nodeBuiltinImport:off
import * as NodeInspector from "node:inspector";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeV8 from "node:v8";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const SAMPLE_INTERVAL_MS = 60_000;
const EVENT_LOOP_DELAY_RESOLUTION_MS = 20;
const toMillis = (nanoseconds: number): number =>
  Math.round((nanoseconds / 1_000_000) * 1_000) / 1_000;

const make = Effect.acquireRelease(
  Effect.sync(() => {
    const eventLoopDelay = NodePerfHooks.monitorEventLoopDelay({
      resolution: EVENT_LOOP_DELAY_RESOLUTION_MS,
    });
    eventLoopDelay.enable();
    return eventLoopDelay;
  }),
  (eventLoopDelay) => Effect.sync(() => eventLoopDelay.disable()),
).pipe(
  Effect.flatMap((eventLoopDelay) =>
    Effect.gen(function* () {
      yield* Effect.logInfo("runtime performance instrumentation started", {
        sampleIntervalMs: SAMPLE_INTERVAL_MS,
        eventLoopDelayResolutionMs: EVENT_LOOP_DELAY_RESOLUTION_MS,
        traceGcEnabled: process.execArgv.some((arg) => /^--trace[-_]gc(?:=|$)/.test(arg)),
        inspectorEnabled: NodeInspector.url() !== undefined,
        maxOldSpaceSizeArg:
          process.execArgv.find((arg) => /^--max[-_]old[-_]space[-_]size=/.test(arg)) ?? null,
      });

      const sample = Effect.sync(() => {
        const heap = NodeV8.getHeapStatistics();
        const eventLoop = {
          eventLoopDelayP50Ms: toMillis(eventLoopDelay.percentile(50)),
          eventLoopDelayP95Ms: toMillis(eventLoopDelay.percentile(95)),
          eventLoopDelayP99Ms: toMillis(eventLoopDelay.percentile(99)),
          eventLoopDelayMaxMs: toMillis(eventLoopDelay.max),
          eventLoopDelayMeanMs: toMillis(eventLoopDelay.mean),
        };
        eventLoopDelay.reset();
        return {
          processUptimeMs: Math.round(process.uptime() * 1_000),
          rssBytes: process.memoryUsage.rss(),
          usedHeapSizeBytes: heap.used_heap_size,
          totalHeapSizeBytes: heap.total_heap_size,
          totalPhysicalSizeBytes: heap.total_physical_size,
          totalAvailableSizeBytes: heap.total_available_size,
          heapSizeLimitBytes: heap.heap_size_limit,
          mallocedMemoryBytes: heap.malloced_memory,
          peakMallocedMemoryBytes: heap.peak_malloced_memory,
          externalMemoryBytes: heap.external_memory,
          nativeContextCount: heap.number_of_native_contexts,
          detachedContextCount: heap.number_of_detached_contexts,
          ...eventLoop,
        };
      }).pipe(Effect.flatMap((metrics) => Effect.logInfo("runtime performance interval", metrics)));

      yield* Effect.forkScoped(
        Effect.forever(Effect.sleep(SAMPLE_INTERVAL_MS).pipe(Effect.andThen(sample))),
      );
    }),
  ),
);

export const layer = Layer.effectDiscard(make);
