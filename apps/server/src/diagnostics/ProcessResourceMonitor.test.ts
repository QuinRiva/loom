import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ProcessResourceMonitor from "./ProcessResourceMonitor.ts";

describe("ProcessResourceMonitor", () => {
  it.effect("samples the server root process and descendants", () =>
    Effect.sync(() => {
      const sampledAt = DateTime.makeUnsafe("2026-05-05T10:00:00.000Z");
      const samples = ProcessResourceMonitor.collectMonitoredSamples({
        serverPid: 100,
        sampledAt,
        sampledAtMs: DateTime.toEpochMillis(sampledAt),
        rows: [
          {
            pid: 100,
            ppid: 1,
            pgid: 100,
            status: "S",
            cpuPercent: 2,
            rssBytes: 1_000,
            elapsed: "01:00",
            command: "t3 server",
          },
          {
            pid: 101,
            ppid: 100,
            pgid: 100,
            status: "S",
            cpuPercent: 10,
            rssBytes: 2_000,
            elapsed: "00:20",
            command: "codex app-server",
          },
          {
            pid: 102,
            ppid: 101,
            pgid: 100,
            status: "R",
            cpuPercent: 50,
            rssBytes: 3_000,
            elapsed: "00:05",
            command: "rg needle",
          },
          {
            pid: 200,
            ppid: 1,
            pgid: 200,
            status: "R",
            cpuPercent: 99,
            rssBytes: 9_000,
            elapsed: "00:05",
            command: "unrelated",
          },
        ],
      });

      expect(samples.map((sample) => sample.pid)).toEqual([100, 101, 102]);
      expect(samples.map((sample) => sample.depth)).toEqual([0, 1, 2]);
      expect(samples[0]?.isServerRoot).toBe(true);
      expect(samples[1]?.isServerRoot).toBe(false);
    }),
  );

  it.effect("rolls samples up by process and CPU time", () =>
    Effect.sync(() => {
      const firstAt = DateTime.makeUnsafe("2026-05-05T10:00:00.000Z");
      const secondAt = DateTime.makeUnsafe("2026-05-05T10:00:05.000Z");
      const samples = [
        ...ProcessResourceMonitor.collectMonitoredSamples({
          serverPid: 100,
          sampledAt: firstAt,
          sampledAtMs: DateTime.toEpochMillis(firstAt),
          rows: [
            {
              pid: 100,
              ppid: 1,
              pgid: 100,
              status: "S",
              cpuPercent: 10,
              rssBytes: 1_000,
              elapsed: "01:00",
              command: "t3 server",
            },
          ],
        }),
        ...ProcessResourceMonitor.collectMonitoredSamples({
          serverPid: 100,
          sampledAt: secondAt,
          sampledAtMs: DateTime.toEpochMillis(secondAt),
          rows: [
            {
              pid: 100,
              ppid: 1,
              pgid: 100,
              status: "S",
              cpuPercent: 30,
              rssBytes: 2_000,
              elapsed: "01:05",
              command: "t3 server",
            },
          ],
        }),
      ];

      const result = ProcessResourceMonitor.aggregateProcessResourceHistory({
        samples,
        readAt: secondAt,
        readAtMs: DateTime.toEpochMillis(secondAt),
        windowMs: 60_000,
        bucketMs: 10_000,
        lastFailure: null,
      });

      expect(Option.isNone(result.error)).toBe(true);
      expect(result.topProcesses).toHaveLength(1);
      expect(result.topProcesses[0]?.avgCpuPercent).toBe(20);
      expect(result.topProcesses[0]?.maxCpuPercent).toBe(30);
      expect(result.topProcesses[0]?.cpuSecondsApprox).toBe(2);
      expect(result.totalCpuSecondsApprox).toBe(2);
      expect(result.buckets.some((bucket) => bucket.maxCpuPercent === 30)).toBe(true);
    }),
  );

  it.effect("keeps a process grouped when elapsed time drifts between samples", () =>
    Effect.sync(() => {
      const firstAt = DateTime.makeUnsafe("2026-05-05T10:00:00.400Z");
      const secondAt = DateTime.makeUnsafe("2026-05-05T10:00:05.900Z");
      const samples = [
        ...ProcessResourceMonitor.collectMonitoredSamples({
          serverPid: 100,
          sampledAt: firstAt,
          sampledAtMs: DateTime.toEpochMillis(firstAt),
          rows: [
            {
              pid: 100,
              ppid: 1,
              pgid: 100,
              status: "S",
              cpuPercent: 1,
              rssBytes: 1_000,
              elapsed: "01:00",
              command: "t3 server",
            },
          ],
        }),
        ...ProcessResourceMonitor.collectMonitoredSamples({
          serverPid: 100,
          sampledAt: secondAt,
          sampledAtMs: DateTime.toEpochMillis(secondAt),
          rows: [
            {
              pid: 100,
              ppid: 1,
              pgid: 100,
              status: "S",
              cpuPercent: 2,
              rssBytes: 2_000,
              elapsed: "01:06",
              command: "t3 server",
            },
          ],
        }),
      ];

      const result = ProcessResourceMonitor.aggregateProcessResourceHistory({
        samples,
        readAt: secondAt,
        readAtMs: DateTime.toEpochMillis(secondAt),
        windowMs: 60_000,
        bucketMs: 10_000,
        lastFailure: null,
      });

      expect(result.topProcesses).toHaveLength(1);
      expect(result.topProcesses[0]?.isServerRoot).toBe(true);
      expect(result.topProcesses[0]?.sampleCount).toBe(2);
      expect(result.topProcesses[0]?.maxRssBytes).toBe(2_000);
    }),
  );

  it.effect("returns all process summaries in the selected window", () =>
    Effect.sync(() => {
      const sampledAt = DateTime.makeUnsafe("2026-05-05T10:00:00.000Z");
      const samples = ProcessResourceMonitor.collectMonitoredSamples({
        serverPid: 100,
        sampledAt,
        sampledAtMs: DateTime.toEpochMillis(sampledAt),
        rows: [
          {
            pid: 100,
            ppid: 1,
            pgid: 100,
            status: "S",
            cpuPercent: 1,
            rssBytes: 1_000,
            elapsed: "01:00",
            command: "t3 server",
          },
          ...Array.from({ length: 35 }, (_, index) => ({
            pid: 200 + index,
            ppid: index === 0 ? 100 : 199 + index,
            pgid: 100,
            status: "S",
            cpuPercent: 35 - index,
            rssBytes: 2_000 + index,
            elapsed: "00:10",
            command: `worker ${index}`,
          })),
        ],
      });

      const result = ProcessResourceMonitor.aggregateProcessResourceHistory({
        samples,
        readAt: sampledAt,
        readAtMs: DateTime.toEpochMillis(sampledAt),
        windowMs: 60_000,
        bucketMs: 10_000,
        lastFailure: null,
      });

      expect(result.topProcesses).toHaveLength(36);
      expect(result.topProcesses.some((process) => process.command === "worker 34")).toBe(true);
    }),
  );

  it.effect("exposes bounded failure diagnostics while retaining the exact cause", () =>
    Effect.sync(() => {
      const readAt = DateTime.makeUnsafe("2026-05-05T10:00:00.000Z");
      const cause = new Error("stderr included credential=secret-value");
      const failure = new ProcessResourceMonitor.ProcessResourceSamplingError({
        failureTag: "ProcessDiagnosticsQueryFailedError",
        cause,
      });

      const result = ProcessResourceMonitor.aggregateProcessResourceHistory({
        samples: [],
        readAt,
        readAtMs: DateTime.toEpochMillis(readAt),
        windowMs: 60_000,
        bucketMs: 10_000,
        lastFailure: failure,
      });

      expect(failure.cause).toBe(cause);
      expect(Option.getOrThrow(result.error)).toEqual({
        failureTag: "ProcessDiagnosticsQueryFailedError",
        message: "Failed to sample process resources (ProcessDiagnosticsQueryFailedError).",
      });
      expect(Option.getOrThrow(result.error).message).not.toContain("secret-value");
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
