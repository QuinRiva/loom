import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { accountUsageTone, formatAccountUsageReset } from "./accountUsage.ts";

const NOW = Date.parse("2026-06-29T12:00:00.000Z");
const iso = (msFromNow: number) => DateTime.formatIso(DateTime.makeUnsafe(NOW + msFromNow));

describe("accountUsageTone", () => {
  it("escalates quiet → warning (≥80) → destructive (≥100)", () => {
    expect(accountUsageTone(0)).toBe("quiet");
    expect(accountUsageTone(79.9)).toBe("quiet");
    expect(accountUsageTone(80)).toBe("warning");
    expect(accountUsageTone(99)).toBe("warning");
    expect(accountUsageTone(100)).toBe("destructive");
  });
});

describe("formatAccountUsageReset", () => {
  it("formats days/hours/minutes and handles edges", () => {
    expect(formatAccountUsageReset(iso(2 * 3_600_000 + 14 * 60_000), NOW)).toBe("resets in 2h 14m");
    expect(formatAccountUsageReset(iso(45 * 60_000), NOW)).toBe("resets in 45m");
    expect(formatAccountUsageReset(iso(6 * 86_400_000 + 3 * 3_600_000), NOW)).toBe(
      "resets in 6d 3h",
    );
    expect(formatAccountUsageReset(iso(30_000), NOW)).toBe("resets in <1m");
    expect(formatAccountUsageReset(iso(-1_000), NOW)).toBeNull();
    expect(formatAccountUsageReset(null, NOW)).toBeNull();
    expect(formatAccountUsageReset("not-a-date", NOW)).toBeNull();
  });
});
