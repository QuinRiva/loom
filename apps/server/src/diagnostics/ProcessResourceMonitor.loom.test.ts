import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ProcessResourceMonitor from "./ProcessResourceMonitor.ts";

describe("ProcessResourceMonitor (loom)", () => {
  // loom: trailing-window subtree activity backs the live-subtree settle blocker.
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
