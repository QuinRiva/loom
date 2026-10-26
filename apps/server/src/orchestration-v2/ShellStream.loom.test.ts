import { describe, expect, it } from "@effect/vitest";
import type { LoomThreadShellFields, OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { omitIdleSubagentShells, omitOlderSettledShells } from "./ShellStream.ts";

// Doc 38 §6.2 / DL-1404: Loom's rollup reads descendants a cold shell would otherwise omit.
const DAY = 24 * 60 * 60 * 1000;

const row = (
  id: string,
  parent: string | null,
  root: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
  workstream: Partial<LoomThreadShellFields> | null = {},
) =>
  ({
    id: ThreadId.make(id),
    projectId: "project",
    archivedAt: null,
    status: "completed",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    lastErrorClass: null,
    settledOverride: null,
    settledAt: null,
    lineage: {
      parentThreadId: parent === null ? null : ThreadId.make(parent),
      relationshipToParent: parent === null ? null : "subagent",
      rootThreadId: ThreadId.make(root),
    },
    ...(workstream === null
      ? {}
      : {
          workstream: {
            parentThreadId: parent === null ? null : ThreadId.make(parent),
            attention: [],
            outcome: "done",
            kickoffAt: "2026-10-01T00:00:00.000Z",
            held: false,
            ...workstream,
          },
        }),
    ...overrides,
  }) as unknown as OrchestrationV2ThreadShell;

const settled = { settledOverride: "settled", settledAt: DateTime.makeUnsafe(50 * DAY) } as const;

describe("cold shell keeps what Loom's rollup reads", () => {
  it("keeps every Loom child of a live root, and only flagged ones under a settled root", () => {
    const threads = [
      row("live-root", null, "live-root"),
      row("live-done", "live-root", "live-root"),
      row("live-upstream-subagent", "live-root", "live-root", {}, null),
      row("settled-root", null, "settled-root", settled),
      row("settled-done", "settled-root", "settled-root"),
      row("settled-flagged", "settled-root", "settled-root", {}, { attention: ["needs_guidance"] }),
      row(
        "settled-failed",
        "settled-root",
        "settled-root",
        { status: "failed", lastErrorClass: "provider_error" as never },
        { outcome: null },
      ),
      row(
        "settled-unbriefed",
        "settled-root",
        "settled-root",
        {},
        { outcome: null, kickoffAt: null },
      ),
      row("archived-root", null, "archived-root", { archivedAt: DateTime.makeUnsafe(0) }),
      row("archived-done", "archived-root", "archived-root"),
    ];
    expect(omitIdleSubagentShells(threads).map((thread) => thread.id)).toEqual([
      "live-root",
      "live-done",
      "settled-root",
      "settled-flagged",
      "settled-failed",
      "settled-unbriefed",
      "archived-root",
    ]);
  });

  it("keeps an older settled root that carries a flag, and still counts it", () => {
    const newest = Array.from({ length: 25 }, (_, index) =>
      row(`new-${index}`, null, `new-${index}`, {
        settledOverride: "settled",
        settledAt: DateTime.makeUnsafe(90 * DAY + index),
      }),
    );
    const result = omitOlderSettledShells({
      threads: [
        ...newest,
        row("old-flagged", null, "old-flagged", settled, { attention: ["awaiting_acceptance"] }),
        row("old-plain", null, "old-plain", settled, { outcome: null, kickoffAt: null }),
      ],
      snapshotSequence: 1,
      now: DateTime.makeUnsafe(100 * DAY),
    });
    expect(result.threads.map((thread) => thread.id).slice(25)).toEqual(["old-flagged"]);
    expect(result.olderSettled.counts).toEqual([{ projectId: "project", count: 2 }]);
  });

  it("keeps an older settled root while its goal has an unsettled root", () => {
    const newest = Array.from({ length: 25 }, (_, index) =>
      row(`new-${index}`, null, `new-${index}`, {
        settledOverride: "settled",
        settledAt: DateTime.makeUnsafe(90 * DAY + index),
      }),
    );
    const goal = (goalId: string) => ({ goalId }) as Partial<LoomThreadShellFields>;
    const result = omitOlderSettledShells({
      threads: [
        ...newest,
        row("live-goal-root", null, "live-goal-root", {}, goal("live")),
        row("old-live-goal", null, "old-live-goal", settled, goal("live")),
        row("old-settled-goal", null, "old-settled-goal", settled, goal("settled")),
        row("old-settled-goal-2", null, "old-settled-goal-2", settled, goal("settled")),
      ],
      snapshotSequence: 1,
      now: DateTime.makeUnsafe(100 * DAY),
    });
    expect(result.threads.map((thread) => thread.id).slice(25)).toEqual([
      "live-goal-root",
      "old-live-goal",
    ]);
  });
});
