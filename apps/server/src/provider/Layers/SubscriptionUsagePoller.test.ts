import { decodeUsageWindowId } from "@t3tools/shared/usageWindowId";
import { describe, expect, it } from "vite-plus/test";

import type { AccountUsageWindow } from "../accountUsage.loom.ts";
import { applyUsageLimitsUpdate } from "../providerUsageLimits.ts";
import { toLimitsWindows } from "./SubscriptionUsagePoller.ts";

const windows: ReadonlyArray<AccountUsageWindow> = [
  {
    kind: "primary",
    usedPercent: 41.2,
    resetsAt: "2026-09-21T12:00:00.000Z",
    windowDurationMins: 300,
  },
  {
    kind: "secondary",
    usedPercent: 100,
    resetsAt: null,
    windowDurationMins: null,
    scope: { displayName: "Opus" },
  },
];

describe("toLimitsWindows", () => {
  it("gives every pooled account of one instance its own window ids", () => {
    const pooled = ["carl@", "caaarl@", "carl3@", "carl4@", "jacob@"].flatMap((accountLabel) =>
      toLimitsWindows({ accountKey: "pi", accountLabel }, accountLabel, windows),
    );
    expect(new Set(pooled.map((w) => w.id)).size).toBe(10);
    // Upstream merges by id; the failover card reads the account back off it.
    expect(decodeUsageWindowId(pooled[0]!.id)).toEqual({
      accountKey: "pi",
      accountLabel: "carl@",
      kind: "primary",
    });
  });

  it("settles after one poll: a repeat reading republishes nothing and drops no account", () => {
    const accounts = ["carl@", "caaarl@", "carl3@", "carl4@", "jacob@"];
    const poll = (previous: ReturnType<typeof applyUsageLimitsUpdate>) =>
      accounts.reduce(
        (limits, accountLabel) =>
          applyUsageLimitsUpdate({
            previous: limits,
            update: {
              windows: toLimitsWindows({ accountKey: "pi", accountLabel }, accountLabel, windows),
            },
            checkedAt: "2026-09-21T10:00:00.000Z",
          }),
        previous,
      );
    const first = poll(undefined);
    expect(first?.windows).toHaveLength(accounts.length * windows.length);
    // Same object back ⇒ makeManagedServerProvider skips the publish.
    expect(poll(first)).toBe(first);
  });

  it("maps loom's window shape onto upstream's", () => {
    expect(toLimitsWindows({ accountKey: "codex" }, "Codex", windows)).toEqual([
      {
        id: "codex::primary",
        kind: "session",
        label: "Codex 5-hour",
        usedPercent: 41.2,
        resetsAt: "2026-09-21T12:00:00.000Z",
        windowDurationMins: 300,
      },
      { id: "codex::secondary:Opus", kind: "weekly", label: "Codex Opus weekly", usedPercent: 100 },
    ]);
  });
});
