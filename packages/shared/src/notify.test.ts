import { describe, expect, it } from "vite-plus/test";

import {
  appendPrunedNotifySendLog,
  NOTIFY_PAIR_HOURLY_CAP,
  notifyDeliverCommandId,
  notifyExpireCommandId,
  notifyMarkCommandId,
  notifyPairCapExceeded,
  notifyPairWindowCount,
} from "./notify.ts";

// Fixed timeline (no wall-clock access): NOW is noon; "recent" is within the
// one-hour window, "stale" is 1.5h earlier (outside it).
const NOW = "2026-01-01T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const RECENT = "2026-01-01T11:59:00.000Z";
const STALE = "2026-01-01T10:30:00.000Z";
const entry = (targetThreadId: string, at: string) => ({ targetThreadId, at });

describe("notifyPairWindowCount", () => {
  it("counts only in-window entries for the given target", () => {
    const log = [entry("a", RECENT), entry("a", RECENT), entry("b", RECENT), entry("a", STALE)];
    expect(notifyPairWindowCount(log, "a", NOW_MS)).toBe(2);
    expect(notifyPairWindowCount(log, "b", NOW_MS)).toBe(1);
    expect(notifyPairWindowCount(log, "c", NOW_MS)).toBe(0);
  });
});

describe("notifyPairCapExceeded", () => {
  it("is false below the cap and true at/above it", () => {
    const under = Array.from({ length: NOTIFY_PAIR_HOURLY_CAP - 1 }, () => entry("a", RECENT));
    expect(notifyPairCapExceeded(under, "a", NOW_MS)).toBe(false);
    const atCap = Array.from({ length: NOTIFY_PAIR_HOURLY_CAP }, () => entry("a", RECENT));
    expect(notifyPairCapExceeded(atCap, "a", NOW_MS)).toBe(true);
  });

  it("ignores stale entries", () => {
    const stale = Array.from({ length: NOTIFY_PAIR_HOURLY_CAP + 5 }, () => entry("a", STALE));
    expect(notifyPairCapExceeded(stale, "a", NOW_MS)).toBe(false);
  });
});

describe("appendPrunedNotifySendLog", () => {
  it("appends the new entry and prunes stale ones", () => {
    const log = [entry("a", STALE), entry("a", RECENT)];
    const next = appendPrunedNotifySendLog(log, entry("b", NOW), NOW_MS);
    expect(next.map((e) => e.targetThreadId)).toEqual(["a", "b"]);
  });
});

describe("notify command id helpers", () => {
  it("derive distinct deterministic ids from a record id", () => {
    expect(notifyDeliverCommandId("r1")).toBe("server:notify-deliver:r1");
    expect(notifyMarkCommandId("r1")).toBe("server:notify-mark:r1");
    expect(notifyExpireCommandId("r1")).toBe("server:notify-expire:r1");
  });
});
