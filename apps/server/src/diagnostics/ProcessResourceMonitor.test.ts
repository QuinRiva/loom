import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ResourceTelemetry from "../resourceTelemetry/ResourceTelemetry.ts";
import type { ResourceTelemetryHistoryWithLegacyBuckets } from "../resourceTelemetry/ResourceTelemetryHistory.ts";
import * as ProcessResourceMonitor from "./ProcessResourceMonitor.ts";

describe("ProcessResourceMonitor", () => {
  it.effect("projects resource telemetry history into the legacy diagnostics contract", () =>
    Effect.gen(function* () {
      const readAt = DateTime.makeUnsafe("2026-05-05T10:00:00.000Z");
      const history: ResourceTelemetryHistoryWithLegacyBuckets = {
        readAt,
        windowMs: 60_000,
        bucketMs: 10_000,
        sampleIntervalMs: 1_000,
        retainedSampleCount: 2,
        buckets: [
          {
            startedAt: DateTime.makeUnsafe("2026-05-05T09:59:50.000Z"),
            endedAt: readAt,
            avgCpuPercent: 15,
            maxCpuPercent: 25,
            maxRssBytes: 4_096,
            ioReadBytes: 1_024,
            ioWriteBytes: 2_048,
            maxProcessCount: 2,
          },
        ],
        legacyBackendBuckets: [
          {
            startedAt: DateTime.makeUnsafe("2026-05-05T09:59:50.000Z"),
            endedAt: readAt,
            avgCpuPercent: 5,
            maxCpuPercent: 8,
            maxRssBytes: 4_096,
            ioReadBytes: 1_024,
            ioWriteBytes: 2_048,
            maxProcessCount: 1,
          },
        ],
        topProcesses: [
          {
            identity: { pid: process.pid, startTimeMs: 100 },
            ppid: 1,
            depth: 0,
            name: "node",
            command: "t3 server",
            category: "server",
            firstSeenAt: DateTime.makeUnsafe("2026-05-05T09:59:55.000Z"),
            lastSeenAt: readAt,
            currentCpuPercent: 5,
            avgCpuPercent: 4,
            maxCpuPercent: 8,
            cpuTimeMs: 1_500,
            currentRssBytes: 2_048,
            peakRssBytes: 4_096,
            ioReadBytes: 1_024,
            ioWriteBytes: 2_048,
            ioSemantics: "storage",
            sampleCount: 2,
          },
          {
            identity: { pid: 5_000, startTimeMs: 200 },
            ppid: 1,
            depth: 0,
            name: "electron",
            command: "electron",
            category: "electron-main",
            firstSeenAt: DateTime.makeUnsafe("2026-05-05T09:59:55.000Z"),
            lastSeenAt: readAt,
            currentCpuPercent: 50,
            avgCpuPercent: 40,
            maxCpuPercent: 80,
            cpuTimeMs: 15_000,
            currentRssBytes: 20_480,
            peakRssBytes: 40_960,
            ioReadBytes: 10_240,
            ioWriteBytes: 20_480,
            ioSemantics: "storage",
            sampleCount: 2,
          },
        ],
        health: {
          native: {
            status: "degraded",
            lastSampleAt: Option.some(readAt),
            lastError: Option.some("collector stalled"),
          },
          desktop: {
            status: "healthy",
            lastSampleAt: Option.some(readAt),
            lastError: Option.none(),
          },
          sidecarVersion: Option.some("0.1.0"),
          sidecarPid: Option.some(9_000),
          restartCount: 1,
          collectionDurationMicros: 250,
          scannedProcessCount: 80,
          retainedProcessCount: 2,
          inaccessibleProcessCount: 0,
        },
      };
      const telemetry: ResourceTelemetry.ResourceTelemetry["Service"] = {
        latest: Effect.die("unused"),
        changes: Stream.empty,
        subscribe: Effect.die("unused"),
        readHistory: () => Effect.succeed(history),
        refresh: Effect.die("unused"),
        validateProcessIdentity: () => Effect.die("unused"),
        retry: Effect.die("unused"),
      };
      const layer = ProcessResourceMonitor.layer.pipe(
        Layer.provide(
          Layer.succeed(
            ResourceTelemetry.ResourceTelemetry,
            ResourceTelemetry.ResourceTelemetry.of(telemetry),
          ),
        ),
      );

      const result = yield* Effect.service(ProcessResourceMonitor.ProcessResourceMonitor).pipe(
        Effect.flatMap((monitor) =>
          monitor.readHistory({
            windowMs: 60_000,
            bucketMs: 10_000,
          }),
        ),
        Effect.provide(layer),
      );

      expect(result.totalCpuSecondsApprox).toBe(1.5);
      expect(result.topProcesses).toEqual([
        {
          processKey: `${process.pid}:100`,
          pid: process.pid,
          ppid: 1,
          command: "t3 server",
          depth: 0,
          isServerRoot: true,
          firstSeenAt: DateTime.makeUnsafe("2026-05-05T09:59:55.000Z"),
          lastSeenAt: readAt,
          currentCpuPercent: 5,
          avgCpuPercent: 4,
          maxCpuPercent: 8,
          cpuSecondsApprox: 1.5,
          currentRssBytes: 2_048,
          maxRssBytes: 4_096,
          sampleCount: 2,
        },
      ]);
      expect(result.buckets[0]).toMatchObject({
        avgCpuPercent: 5,
        maxCpuPercent: 8,
        maxRssBytes: 4_096,
        maxProcessCount: 1,
      });
      expect(result.error).toEqual(
        Option.some({
          failureTag: "ProcessDiagnosticsQueryFailedError",
          message: "collector stalled",
        }),
      );
    }),
  );

  describe("recentProcessTreeActivity (trailing-window health for a child subtree)", () => {
    const at = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));
    const sample = (over: Partial<ProcessResourceMonitor.ProcessResourceSample>) => {
      const sampledAtMs = over.sampledAtMs ?? at("2026-05-05T10:00:00.000Z");
      return {
        sampledAt: DateTime.makeUnsafe(sampledAtMs),
        sampledAtMs,
        processKey: `${over.pid ?? 0}:${over.command ?? ""}`,
        pid: 0,
        ppid: 0,
        command: "",
        cpuPercent: 0,
        rssBytes: 0,
        depth: 0,
        isServerRoot: false,
        ...over,
      } satisfies ProcessResourceMonitor.ProcessResourceSample;
    };
    const nowMs = at("2026-05-05T10:00:30.000Z");

    it.effect("reports a grinding subtree as active with its peak CPU", () =>
      Effect.sync(() => {
        const activity = ProcessResourceMonitor.recentProcessTreeActivity({
          nowMs,
          windowMs: 30_000,
          marker: "session-child-a",
          samples: [
            sample({ pid: 101, ppid: 100, command: "pi --mode rpc --session-id session-child-a" }),
            // A descendant (build/test process) doing the actual work.
            sample({ pid: 102, ppid: 101, command: "vitest run", cpuPercent: 87 }),
            // An unrelated sibling subtree must not count.
            sample({
              pid: 201,
              ppid: 100,
              command: "pi --session-id session-other",
              cpuPercent: 99,
            }),
          ],
        });
        expect(activity).not.toBeNull();
        expect(activity?.active).toBe(true);
        expect(activity?.peakCpuPercent).toBe(87);
        expect(activity?.processCount).toBe(2);
      }),
    );

    it.effect("reports an idle subtree as not active (may be stuck)", () =>
      Effect.sync(() => {
        const activity = ProcessResourceMonitor.recentProcessTreeActivity({
          nowMs,
          windowMs: 30_000,
          marker: "session-child-a",
          samples: [
            sample({
              pid: 101,
              ppid: 100,
              command: "pi --session-id session-child-a",
              cpuPercent: 0,
            }),
            sample({ pid: 102, ppid: 101, command: "grep -r needle /", cpuPercent: 0 }),
          ],
        });
        expect(activity?.active).toBe(false);
        expect(activity?.peakCpuPercent).toBe(0);
      }),
    );

    it.effect("returns null when nothing local matches (remote/exited/no samples)", () =>
      Effect.sync(() => {
        expect(
          ProcessResourceMonitor.recentProcessTreeActivity({
            nowMs,
            windowMs: 30_000,
            marker: "session-child-a",
            samples: [],
          }),
        ).toBeNull();
        expect(
          ProcessResourceMonitor.recentProcessTreeActivity({
            nowMs,
            windowMs: 30_000,
            marker: "session-child-a",
            samples: [sample({ pid: 201, ppid: 100, command: "pi --session-id session-other" })],
          }),
        ).toBeNull();
      }),
    );

    it.effect("ignores samples older than the trailing window", () =>
      Effect.sync(() => {
        const activity = ProcessResourceMonitor.recentProcessTreeActivity({
          nowMs,
          windowMs: 30_000,
          marker: "session-child-a",
          samples: [
            // Stale high-CPU sample (90s ago) must not keep it "active".
            sample({
              pid: 101,
              ppid: 100,
              command: "pi --session-id session-child-a",
              cpuPercent: 95,
              sampledAtMs: at("2026-05-05T09:59:00.000Z"),
            }),
            // Recent, quiet.
            sample({
              pid: 101,
              ppid: 100,
              command: "pi --session-id session-child-a",
              cpuPercent: 0,
              sampledAtMs: at("2026-05-05T10:00:15.000Z"),
            }),
          ],
        });
        expect(activity?.active).toBe(false);
        expect(activity?.peakCpuPercent).toBe(0);
      }),
    );

    it.effect(
      "returns null when the marker root exited (in the window but absent from the latest read)",
      () =>
        Effect.sync(() => {
          const activity = ProcessResourceMonitor.recentProcessTreeActivity({
            nowMs,
            windowMs: 30_000,
            marker: "session-child-a",
            samples: [
              // Older read (within the window): the child's process was alive
              // and grinding.
              sample({
                pid: 101,
                ppid: 100,
                command: "pi --session-id session-child-a",
                cpuPercent: 95,
                sampledAtMs: at("2026-05-05T10:00:10.000Z"),
              }),
              // Latest read (10:00:20): the child's process has EXITED — only an
              // unrelated process remains. A stale high-CPU sample must not keep
              // reporting activity; the measurement is gone, so degrade to null.
              sample({
                pid: 201,
                ppid: 100,
                command: "pi --session-id session-other",
                cpuPercent: 0,
                sampledAtMs: at("2026-05-05T10:00:20.000Z"),
              }),
            ],
          });
          expect(activity).toBeNull();
        }),
    );
  });
});
