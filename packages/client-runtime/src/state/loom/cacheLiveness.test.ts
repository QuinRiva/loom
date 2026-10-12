import { describe, expect, it } from "vite-plus/test";

import {
  cacheLiveness,
  cacheModelPrice,
  cacheStakeUsd,
  cacheWarmReadUsd,
  latestTouchMs,
} from "./cacheLiveness.ts";

const MIN = 60_000;
const NOW = Date.parse("2026-10-12T12:00:00.000Z");
const ago = (minutes: number) => NOW - minutes * MIN;

describe("cacheLiveness", () => {
  it.each([
    // [retention, minutes since touch, state, lit steps of total]
    ["long", 0, "warm", 12, 12],
    ["long", 21, "warm", 8, 12], // 39 min left → ceil(39/5)
    ["long", 49.5, "warm", 3, 12], // 10.5 min left
    ["long", 50, "expiring", 2, 12], // exactly 10 min left counts as expiring
    ["long", 59, "expiring", 1, 12],
    ["long", 60, "cold", 0, 12],
    ["long", 300, "cold", 0, 12],
    ["short", 0, "expiring", 5, 5], // a 5-minute cache is all inside the last 10 minutes
    ["short", 2.5, "expiring", 3, 5],
    ["short", 5, "cold", 0, 5],
  ] as const)("%s cache touched %s min ago is %s", (retention, minutes, state, lit, steps) => {
    const liveness = cacheLiveness(NOW, ago(minutes), retention);
    expect(liveness).toMatchObject({ state, litSteps: lit, steps, retention });
  });

  it("reports when it expires and, once cold, how long ago", () => {
    const cold = cacheLiveness(NOW, ago(75), "long");
    expect(cold.expiresAtMs).toBe(ago(15));
    expect(cold.remainingMs).toBe(-15 * MIN);
  });

  it.each(["long", "short"] as const)(
    "%s cache with no touch on record is unknown",
    (retention) => {
      expect(cacheLiveness(NOW, null, retention)).toMatchObject({
        state: "unknown",
        expiresAtMs: null,
        remainingMs: null,
        litSteps: 0,
      });
    },
  );
});

describe("latestTouchMs", () => {
  it("takes the latest of the run end, the snapshot touch and the live touch", () => {
    expect(latestTouchMs("2026-10-12T11:00:00.000Z", null, ago(3), undefined)).toBe(ago(3));
    expect(latestTouchMs("2026-10-12T11:30:00.000Z", "2026-10-12T11:10:00.000Z")).toBe(ago(30));
  });

  it("is null with nothing on record", () => {
    expect(latestTouchMs(null, undefined)).toBeNull();
  });
});

describe("cache stake", () => {
  it("resolves provider-prefixed and bare slugs; unpriced models get none", () => {
    expect(cacheModelPrice("cliproxy/claude-opus-5-5")?.label).toBe("Opus 5.5");
    expect(cacheModelPrice("claude-fable-5-1")?.label).toBe("Fable 5.1");
    expect(cacheModelPrice("anthropic-carl3/claude-opus-5")?.label).toBe("Opus 5");
    expect(cacheModelPrice("cliproxy/claude-sonnet-5")).toBeNull();
    expect(cacheModelPrice("openai-codex/gpt-6.1-sol")).toBeNull();
  });

  it("is the context re-written at the arm's write price minus its cached read", () => {
    const opus = cacheModelPrice("claude-opus-5-5")!;
    const fable = cacheModelPrice("claude-fable-5-1")!;
    // The recap's figure: an avoided 5-minute miss at 200k saves $0.96 on Opus 5.5, $2.45 on Fable 5.1.
    expect(cacheStakeUsd(200_000, opus, "short")).toBeCloseTo(0.96, 10);
    expect(cacheStakeUsd(200_000, fable, "short")).toBeCloseTo(2.45, 10);
    expect(cacheStakeUsd(200_000, opus, "long")).toBeCloseTo(1.56, 10);
    expect(cacheStakeUsd(185_000, fable, "long")).toBeCloseTo(3.65375, 10);
    expect(cacheWarmReadUsd(200_000, fable)).toBeCloseTo(0.05, 10);
  });
});
