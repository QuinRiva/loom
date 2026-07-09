import {
  ServerProcessResourceHistoryFailureTag,
  type ServerProcessResourceHistoryBucket,
  type ServerProcessResourceHistoryFailureTag as ServerProcessResourceHistoryFailureTagType,
  type ServerProcessResourceHistoryInput,
  type ServerProcessResourceHistoryResult,
  type ServerProcessResourceHistorySummary,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessDiagnostics from "./ProcessDiagnostics.ts";

const SAMPLE_INTERVAL_MS = 5_000;
const RETENTION_MS = 60 * 60_000;
const MAX_RETAINED_SAMPLES = 20_000;

/** Trailing window the slow-tool health read summarises (≆ 6 samples). */
export const PROCESS_TREE_ACTIVITY_WINDOW_MS = 30_000;

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
 * A cheap process-health verdict over the trailing window for one child's
 * provider process subtree, read from samples already collected. `active` is
 * the honest one-bit signal the slow-tool notice needs: peak CPU across the
 * subtree cleared {@link PROCESS_TREE_ACTIVE_CPU_THRESHOLD} at some read in the
 * window (grinding), vs no meaningful CPU (may be genuinely stuck — or blocked
 * on I/O/network, hence the hedge in the copy).
 */
export interface ProcessTreeActivity {
  readonly peakCpuPercent: number;
  readonly processCount: number;
  readonly windowMs: number;
  readonly active: boolean;
}

/** Peak-CPU floor (percent) above which a process subtree counts as working. */
export const PROCESS_TREE_ACTIVE_CPU_THRESHOLD = 1;

/**
 * Pure trailing-window health read for the process subtree whose provider
 * command line contains `marker` (the child's pi `--session-id`, which the
 * dispatcher passes). Locates the matching root pid(s) among windowed samples,
 * expands to their full descendant subtree via observed ppid edges, and reports
 * the peak per-read CPU across it. Returns `null` when the marker root is not
 * present in the LATEST monitor read — a remote/SSH-hosted provider whose
 * process is not local, an exited process (gone from the newest `ps` snapshot,
 * even if a stale sample lingers in the window), or a monitor with no samples
 * yet — so the caller degrades to the plain notice instead of turning a
 * missing/gone measurement into a misleading CPU claim.
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

  // The root must be LIVE now: present in the newest read within the window, not
  // merely somewhere in the trailing window. A process that exited drops out of
  // the latest `ps` snapshot, so its lingering older samples must not keep
  // reporting activity. The subtree topology is likewise read from the latest
  // read (the current tree), so only currently-observed processes are summarised.
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

export class ProcessResourceSamplingError extends Schema.TaggedErrorClass<ProcessResourceSamplingError>()(
  "ProcessResourceSamplingError",
  {
    failureTag: ServerProcessResourceHistoryFailureTag,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to sample process resources (${this.failureTag}).`;
  }
}

interface MonitorState {
  readonly samples: ReadonlyArray<ProcessResourceSample>;
  readonly lastFailure: ProcessResourceSamplingError | null;
}

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

function dateTimeFromMillis(ms: number): DateTime.Utc {
  return DateTime.makeUnsafe(ms);
}

function sampleKey(row: Pick<ProcessDiagnostics.ProcessRow, "pid" | "command">): string {
  return `${row.pid}:${row.command}`;
}

function findServerRootRow(
  rows: ReadonlyArray<ProcessDiagnostics.ProcessRow>,
  serverPid: number,
): ProcessDiagnostics.ProcessRow | null {
  return rows.find((row) => row.pid === serverPid) ?? null;
}

export function collectMonitoredSamples(input: {
  readonly rows: ReadonlyArray<ProcessDiagnostics.ProcessRow>;
  readonly serverPid: number;
  readonly sampledAt: DateTime.Utc;
  readonly sampledAtMs: number;
}): ReadonlyArray<ProcessResourceSample> {
  const rows = input.rows.filter(
    (row) => !ProcessDiagnostics.isDiagnosticsQueryProcess(row, input.serverPid),
  );
  const root = findServerRootRow(rows, input.serverPid);
  const descendants = ProcessDiagnostics.buildDescendantEntries(rows, input.serverPid);
  const samples: ProcessResourceSample[] = [];

  if (root) {
    samples.push({
      sampledAt: input.sampledAt,
      sampledAtMs: input.sampledAtMs,
      processKey: sampleKey(root),
      pid: root.pid,
      ppid: root.ppid,
      command: root.command,
      cpuPercent: root.cpuPercent,
      rssBytes: root.rssBytes,
      depth: 0,
      isServerRoot: true,
    });
  }

  for (const process of descendants) {
    samples.push({
      sampledAt: input.sampledAt,
      sampledAtMs: input.sampledAtMs,
      processKey: sampleKey(process),
      pid: process.pid,
      ppid: process.ppid,
      command: process.command,
      cpuPercent: process.cpuPercent,
      rssBytes: process.rssBytes,
      depth: process.depth + 1,
      isServerRoot: false,
    });
  }

  return samples;
}

function trimSamples(
  samples: ReadonlyArray<ProcessResourceSample>,
  nowMs: number,
): ReadonlyArray<ProcessResourceSample> {
  const minSampledAtMs = nowMs - RETENTION_MS;
  const retained = samples.filter((sample) => sample.sampledAtMs >= minSampledAtMs);
  return retained.length <= MAX_RETAINED_SAMPLES
    ? retained
    : retained.slice(retained.length - MAX_RETAINED_SAMPLES);
}

function summarizeProcesses(
  samples: ReadonlyArray<ProcessResourceSample>,
): ReadonlyArray<ServerProcessResourceHistorySummary> {
  const groups = new Map<string, ProcessResourceSample[]>();
  for (const sample of samples) {
    const processSamples = groups.get(sample.processKey) ?? [];
    processSamples.push(sample);
    groups.set(sample.processKey, processSamples);
  }

  return [...groups.entries()]
    .map(([processKey, processSamples]) => {
      const sorted = processSamples.toSorted((left, right) => left.sampledAtMs - right.sampledAtMs);
      const first = sorted[0]!;
      const latest = sorted[sorted.length - 1]!;
      const cpuPercentTotal = sorted.reduce((total, sample) => total + sample.cpuPercent, 0);
      const maxCpuPercent = Math.max(...sorted.map((sample) => sample.cpuPercent));
      const maxRssBytes = Math.max(...sorted.map((sample) => sample.rssBytes));
      const cpuSecondsApprox = sorted.reduce(
        (total, sample) => total + (sample.cpuPercent / 100) * (SAMPLE_INTERVAL_MS / 1_000),
        0,
      );

      return {
        processKey,
        pid: latest.pid,
        ppid: latest.ppid,
        command: latest.command,
        depth: latest.depth,
        isServerRoot: latest.isServerRoot,
        firstSeenAt: first.sampledAt,
        lastSeenAt: latest.sampledAt,
        currentCpuPercent: latest.cpuPercent,
        avgCpuPercent: cpuPercentTotal / sorted.length,
        maxCpuPercent,
        cpuSecondsApprox,
        currentRssBytes: latest.rssBytes,
        maxRssBytes,
        sampleCount: sorted.length,
      } satisfies ServerProcessResourceHistorySummary;
    })
    .toSorted((left, right) => right.cpuSecondsApprox - left.cpuSecondsApprox);
}

function buildBuckets(input: {
  readonly samples: ReadonlyArray<ProcessResourceSample>;
  readonly nowMs: number;
  readonly windowMs: number;
  readonly bucketMs: number;
}): ReadonlyArray<ServerProcessResourceHistoryBucket> {
  const bucketMs = Math.max(1_000, input.bucketMs);
  const windowStartMs = input.nowMs - input.windowMs;
  const buckets: ServerProcessResourceHistoryBucket[] = [];

  for (let startedAtMs = windowStartMs; startedAtMs < input.nowMs; startedAtMs += bucketMs) {
    const endedAtMs = Math.min(input.nowMs, startedAtMs + bucketMs);
    const bucketSamples = input.samples.filter(
      (sample) =>
        sample.sampledAtMs >= startedAtMs &&
        (endedAtMs === input.nowMs
          ? sample.sampledAtMs <= endedAtMs
          : sample.sampledAtMs < endedAtMs),
    );
    const samplesByRead = new Map<number, ProcessResourceSample[]>();
    for (const sample of bucketSamples) {
      const samplesAtTime = samplesByRead.get(sample.sampledAtMs) ?? [];
      samplesAtTime.push(sample);
      samplesByRead.set(sample.sampledAtMs, samplesAtTime);
    }

    const readTotals = [...samplesByRead.values()].map((samplesAtTime) => ({
      cpuPercent: samplesAtTime.reduce((total, sample) => total + sample.cpuPercent, 0),
      rssBytes: samplesAtTime.reduce((total, sample) => total + sample.rssBytes, 0),
      processCount: samplesAtTime.length,
    }));
    const avgCpuPercent =
      readTotals.length === 0
        ? 0
        : readTotals.reduce((total, read) => total + read.cpuPercent, 0) / readTotals.length;

    buckets.push({
      startedAt: dateTimeFromMillis(startedAtMs),
      endedAt: dateTimeFromMillis(endedAtMs),
      avgCpuPercent,
      maxCpuPercent: readTotals.length ? Math.max(...readTotals.map((read) => read.cpuPercent)) : 0,
      maxRssBytes: readTotals.length ? Math.max(...readTotals.map((read) => read.rssBytes)) : 0,
      maxProcessCount: readTotals.length
        ? Math.max(...readTotals.map((read) => read.processCount))
        : 0,
    });
  }

  return buckets;
}

export function aggregateProcessResourceHistory(input: {
  readonly samples: ReadonlyArray<ProcessResourceSample>;
  readonly readAt: DateTime.Utc;
  readonly readAtMs: number;
  readonly windowMs: number;
  readonly bucketMs: number;
  readonly lastFailure: ProcessResourceSamplingError | null;
}): ServerProcessResourceHistoryResult {
  const windowMs = Math.max(1_000, input.windowMs);
  const bucketMs = Math.max(1_000, input.bucketMs);
  const minSampledAtMs = input.readAtMs - windowMs;
  const samples = input.samples.filter((sample) => sample.sampledAtMs >= minSampledAtMs);
  const topProcesses = summarizeProcesses(samples);
  const totalCpuSecondsApprox = samples.reduce(
    (total, sample) => total + (sample.cpuPercent / 100) * (SAMPLE_INTERVAL_MS / 1_000),
    0,
  );

  return {
    readAt: input.readAt,
    windowMs,
    bucketMs,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    retainedSampleCount: input.samples.length,
    totalCpuSecondsApprox,
    buckets: buildBuckets({ samples, nowMs: input.readAtMs, windowMs, bucketMs }),
    topProcesses,
    error: input.lastFailure
      ? Option.some({
          failureTag: input.lastFailure.failureTag,
          message: input.lastFailure.message,
        })
      : Option.none(),
  };
}

export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const state = yield* Ref.make<MonitorState>({ samples: [], lastFailure: null });

  const recordSamplingFailure = (cause: {
    readonly _tag: ServerProcessResourceHistoryFailureTagType;
  }) =>
    Ref.update(state, (current) => ({
      ...current,
      lastFailure: new ProcessResourceSamplingError({
        failureTag: cause._tag,
        cause,
      }),
    }));

  const sampleOnce = Effect.gen(function* () {
    const sampledAt = yield* DateTime.now;
    const sampledAtMs = DateTime.toEpochMillis(sampledAt);
    const rows = yield* ProcessDiagnostics.readProcessRows.pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const samples = collectMonitoredSamples({
      rows,
      serverPid: process.pid,
      sampledAt,
      sampledAtMs,
    });
    yield* Ref.update(state, (current) => ({
      samples: trimSamples([...current.samples, ...samples], sampledAtMs),
      lastFailure: null,
    }));
  }).pipe(
    Effect.catchTags({
      ProcessDiagnosticsQueryTimeoutError: recordSamplingFailure,
      ProcessDiagnosticsQueryFailedError: recordSamplingFailure,
      ProcessDiagnosticsServerProcessSignalError: recordSamplingFailure,
      ProcessDiagnosticsNotDescendantError: recordSamplingFailure,
      ProcessDiagnosticsSignalFailedError: recordSamplingFailure,
    }),
  );

  yield* Effect.forever(sampleOnce.pipe(Effect.andThen(Effect.sleep(SAMPLE_INTERVAL_MS)))).pipe(
    Effect.forkScoped,
  );

  const readHistory: ProcessResourceMonitor["Service"]["readHistory"] = (input) =>
    Effect.gen(function* () {
      const readAt = yield* DateTime.now;
      const readAtMs = DateTime.toEpochMillis(readAt);
      const current = yield* Ref.get(state);
      return aggregateProcessResourceHistory({
        samples: current.samples,
        readAt,
        readAtMs,
        windowMs: input.windowMs,
        bucketMs: input.bucketMs,
        lastFailure: current.lastFailure,
      });
    });

  const recentActivityFor: ProcessResourceMonitor["Service"]["recentActivityFor"] = (marker) =>
    Effect.gen(function* () {
      const nowMs = yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
      const current = yield* Ref.get(state);
      return recentProcessTreeActivity({
        samples: current.samples,
        marker,
        nowMs,
        windowMs: PROCESS_TREE_ACTIVITY_WINDOW_MS,
      });
    });

  return ProcessResourceMonitor.of({ readHistory, recentActivityFor });
});

export const layer = Layer.effect(ProcessResourceMonitor, make);
