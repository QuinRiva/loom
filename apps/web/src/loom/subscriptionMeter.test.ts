import type { LimitPresentations } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import { derivePools, meterAccounts, type MeterPool } from "./subscriptionMeter";
import {
  METER_FIXTURE_STATES,
  meterFixturePresentations,
  meterFixtureView,
} from "./subscriptionMeter.fixtures";

const MINUTE = 60_000;
const state = (id: string) => METER_FIXTURE_STATES.find((entry) => entry.id === id)!;
const midnight = (id: string) => {
  const [year, month, date] = state(id).day;
  return new Date(year, month, date).getTime();
};
/** Local minutes-from-midnight of an epoch time in the state's day. */
const minutes = (id: string, at: number) => (at - midnight(id)) / MINUTE;
const claude = (pools: readonly MeterPool[]) =>
  pools.find((pool) => pool.driver === "claudeAgent")!;
const row = (pool: MeterPool, label: string) => pool.rows.find((entry) => entry.label === label)!;

describe("axis", () => {
  it("puts every 5-hour window of a pool on one wall-clock axis ending at the latest reset", () => {
    const { view } = meterFixtureView(state("danger"));
    const pool = claude(view.pools);
    expect(minutes("danger", pool.axis.from)).toBe(430);
    expect(minutes("danger", pool.axis.to)).toBe(820);
    expect(pool.rows.map((entry) => [entry.label, minutes("danger", entry.bar!.reset)])).toEqual([
      ["caaarl@", 760],
      ["carl@", 730],
      ["carl3@", 780],
      ["carl4@", 800],
      ["jacob@", 820],
    ]);
    // The pool bar is the members' mean window and mean fill.
    expect(minutes("danger", pool.pool!.start)).toBe(478);
    expect(minutes("danger", pool.pool!.reset)).toBe(778);
    expect(pool.pool!.used).toBe(50);
  });
});

describe("empty marker", () => {
  it("lands where the ring's burn empties the window, when that is before the reset", () => {
    const { view } = meterFixtureView(state("danger"));
    const pool = claude(view.pools);
    // 50% left at a mean 20 pts/h: empty 2.5 h from 10:00, before the 12:58 mean reset.
    expect(minutes("danger", pool.pool!.emptyAt!)).toBeCloseTo(750, 0);
    expect(pool.pool!.burn).toMatchObject({ coarse: false });
    expect(minutes("danger", row(pool, "carl@").bar!.emptyAt!)).toBeCloseTo(
      600 + (22 / 34) * 60,
      0,
    );
    // The late-afternoon counter-case empties at 19:25, before the 20:30 reset.
    expect(
      minutes("lateday", claude(meterFixtureView(state("lateday")).view.pools).pool!.emptyAt!),
    ).toBeCloseTo(16.5 * 60 + (70 / 24) * 60, 0);
  });

  it("draws nothing when the burn lasts past the reset", () => {
    const pools = meterFixtureView(state("normal")).view.pools;
    expect(
      pools
        .flatMap((pool) => [pool.pool, ...pool.rows.map((entry) => entry.bar)])
        .filter((bar) => bar?.emptyAt != null),
    ).toEqual([]);
  });

  it("falls back to the window average, hollow, until the ring spans ten minutes", () => {
    const now = midnight("danger") + 600 * MINUTE;
    const pools = derivePools(
      meterAccounts(meterFixturePresentations(state("danger"), "hub")),
      now,
      new Map(),
    );
    const bar = row(claude(pools), "carl@").bar!;
    expect(bar.burn?.coarse).toBe(true);
    expect(bar.burn?.rate).toBeCloseTo((78 / 170) * 60);
    expect(bar.emptyAt).not.toBeNull();
  });

  it("starts a new window when the fill falls, and says nothing in its first ten minutes", () => {
    const ring = new Map();
    meterFixtureView(state("danger"), "hub", ring);
    // carl@ reset at 12:10; a reading five minutes into its next window.
    const next = {
      ...state("danger"),
      now: 735,
      subs: state("danger").subs.map((sub) =>
        sub[0] === "carl" ? (["carl", 730, 1030, 3, 36, 40, 74, 35] as const) : sub,
      ),
    };
    const bar = row(
      claude(
        derivePools(
          meterAccounts(meterFixturePresentations(next, "hub")),
          midnight("danger") + 735 * MINUTE,
          ring,
        ),
      ),
      "carl@",
    ).bar!;
    expect(ring.get("claudeAgent:carl@:session")).toHaveLength(1);
    expect(bar.burn).toBeNull();
    expect(bar.emptyAt).toBeNull();
  });
});

describe("reading ring on the token-file path", () => {
  // The pi instance's `checkedAt` moves whenever any of its accounts publishes,
  // so each 5-minute cycle restamps every account several times within
  // seconds — the first restamps still carrying the account's previous value.
  const restamp = (presentations: LimitPresentations, at: number): LimitPresentations =>
    new Map(
      [...presentations].map(([id, presentation]) => [
        id,
        {
          ...presentation,
          serverConfig: {
            ...presentation.serverConfig,
            providers: presentation.serverConfig!.providers!.map((provider) => ({
              ...provider,
              usageLimits: {
                ...provider.usageLimits!,
                checkedAt: new Date(at).toISOString(),
              },
            })),
          },
        },
      ]),
    );

  it("counts one reading per poll, so sibling restamps still yield the ring's rate", () => {
    const danger = state("danger");
    const ring = new Map();
    let pools: readonly MeterPool[] = [];
    for (const ago of [25, 20, 15, 10, 5, 0]) {
      const cycle = midnight("danger") + (danger.now - ago) * MINUTE;
      for (const [offset, valuesAgo] of [
        [0, ago + 5],
        [1, ago + 5],
        [2, ago],
        [3, ago],
        [4, ago],
        [5, ago],
      ] as const) {
        const at = cycle + offset * 1000;
        pools = derivePools(
          meterAccounts(restamp(meterFixturePresentations(danger, "tokenFiles", valuesAgo), at)),
          at,
          ring,
        );
      }
    }
    expect(ring.get("claudeAgent:carl@:session")).toHaveLength(6);
    const burn = row(claude(pools), "carl@").bar!.burn!;
    expect(burn.coarse).toBe(false);
    expect(burn.rate).toBeCloseTo(34, 0);
  });
});

describe("weekly marks", () => {
  it("marks risk at 85% or 20 points over pace, opportunity at 20% left within 24 h of reset", () => {
    const pool = claude(meterFixtureView(state("last36")).view.pools);
    expect(Object.fromEntries(pool.rows.map((entry) => [entry.label, entry.mark]))).toEqual({
      "caaarl@": "opp",
      "carl@": "opp",
      "carl3@": null,
      "carl4@": "risk",
      "jacob@": "risk",
    });
  });

  it("is silent mid-week except for the Fable clock far over pace and Codex's exhausted weekly", () => {
    const pools = meterFixtureView(state("normal")).view.pools;
    expect(
      pools.flatMap((pool) =>
        pool.rows
          .filter((entry) => entry.mark)
          .map((entry) => [entry.label, entry.mark, entry.exhausted]),
      ),
    ).toEqual([
      ["carl4@", "risk", false],
      [null, "risk", true],
    ]);
    const carl4 = row(claude(pools), "carl4@");
    expect(carl4.weeklies.map((weekly) => [weekly.label, weekly.mark])).toEqual([
      ["Weekly", null],
      ["Weekly · Fable", "risk"],
    ]);
  });
});

describe("pools across sources", () => {
  it("draws the same rows from the pi token files as from the hub, dropping the unlabelled direct login", () => {
    const shape = (pools: readonly MeterPool[]) =>
      pools.map((pool) => [
        pool.driver,
        pool.rows.map((entry) => [entry.label, entry.bar?.used, entry.mark]),
      ]);
    const hub = meterFixtureView(state("last36"), "hub").view.pools;
    const tokenFiles = meterFixtureView(state("last36"), "tokenFiles").view.pools;
    expect(shape(tokenFiles)).toEqual(shape(hub));
    expect(claude(tokenFiles).carveOut).toEqual(claude(hub).carveOut);
    expect(claude(hub).carveOut?.scope).toBe("Fable");
  });

  it("merges a sub reported by both on its label, the fresher reading winning and the email kept", () => {
    // The hub read five minutes before the token files: the token files win.
    const hub = [...meterFixturePresentations(state("danger"), "hub", 5).values()][0]!;
    const both = new Map(
      [...meterFixturePresentations(state("danger"), "tokenFiles")].map(([id, presentation]) => [
        id,
        {
          ...presentation,
          serverConfig: {
            ...presentation.serverConfig,
            usageLimitSources: hub.serverConfig!.usageLimitSources,
          },
        },
      ]),
    );
    const accounts = meterAccounts(both).filter((account) => account.driver === "claudeAgent");
    expect(accounts).toHaveLength(5);
    const carl = accounts.find((account) => account.email === "carl@unseen.id")!;
    expect(carl.key).toBe("pi:pi:carl@");
    expect(carl.limits.windows.find((window) => window.kind === "session")?.usedPercent).toBe(78);
  });

  it("draws Codex as a one-account pool through the same row path, on its own axis, after the pool", () => {
    const pools = meterFixtureView(state("danger")).view.pools;
    expect(pools.map((pool) => pool.driver)).toEqual(["claudeAgent", "codex"]);
    const codex = pools[1]!;
    expect(codex.pool).toBeNull();
    expect(codex.rows).toHaveLength(1);
    expect(minutes("danger", codex.axis.from)).toBe(528);
    expect(minutes("danger", codex.axis.to)).toBe(828);
    expect(codex.rows[0]!.bar?.used).toBe(12);
  });
});
