import { collectLimitPools, type LimitAccount } from "@t3tools/shared/usageLimits";
import { ProviderDriverKind, type ServerProviderUsageWindow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { headlinePoolWindow, meterTone, poolTone, splitLoomPiAccount } from "./subscriptionMeter";

const CHECKED_AT = "2026-09-22T10:00:00.000Z";
const NOW = Date.parse(CHECKED_AT);

function window(
  id: string,
  usedPercent: number,
  kind: ServerProviderUsageWindow["kind"] = "session",
): ServerProviderUsageWindow {
  return { id, kind, label: `${id} label`, usedPercent, windowDurationMins: 300 };
}

function account(
  over: Partial<LimitAccount> & { readonly windows: readonly ServerProviderUsageWindow[] },
): LimitAccount {
  const { windows, ...rest } = over;
  return {
    key: "env:pi",
    driver: ProviderDriverKind.make("pi"),
    displayName: null,
    email: undefined,
    plan: undefined,
    accentColor: undefined,
    environments: [],
    sourceLabel: null,
    redeem: null,
    limits: { checkedAt: CHECKED_AT, windows },
    ...rest,
  };
}

describe("splitLoomPiAccount", () => {
  it("splits the pi instance's windows into one account per encoded account, keyed by driver", () => {
    const split = splitLoomPiAccount(
      account({
        windows: [
          window("claudeAgent::primary", 62),
          window("claudeAgent::secondary", 38, "weekly"),
          window("codex::primary", 12),
          window("codex::secondary", 4, "weekly"),
        ],
      }),
    );

    expect(split.map((entry) => entry.driver)).toEqual(["claudeAgent", "codex"]);
    // Account-independent ids, so sibling accounts pool.
    expect(split.map((entry) => entry.limits.windows.map((w) => w.id))).toEqual([
      ["primary", "secondary"],
      ["primary", "secondary"],
    ]);
    expect(split.map((entry) => entry.key)).toEqual(["pi:claudeAgent:", "pi:codex:"]);
  });

  it("keeps a scoped carve-out distinct from its account-wide window", () => {
    const [claude] = splitLoomPiAccount(
      account({
        windows: [
          window("claudeAgent::secondary", 38, "weekly"),
          window("claudeAgent::secondary:Fable", 91, "weekly"),
        ],
      }),
    );

    expect(claude?.limits.windows.map((w) => w.id)).toEqual(["secondary", "secondary:Fable"]);
  });

  it("names a pooled account from its label and leaves its driver as pi", () => {
    const split = splitLoomPiAccount(
      account({
        windows: [window("pi-main:carl3:primary", 70), window("pi-main:caaarl:primary", 30)],
      }),
    );

    expect(split.map((entry) => entry.displayName)).toEqual(["carl3", "caaarl"]);
    expect(split.every((entry) => entry.driver === "pi")).toBe(true);
  });

  it("passes hub and native accounts through untouched, and drops natively emitted windows", () => {
    const hub = account({
      key: "cliproxy:carl3.json",
      driver: ProviderDriverKind.make("claudeAgent"),
      email: "carl3@example.com",
      windows: [window("five_hour", 74)],
    });
    expect(splitLoomPiAccount(hub)).toEqual([hub]);

    // A window an adapter emitted natively does not decode, so it is not an account row.
    expect(splitLoomPiAccount(account({ windows: [window("five_hour", 74)] }))).toEqual([]);
  });

  it("pools the split accounts with the hub accounts that report the same window", () => {
    const hubAccount = (id: string, usedPercent: number) =>
      account({
        key: `cliproxy:${id}`,
        driver: ProviderDriverKind.make("claudeAgent"),
        email: `${id}@example.com`,
        windows: [window("five_hour", usedPercent)],
      });
    const accounts = [
      ...splitLoomPiAccount(account({ windows: [window("codex::primary", 12)] })),
      hubAccount("carl3", 90),
      hubAccount("caaarl", 50),
    ];

    const pools = collectLimitPools(accounts, NOW);
    const claude = pools.find((pool) => pool.driver === "claudeAgent");
    expect(claude?.windows).toHaveLength(1);
    expect(claude?.windows[0]?.members).toHaveLength(2);
    expect(headlinePoolWindow(claude!)?.usedPercent).toBe(70);
    expect(headlinePoolWindow(pools.find((pool) => pool.driver === "codex")!)?.usedPercent).toBe(
      12,
    );
  });
});

describe("tone", () => {
  it("is quiet below 80, warning from 80, destructive from 100", () => {
    expect([0, 79.9, 80, 99, 100].map(meterTone)).toEqual([
      "quiet",
      "quiet",
      "warning",
      "warning",
      "destructive",
    ]);
  });

  it("follows the loudest window, not the headline one", () => {
    const [claude] = collectLimitPools(
      splitLoomPiAccount(
        account({
          windows: [
            window("claudeAgent::primary", 20),
            window("claudeAgent::secondary:Fable", 100, "weekly"),
          ],
        }),
      ),
      NOW,
    );

    expect(headlinePoolWindow(claude!)?.usedPercent).toBe(20);
    expect(poolTone(claude!)).toBe("destructive");
  });
});
