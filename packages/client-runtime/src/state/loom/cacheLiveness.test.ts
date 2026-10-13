import { describe, expect, it } from "vite-plus/test";

import type { LoomCacheRetention, LoomCacheWarming } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  cacheLiveness,
  cacheModelPrice,
  cacheStakeUsd,
  cacheWarmReadUsd,
} from "./cacheLiveness.ts";

const MIN = 60_000;
const NOW = Date.parse("2026-10-12T12:00:00.000Z");
const ago = (minutes: number) => NOW - minutes * MIN;
const iso = (minutes: number | null) =>
  minutes === null ? null : DateTime.formatIso(DateTime.makeUnsafe(ago(minutes)));

/** A thread whose last request was dispatched `started` min ago and ran 30 s. */
const facts = (
  retention: LoomCacheRetention,
  started: number,
  pinged: number | null,
  warming: LoomCacheWarming | null,
) => ({
  retention,
  requestStartedAt: iso(started),
  requestEndedAt: iso(started - 0.5),
  pingedAt: iso(pinged),
  warming,
});

describe("cacheLiveness", () => {
  it.each([
    // [case, retention, dispatched min ago, last ping min ago, plan] → [state, expires min from now, kept warm, lit]
    // 1-hour root: one ping at +54, alive to dispatch + 114.
    ["1h pending ping", "long", 10, null, "scheduled", "warm", 104, true, 12],
    ["1h ping due, within grace", "long", 57, null, "scheduled", "warm", 57, true, 12],
    ["1h ping landed", "long", 54.1, 0.1, "scheduled", "warm", 59.9, false, 12],
    ["1h after its ping, draining", "long", 105, 51, "scheduled", "expiring", 9, false, 2],
    ["1h ping missed past grace", "long", 58, null, "scheduled", "expiring", 2.5, false, 1],
    ["1h after a restart", "long", 30, null, "stopped", "warm", 30.5, false, 7],
    ["1h after a restart, last 10", "long", 51, null, "stopped", "expiring", 9.5, false, 2],
    ["1h cold", "long", 125, 71, "stopped", "cold", -11, false, 0],
    // 5-minute thread: six pings while the next falls within 30 min, alive to ≈ dispatch + 32.
    ["5m undecided", "short", 2, null, null, "warm", 3.5, false, 4],
    ["5m pinging", "short", 12, 2.6, "scheduled", "warm", 20.4, true, 5],
    ["5m first ping pending", "short", 4, null, "scheduled", "warm", 28, true, 5],
    ["5m stopped", "short", 1, null, "stopped", "expiring", 4.5, false, 5],
    ["5m pi said stop at +4.5", "short", 4.5, null, "stopped", "expiring", 1, false, 1],
    ["5m after the horizon", "short", 31, 3.5, "scheduled", "expiring", 1.5, false, 2],
    ["5m ping missed", "short", 5.6, null, "scheduled", "cold", -0.1, false, 0],
    ["5m cold", "short", 40, null, "stopped", "cold", -34.5, false, 0],
  ] as const)(
    "%s",
    (_case, retention, started, pinged, warming, state, expiresIn, keptWarm, lit) => {
      const liveness = cacheLiveness(NOW, facts(retention, started, pinged, warming));
      expect(liveness).toMatchObject({ state, keptWarm, litSteps: lit, retention });
      expect((liveness.expiresAtMs! - NOW) / MIN).toBeCloseTo(expiresIn, 6);
      expect(liveness.remainingMs).toBe(liveness.expiresAtMs! - NOW);
    },
  );

  it("last touch is the later of the request end and the last ping", () => {
    expect(cacheLiveness(NOW, facts("long", 60, 3, "stopped")).touchedAtMs).toBe(ago(3));
    expect(cacheLiveness(NOW, facts("long", 20, 70, "stopped")).touchedAtMs).toBe(ago(19.5));
  });

  it("an earlier idle period's ping does not move the schedule", () => {
    // Pinged 70 min ago, then a new turn 10 min ago: the anchor is the new dispatch.
    expect(cacheLiveness(NOW, facts("long", 10, 70, "scheduled")).expiresAtMs).toBe(ago(-104));
  });

  it.each(["long", "short"] as const)(
    "%s cache with no request on record is unknown",
    (retention) => {
      expect(
        cacheLiveness(NOW, {
          retention,
          requestStartedAt: null,
          requestEndedAt: null,
          pingedAt: null,
          warming: "scheduled",
        }),
      ).toMatchObject({ state: "unknown", expiresAtMs: null, remainingMs: null, litSteps: 0 });
    },
  );

  it("a migrated row (end only, stopped) counts down from its last touch", () => {
    expect(
      cacheLiveness(NOW, {
        retention: "long",
        requestStartedAt: null,
        requestEndedAt: iso(20),
        pingedAt: null,
        warming: "stopped",
      }),
    ).toMatchObject({ state: "warm", expiresAtMs: ago(-40), keptWarm: false });
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
