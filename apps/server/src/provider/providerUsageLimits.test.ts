import { describe, expect, it } from "vite-plus/test";

import {
  applyUsageLimitsUpdate,
  removeUsageLimitWindows,
  resolveUsageLimitsAfterProbe,
} from "./providerUsageLimits.ts";

const checkedAt = "2026-09-03T12:00:00.000Z";
const session = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;
const weekly = {
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 20,
  windowDurationMins: 10_080,
} as const;
const published = { checkedAt, windows: [session, weekly] };

describe("applyUsageLimitsUpdate", () => {
  it("returns the published object itself when no window moved", () => {
    // Codex repeats the same numbers beside every token-usage tick; the
    // ingestion path relies on identity to skip the publish.
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: {
        windows: [
          { ...weekly },
          { id: "five_hour", kind: "session", label: "Session", usedPercent: 40 },
        ],
      },
    });
    expect(next).toBe(published);
  });

  it("upserts by id and keeps the reset a percent-only update omits", () => {
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: {
        windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 55 }],
      },
    });
    expect(next).not.toBe(published);
    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [{ ...session, usedPercent: 55 }, weekly],
    });
  });

  it("leaves an unsupported account and an empty update alone", () => {
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    expect(
      applyUsageLimitsUpdate({ previous: unsupported, checkedAt, update: { windows: [session] } }),
    ).toBe(unsupported);
    expect(
      applyUsageLimitsUpdate({ previous: published, checkedAt, update: { windows: [] } }),
    ).toBe(published);
  });

  it("preserves reset credits when a streamed window update changes usage", () => {
    const resetCredits = { availableCount: 2, nextExpiresAt: "2026-10-01T00:00:00.000Z" };
    const next = applyUsageLimitsUpdate({
      previous: { ...published, resetCredits },
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: { windows: [{ ...session, usedPercent: 55 }] },
    });

    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [{ ...session, usedPercent: 55 }, weekly],
      resetCredits,
    });
  });
});

describe("resolveUsageLimitsAfterProbe", () => {
  it("keeps the last good windows through a failed probe but not an unsupported one", () => {
    const failed = { checkedAt, windows: [], unavailable: { reason: "probeFailed" as const } };
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    expect(resolveUsageLimitsAfterProbe({ published, probed: failed })).toBe(published);
    expect(resolveUsageLimitsAfterProbe({ published, probed: unsupported })).toBe(unsupported);
    expect(resolveUsageLimitsAfterProbe({ published: undefined, probed: failed })).toBe(failed);
  });

  // loom: pi's probe carries no limits at all — the subscription-usage poller
  // is its only feeder — so a re-probe must not blank what it published.
  it("keeps published windows through a probe that reports no limits, unless signed out", () => {
    expect(resolveUsageLimitsAfterProbe({ published, probed: undefined })).toBe(published);
    expect(
      resolveUsageLimitsAfterProbe({
        published,
        probed: undefined,
        probedAuthStatus: "unknown",
      }),
    ).toBe(published);
    expect(
      resolveUsageLimitsAfterProbe({
        published,
        probed: undefined,
        probedAuthStatus: "unauthenticated",
      }),
    ).toBeUndefined();
  });
});

// loom: the only path that takes a window off a card — see the stand-down when
// a cliproxy hub takes over Claude quota.
describe("removeUsageLimitWindows", () => {
  const claude = { checkedAt, windows: [{ ...session, id: "claudeAgent::primary" }, weekly] };

  it("drops an account's whole set and leaves the rest of the card alone", () => {
    expect(
      removeUsageLimitWindows({
        previous: claude,
        accountPrefixes: ["claudeAgent::"],
        checkedAt,
      })?.windows,
    ).toEqual([weekly]);
  });

  it("returns the published object itself when no account matched, so nothing republishes", () => {
    expect(
      removeUsageLimitWindows({ previous: claude, accountPrefixes: ["codex::"], checkedAt }),
    ).toBe(claude);
    expect(
      removeUsageLimitWindows({ previous: undefined, accountPrefixes: ["codex::"], checkedAt }),
    ).toBeUndefined();
  });
});
