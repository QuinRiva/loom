/**
 * loom: the usage-meter plan's fixture states (`plans/usage-meter-redesign/build_plan.py`),
 * built as real presentations — a cliproxy hub snapshot, or the pi instance's
 * token-file windows — and replayed through the reading ring, so the preview
 * harness and the tests draw exactly what the live meter would.
 *
 * Minutes are minutes from local midnight; `rate` is the 5-hour burn in points
 * per hour; weekly resets are hours from now.
 *
 * @module loom/subscriptionMeter.fixtures
 */
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import type { LimitPresentations } from "@t3tools/shared/usageLimits";

import { derivePools, meterAccounts, type MeterView, type ReadingRing } from "./subscriptionMeter";

type Sub = readonly [
  label: string,
  start: number,
  reset: number,
  used: number,
  rate: number,
  weeklyUsed: number,
  weeklyResetHours: number,
  fableUsed: number,
];

export interface MeterFixtureState {
  readonly id: string;
  readonly title: string;
  /** Local date the minutes count from. */
  readonly day: readonly [year: number, month: number, date: number];
  readonly now: number;
  readonly subs: readonly Sub[];
  readonly codex: Sub;
}

export const METER_FIXTURE_STATES: readonly MeterFixtureState[] = [
  {
    id: "normal",
    title: "Normal mid-week — Thu 12:31, real reading 25 Sep",
    day: [2026, 8, 24],
    now: 12 * 60 + 31,
    subs: [
      ["carl", 600, 900, 2, 0.6, 25, 106, 24],
      ["caaarl", 600, 900, 0, 0, 55, 90, 62],
      ["carl3", 600, 900, 9, 2, 38, 101, 41],
      ["carl4", 600, 900, 7, 1.5, 54, 89, 77],
      ["jacob", 600, 900, 0, 0, 63, 80, 64],
    ],
    codex: ["Codex", 751, 1051, 0, 0, 100, 57.3, 100],
  },
  {
    id: "danger",
    title: "Danger — Tue 10:00, 50% left, slightly over pace",
    day: [2026, 8, 22],
    now: 10 * 60,
    subs: [
      ["carl", 430, 730, 78, 34, 40, 74, 35],
      ["caaarl", 460, 760, 58, 20, 52, 80, 44],
      ["carl3", 480, 780, 44, 18, 31, 98, 28],
      ["carl4", 500, 800, 38, 16, 47, 86, 41],
      ["jacob", 520, 820, 32, 12, 44, 92, 42],
    ],
    codex: ["Codex", 528, 828, 12, 6, 40, 50, 40],
  },
  {
    id: "lateday",
    title: "Late afternoon — Thu 16:30, 70% left, well over pace",
    day: [2026, 8, 24],
    now: 16 * 60 + 30,
    subs: [
      ["carl", 930, 1230, 34, 24, 40, 52, 35],
      ["caaarl", 930, 1230, 30, 24, 52, 58, 44],
      ["carl3", 930, 1230, 28, 24, 31, 76, 28],
      ["carl4", 930, 1230, 32, 24, 47, 64, 41],
      ["jacob", 930, 1230, 26, 24, 44, 70, 42],
    ],
    codex: ["Codex", 930, 1230, 20, 10, 40, 30, 40],
  },
  {
    id: "last36",
    title: "Last 36 hours — Fri 09:30, weeklies reset 4 h to 38 h out",
    day: [2026, 8, 25],
    now: 9 * 60 + 30,
    subs: [
      ["carl", 420, 720, 31, 8, 66, 20, 60],
      ["caaarl", 450, 750, 12, 4, 35, 9, 30],
      ["carl3", 390, 690, 55, 14, 52, 38, 49],
      ["carl4", 480, 780, 20, 6, 88, 36, 84],
      ["jacob", 510, 810, 44, 12, 91, 4, 95],
    ],
    codex: ["Codex", 450, 750, 25, 8, 40, 100, 40],
  },
];

const MINUTE = 60_000;
const CLAUDE = ProviderDriverKind.make("claudeAgent");
const ENVIRONMENT = EnvironmentId.make("preview");
/** The ring's six 5-minute readings. */
const READINGS = [25, 20, 15, 10, 5, 0];

const midnightOf = ({ day: [year, month, date] }: MeterFixtureState) =>
  new Date(year, month, date).getTime();

export type MeterFixtureSource = "hub" | "tokenFiles";

/** The state's presentations `ago` minutes before its `now`, from either source. */
export function meterFixturePresentations(
  state: MeterFixtureState,
  source: MeterFixtureSource,
  ago = 0,
): LimitPresentations {
  const midnight = midnightOf(state);
  const at = (minutes: number) => new Date(midnight + minutes * MINUTE).toISOString();
  const now = state.now - ago;
  const checkedAt = at(now);
  const windows = (
    [, start, reset, used, rate, weeklyUsed, weeklyResetHours, fableUsed]: Sub,
    ids: readonly [string, string, string],
  ): ServerProviderUsageWindow[] => [
    {
      id: ids[0],
      kind: "session",
      label: "Session",
      usedPercent: Math.max(0, used - (rate * ago) / 60),
      windowDurationMins: reset - start,
      resetsAt: at(reset),
    },
    {
      id: ids[1],
      kind: "weekly",
      label: "Weekly",
      usedPercent: weeklyUsed,
      windowDurationMins: 7 * 24 * 60,
      resetsAt: at(state.now + weeklyResetHours * 60),
    },
    {
      id: ids[2],
      kind: "weekly",
      label: "Weekly · Fable",
      usedPercent: fableUsed,
      windowDurationMins: 7 * 24 * 60,
      resetsAt: at(state.now + weeklyResetHours * 60),
    },
  ];
  // Codex reports no carve-out.
  const codex = windows(state.codex, ["codex::primary", "codex::secondary", ""]).slice(0, 2);
  const pi: ServerProvider = {
    instanceId: ProviderInstanceId.make("pi"),
    driver: ProviderDriverKind.make("pi"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows: [
        ...codex,
        ...(source === "tokenFiles"
          ? state.subs.flatMap((sub) => {
              const label = `${sub[0]}@`;
              return windows(sub, [
                `pi:${label}:primary`,
                `pi:${label}:secondary`,
                `pi:${label}:secondary:Fable`,
              ]);
            })
          : []),
        // The poller's direct-auth Claude reading: unlabelled, so the meter drops it.
        ...(source === "tokenFiles"
          ? windows(state.subs[0]!, [
              "claudeAgent::primary",
              "claudeAgent::secondary",
              "claudeAgent::secondary:Fable",
            ])
          : []),
      ],
    },
  };
  return new Map([
    [
      ENVIRONMENT,
      {
        entry: { target: { label: "Preview" } },
        serverConfig: {
          providers: [pi],
          usageLimitSources:
            source === "hub"
              ? [
                  {
                    id: UsageLimitSourceId.make("cliproxy-preview"),
                    kind: "cliproxy",
                    label: "CLI Proxy",
                    checkedAt,
                    accounts: state.subs.map((sub) => ({
                      id: `claude-${sub[0]}@unseen.id.json`,
                      driver: CLAUDE,
                      email: `${sub[0]}@unseen.id`,
                      plan: "Claude Max",
                      usageLimits: {
                        checkedAt,
                        windows: windows(sub, ["five_hour", "seven_day", "seven_day_fable"]),
                      },
                    })),
                  },
                ]
              : [],
        },
      },
    ],
  ]);
}

/** The state's meter after its six readings have passed through a fresh ring. */
export function meterFixtureView(
  state: MeterFixtureState,
  source: MeterFixtureSource = "hub",
  ring: ReadingRing = new Map(),
): { readonly view: MeterView; readonly now: number } {
  const midnight = midnightOf(state);
  let pools: ReturnType<typeof derivePools> = [];
  for (const ago of READINGS) {
    pools = derivePools(
      meterAccounts(meterFixturePresentations(state, source, ago)),
      midnight + (state.now - ago) * MINUTE,
      ring,
    );
  }
  return {
    view: { pools: pools.map((pool) => ({ ...pool, stale: false })) },
    now: midnight + state.now * MINUTE,
  };
}
