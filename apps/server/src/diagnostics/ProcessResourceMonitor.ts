import type {
  ResourceTelemetryProcessCategory,
  ServerProcessResourceHistoryInput,
  ServerProcessResourceHistoryResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProcessDiagnostics from "./ProcessDiagnostics.ts";

const SAMPLE_INTERVAL_MS = 5_000;
const RETENTION_MS = 60 * 60_000;
const MAX_RETAINED_SAMPLES = 20_000;

/** Trailing window the slow-tool health read summarises (≆ 6 samples). */
const PROCESS_TREE_ACTIVITY_WINDOW_MS = 30_000;

export interface ProcessResourceSample {
  readonly sampledAt: DateTime.Utc;
  readonly sampledAtMs: number;
  readonly processKey: string;
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
  readonly cpuPercent: number;
  readonly rssBytes: number;
  readonly depth: number;
  readonly isServerRoot: boolean;
}

/**
 * Trailing-window health of one child's provider process subtree. `active` means peak subtree CPU
 * cleared {@link PROCESS_TREE_ACTIVE_CPU_THRESHOLD} at some read; inactive may be stuck or merely
 * blocked on I/O, hence the hedge in the slow-tool notice copy.
 */
export interface ProcessTreeActivity {
  readonly peakCpuPercent: number;
  readonly processCount: number;
  readonly windowMs: number;
  readonly active: boolean;
}

/** Peak-CPU floor (percent) above which a process subtree counts as working. */
const PROCESS_TREE_ACTIVE_CPU_THRESHOLD = 1;

/**
 * Peak per-read CPU of the subtree rooted where the command line contains `marker` (the child's pi
 * `--session-id`). `null` when that root is absent from the LATEST read (remote provider, exited
 * process, no samples yet), so the caller shows the plain notice, not a misleading CPU claim.
 */
export function recentProcessTreeActivity(input: {
  readonly samples: ReadonlyArray<ProcessResourceSample>;
  readonly marker: string;
  readonly nowMs: number;
  readonly windowMs: number;
}): ProcessTreeActivity | null {
  const windowStartMs = input.nowMs - input.windowMs;
  const windowed = input.samples.filter((sample) => sample.sampledAtMs >= windowStartMs);
  if (windowed.length === 0) return null;

  // The root must be in the newest read, not merely in the window: an exited process's lingering
  // samples must not report activity. The subtree topology is read from that latest read too.
  const latestSampledAtMs = Math.max(...windowed.map((sample) => sample.sampledAtMs));
  const latestRead = windowed.filter((sample) => sample.sampledAtMs === latestSampledAtMs);
  const rootPids = new Set(
    latestRead
      .filter((sample) => sample.command.includes(input.marker))
      .map((sample) => sample.pid),
  );
  if (rootPids.size === 0) return null;

  const childrenByParent = new Map<number, number[]>();
  for (const sample of latestRead) {
    const children = childrenByParent.get(sample.ppid) ?? [];
    children.push(sample.pid);
    childrenByParent.set(sample.ppid, children);
  }
  const subtree = new Set(rootPids);
  const stack = [...rootPids];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    for (const childPid of childrenByParent.get(pid) ?? []) {
      if (!subtree.has(childPid)) {
        subtree.add(childPid);
        stack.push(childPid);
      }
    }
  }

  // Peak CPU over the trailing window, but only for the currently-live subtree
  // pids — recent CPU history of processes that are still present now.
  const peakCpuPercent = windowed
    .filter((sample) => subtree.has(sample.pid))
    .reduce((peak, sample) => Math.max(peak, sample.cpuPercent), 0);
  return {
    peakCpuPercent,
    processCount: subtree.size,
    windowMs: input.windowMs,
    active: peakCpuPercent >= PROCESS_TREE_ACTIVE_CPU_THRESHOLD,
  };
}

import * as ResourceTelemetry from "../resourceTelemetry/ResourceTelemetry.ts";

export class ProcessResourceMonitor extends Context.Service<
  ProcessResourceMonitor,
  {
    readonly readHistory: (
      input: ServerProcessResourceHistoryInput,
    ) => Effect.Effect<ServerProcessResourceHistoryResult>;
    /**
     * Trailing-window health of the process subtree whose provider command line
     * contains `marker` (the child's pi `--session-id`). `null` when nothing
     * local matches so the caller degrades cleanly. Reads already-collected
     * samples — no extra sampling.
     */
    readonly recentActivityFor: (marker: string) => Effect.Effect<ProcessTreeActivity | null>;
  }
>()("t3/diagnostics/ProcessResourceMonitor") {}

function isLegacyBackendCategory(category: ResourceTelemetryProcessCategory): boolean {
  return (
    category === "server" ||
    category === "server-child" ||
    category === "provider-root" ||
    category === "terminal-root"
  );
}

/** @public */
export const make = Effect.fn("makeProcessResourceMonitor")(function* () {
  const telemetry = yield* ResourceTelemetry.ResourceTelemetry;
  const readHistory: ProcessResourceMonitor["Service"]["readHistory"] = (input) =>
    telemetry.readHistory(input).pipe(
      Effect.map((history) => {
        const topProcesses = history.topProcesses
          .filter((entry) => isLegacyBackendCategory(entry.category))
          .map((entry) => ({
            processKey: `${entry.identity.pid}:${entry.identity.startTimeMs}`,
            pid: entry.identity.pid,
            ppid: entry.ppid,
            command: entry.command || entry.name || "unknown",
            depth: entry.depth,
            isServerRoot: entry.category === "server",
            firstSeenAt: entry.firstSeenAt,
            lastSeenAt: entry.lastSeenAt,
            currentCpuPercent: entry.currentCpuPercent,
            avgCpuPercent: entry.avgCpuPercent,
            maxCpuPercent: entry.maxCpuPercent,
            cpuSecondsApprox: entry.cpuTimeMs / 1_000,
            currentRssBytes: entry.currentRssBytes,
            maxRssBytes: entry.peakRssBytes,
            sampleCount: entry.sampleCount,
          }));
        return {
          readAt: history.readAt,
          windowMs: history.windowMs,
          bucketMs: history.bucketMs,
          sampleIntervalMs: history.sampleIntervalMs,
          retainedSampleCount: history.retainedSampleCount,
          totalCpuSecondsApprox: topProcesses.reduce(
            (total, entry) => total + entry.cpuSecondsApprox,
            0,
          ),
          buckets: (history.legacyBackendBuckets ?? history.buckets).map((bucket) => ({
            startedAt: bucket.startedAt,
            endedAt: bucket.endedAt,
            avgCpuPercent: bucket.avgCpuPercent,
            maxCpuPercent: bucket.maxCpuPercent,
            maxRssBytes: bucket.maxRssBytes,
            maxProcessCount: bucket.maxProcessCount,
          })),
          topProcesses,
          error: history.health.native.lastError.pipe(
            Option.map((message) => ({
              failureTag: "ProcessDiagnosticsQueryFailedError" as const,
              message,
            })),
          ),
        };
      }),
    );

  // loom: re-homed onto upstream's telemetry history. The history already
  // carries the trailing-window peak per process (`maxCpuPercent`) and the
  // ppid edges, which is exactly what the sample-window read derived by hand.
  const recentActivityFor: ProcessResourceMonitor["Service"]["recentActivityFor"] = (marker) =>
    readHistory({ windowMs: PROCESS_TREE_ACTIVITY_WINDOW_MS, bucketMs: SAMPLE_INTERVAL_MS }).pipe(
      Effect.map((history) =>
        recentProcessTreeActivity({
          samples: history.topProcesses.map((entry) => ({
            processKey: entry.processKey,
            pid: entry.pid,
            ppid: entry.ppid,
            command: entry.command,
            depth: entry.depth,
            isServerRoot: entry.isServerRoot,
            // One row per live process, all stamped with the same read so the
            // "latest read" topology is the window's live tree.
            sampledAt: history.readAt,
            sampledAtMs: 0,
            cpuPercent: entry.maxCpuPercent,
            rssBytes: entry.maxRssBytes,
          })),
          marker,
          nowMs: 0,
          windowMs: PROCESS_TREE_ACTIVITY_WINDOW_MS,
        }),
      ),
    );

  return ProcessResourceMonitor.of({ readHistory, recentActivityFor });
});

export const layer = Layer.effect(ProcessResourceMonitor, make());
