/**
 * loom: the derive behind the always-on subscription meter — the accepted
 * "Timeline" design (`plans/usage-meter-redesign/plan.mdx`).
 *
 * A pool is every account sharing a driver, from whatever source reports it:
 * native provider instances, cliproxy hub snapshots, and the pi instance's
 * account-encoded windows (`@t3tools/shared/usageWindowId`), which are split
 * back into one account per encoded account. Within a driver, accounts merge
 * on their display label (email local part or pi label) and the fresher
 * reading wins. Each account's 5-hour window is a bar on one wall-clock axis
 * per pool: the bar's end is its reset, a single now-line crosses every row,
 * and ▼ marks where the current burn empties the window when that lands
 * before the reset. Weekly windows surface only as ▲ risk / ▽ opportunity.
 *
 * The burn rate is not on the wire, so it is derived here from a ring of the
 * last readings per account-window. Pure apart from that ring; the component
 * memoises the derive on the limits slice and the countdown tick.
 *
 * @module loom/subscriptionMeter
 */
import {
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import {
  collectLimitAccounts,
  elapsedShare,
  type LimitAccount,
  type LimitPresentations,
} from "@t3tools/shared/usageLimits";
import { decodeUsageWindowId } from "@t3tools/shared/usageWindowId";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * The driver behind a pi account key. The poller writes
 * `providerInstanceId ?? providerName`: the two global accounts are named by
 * driver, and an instance's own usage sources (keyed by the instance id) are
 * all `anthropic-oauth` — the only `ProviderUsageSourceKind` — so Claude.
 */
const DRIVER_OF: Record<string, ServerProvider["driver"]> = {
  claudeAgent: ProviderDriverKind.make("claudeAgent"),
  codex: ProviderDriverKind.make("codex"),
};

/**
 * Split the pi instance's account-encoded windows into poolable accounts. Hub
 * and natively reported accounts pass through untouched.
 */
export function splitLoomPiAccount(account: LimitAccount): readonly LimitAccount[] {
  if (account.driver !== "pi") return [account];
  const byAccount = new Map<string, ServerProviderUsageWindow[]>();
  for (const window of account.limits.windows) {
    const identity = decodeUsageWindowId(window.id);
    if (!identity) continue; // a natively emitted window is not an account row
    const key = `${identity.accountKey}:${identity.accountLabel ?? ""}`;
    // Account-independent id: sibling accounts must share a key to pool.
    const id = identity.scope ? `${identity.kind}:${identity.scope}` : identity.kind;
    byAccount.set(key, [...(byAccount.get(key) ?? []), { ...window, id }]);
  }
  return [...byAccount].map(([key, windows]) => {
    const [accountKey = "", label = ""] = key.split(":");
    return {
      ...account,
      key: `pi:${key}`,
      driver:
        DRIVER_OF[accountKey] ?? (label ? ProviderDriverKind.make("claudeAgent") : account.driver),
      displayName: label || null,
      limits: { ...account.limits, windows },
    };
  });
}

/** How an account is named in a row: `carl3@` from a hub email or a pi label alike. */
export function accountLabel(account: LimitAccount): string | null {
  return account.email ? `${account.email.split("@")[0]}@` : account.displayName;
}

/** A window's model scope (`Fable`): pi's `secondary:<scope>` id, or a hub's `Weekly · <scope>` label. */
function scopeOf(window: ServerProviderUsageWindow): string | undefined {
  return window.id.split(":")[1] ?? window.label.split(" · ")[1];
}

/**
 * Every account, one per driver + display label. The fresher reading wins; an
 * email from either side is kept. An account with neither email nor label (the
 * poller's direct-auth Claude reading, an unmatchable probable duplicate of a
 * labelled source) is dropped from a pool that has named members, and kept
 * when it is the pool's only account (Codex's direct reading).
 */
export function meterAccounts(presentations: LimitPresentations): readonly LimitAccount[] {
  const merged = new Map<string, LimitAccount>();
  for (const account of collectLimitAccounts(presentations).flatMap(splitLoomPiAccount)) {
    const key = `${account.driver}:${accountLabel(account) ?? ""}`;
    const previous = merged.get(key);
    const fresher =
      !previous || Date.parse(account.limits.checkedAt) > Date.parse(previous.limits.checkedAt);
    const winner = fresher ? account : previous;
    merged.set(key, { ...winner, email: winner.email ?? previous?.email ?? account.email });
  }
  const named = new Set(
    [...merged.values()].flatMap((account) => (accountLabel(account) ? [account.driver] : [])),
  );
  return [...merged.values()].filter(
    (account) => accountLabel(account) !== null || !named.has(account.driver),
  );
}

// ---------------------------------------------------------------------------
// Burn rate: a ring of the last readings per account-window.
// ---------------------------------------------------------------------------

interface Reading {
  readonly at: number;
  readonly used: number;
  readonly resetsAt: number | null;
}
export type ReadingRing = Map<string, Reading[]>;
export interface Burn {
  readonly rate: number;
  readonly coarse: boolean;
}

const RING_SIZE = 6;
const RATE_MIN_READINGS = 3;
const RATE_MIN_SPAN = 10 * MINUTE;
/** A new window moves its reset by hours; readings jitter it by seconds. */
const RESET_MOVED = 5 * MINUTE;

/** The one ring every meter reads; tests and fixtures pass their own. */
const RING: ReadingRing = new Map();

/** Append a reading when it is new; a moved reset or a falling fill starts a new window. */
function observe(ring: ReadingRing, key: string, reading: Reading): readonly Reading[] {
  const list = ring.get(key) ?? [];
  const last = list.at(-1);
  if (last?.at === reading.at) return list;
  const newWindow =
    last !== undefined &&
    (reading.used < last.used ||
      Math.abs((reading.resetsAt ?? 0) - (last.resetsAt ?? 0)) > RESET_MOVED);
  const next = [...(newWindow ? [] : list), reading].slice(-RING_SIZE);
  ring.set(key, next);
  return next;
}

/** Points per hour: the ring once ≥3 readings span ≥10 min, else the window average (coarse). */
function burnOf(readings: readonly Reading[], used: number, elapsedMs: number): Burn | null {
  const first = readings[0];
  const last = readings.at(-1);
  if (
    first &&
    last &&
    readings.length >= RATE_MIN_READINGS &&
    last.at - first.at >= RATE_MIN_SPAN
  ) {
    return { rate: ((last.used - first.used) / (last.at - first.at)) * HOUR, coarse: false };
  }
  // The first minutes of a window say nothing about its burn.
  return elapsedMs >= RATE_MIN_SPAN ? { rate: (used / elapsedMs) * HOUR, coarse: true } : null;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type MeterTone = "quiet" | "warning" | "destructive";
export type MeterMark = "risk" | "opp";

export const RISK_USED = 85;
const RISK_OVER_PACE = 20;
const OPP_LEFT = 20;
const OPP_RESET_WITHIN = 24 * HOUR;

/** A window on the wall-clock axis. Times are epoch ms. */
export interface MeterBar {
  readonly start: number;
  readonly reset: number;
  /** False for an idle window (no reset reported, or already past): drawn from now. */
  readonly resetKnown: boolean;
  readonly used: number;
  /** Points per hour; coarse when it is the window average rather than the ring's. */
  readonly burn: Burn | null;
  /** Where the burn empties the window, when that lands before its reset: the ▼. */
  readonly emptyAt: number | null;
  readonly tone: MeterTone;
}

export interface MeterWeekly {
  /** `Weekly`, or `Weekly · Fable` for a per-model carve-out. */
  readonly label: string;
  readonly scope: string | undefined;
  readonly used: number;
  readonly elapsed: number | null;
  readonly resetsAt: number | null;
  readonly mark: MeterMark | null;
}

export interface MeterRow {
  readonly key: string;
  /** Null for an account known only by its driver (Codex's direct reading). */
  readonly label: string | null;
  readonly email: string | undefined;
  readonly bar: MeterBar | null;
  readonly weeklies: readonly MeterWeekly[];
  /** The row's exception: risk from any weekly first, else opportunity. */
  readonly mark: MeterMark | null;
  /** A weekly clock at 100%: the row name turns red. */
  readonly exhausted: boolean;
}

export interface MeterPool {
  readonly driver: ServerProvider["driver"];
  readonly rows: readonly MeterRow[];
  /** The shared wall-clock axis every bar in the pool is drawn on. */
  readonly axis: { readonly from: number; readonly to: number };
  /** The pool's own 5-hour bar (means over its rows); null for a one-account pool. */
  readonly pool: MeterBar | null;
  /** The pooled per-model weekly (Fable): mean fill against the mean elapsed share. */
  readonly carveOut: {
    readonly scope: string;
    readonly used: number;
    readonly elapsed: number;
  } | null;
}

function byDriver(accounts: readonly LimitAccount[]) {
  const groups = new Map<ServerProvider["driver"], LimitAccount[]>();
  for (const account of accounts)
    groups.set(account.driver, [...(groups.get(account.driver) ?? []), account]);
  return groups;
}

/** Red at 100%, amber from 80% or when the burn empties the window before its reset. */
export const toneOf = (used: number, emptiesFirst = false): MeterTone =>
  used >= 100 ? "destructive" : used >= 80 || emptiesFirst ? "warning" : "quiet";

const mean = (values: readonly number[]) =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

function bar(
  start: number,
  reset: number,
  resetKnown: boolean,
  used: number,
  burn: Burn | null,
  now: number,
): MeterBar {
  const at =
    burn && burn.rate > 0 && used < 100 ? now + ((100 - used) / burn.rate) * HOUR : Infinity;
  const emptyAt = at < reset ? at : null;
  return { start, reset, resetKnown, used, burn, emptyAt, tone: toneOf(used, emptyAt !== null) };
}

const resetOf = (window: ServerProviderUsageWindow) =>
  window.resetsAt === undefined ? null : Date.parse(window.resetsAt);

function sessionBar(
  account: LimitAccount,
  window: ServerProviderUsageWindow,
  key: string,
  now: number,
  ring: ReadingRing,
): MeterBar {
  const length = (window.windowDurationMins ?? 300) * MINUTE;
  const reset = resetOf(window);
  // A window with no reset, or one whose reset has passed, is idle: the next
  // one starts at first use, so it is drawn from now with nothing spent.
  if (reset === null || reset <= now) return bar(now, now + length, false, 0, null, now);
  const used = window.usedPercent;
  const readings = observe(ring, key, {
    at: Date.parse(account.limits.checkedAt),
    used,
    resetsAt: reset,
  });
  const start = reset - length;
  return bar(start, reset, true, used, burnOf(readings, used, now - start), now);
}

function weeklyOf(window: ServerProviderUsageWindow, now: number): MeterWeekly {
  const scope = scopeOf(window);
  const used = window.usedPercent;
  const elapsed = elapsedShare(window, now);
  const resetsAt = resetOf(window);
  const risk = used >= RISK_USED || (elapsed !== null && used - elapsed * 100 >= RISK_OVER_PACE);
  const opp =
    !scope &&
    100 - used >= OPP_LEFT &&
    resetsAt !== null &&
    resetsAt > now &&
    resetsAt - now <= OPP_RESET_WITHIN;
  return {
    label: scope ? `Weekly · ${scope}` : "Weekly",
    scope,
    used,
    elapsed,
    resetsAt,
    mark: risk ? "risk" : opp ? "opp" : null,
  };
}

function rowOf(account: LimitAccount, now: number, ring: ReadingRing): MeterRow {
  const label = accountLabel(account);
  const key = `${account.driver}:${label ?? ""}`;
  const session = account.limits.windows.find((window) => window.kind === "session");
  const weeklies = account.limits.windows
    .filter((window) => window.kind === "weekly")
    .map((window) => weeklyOf(window, now))
    .sort((left, right) => Number(left.scope !== undefined) - Number(right.scope !== undefined));
  const marks = new Set(weeklies.map((weekly) => weekly.mark));
  return {
    key,
    label,
    email: account.email,
    bar: session ? sessionBar(account, session, `${key}:${session.id}`, now, ring) : null,
    weeklies,
    mark: marks.has("risk") ? "risk" : marks.has("opp") ? "opp" : null,
    exhausted: weeklies.some((weekly) => weekly.used >= 100),
  };
}

/** The pool's 5-hour bar: means over its members, an idle member counting as unspent. */
function poolBar(bars: readonly MeterBar[], now: number): MeterBar {
  const timed = bars.filter((entry) => entry.resetKnown);
  if (timed.length === 0) return bar(now, now + 5 * HOUR, false, 0, null, now);
  return bar(
    mean(timed.map((entry) => entry.start)),
    mean(timed.map((entry) => entry.reset)),
    true,
    mean(bars.map((entry) => entry.used)),
    {
      rate: mean(bars.map((entry) => entry.burn?.rate ?? 0)),
      coarse: timed.some((entry) => entry.burn?.coarse !== false),
    },
    now,
  );
}

/** `2h 05m`, `3d 4h`, `12m`: a fixed-width countdown for the meter's right column. */
export function formatCountdown(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE));
  const hours = Math.floor(minutes / 60) % 24;
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)}d ${hours}h`;
  return hours > 0 ? `${hours}h ${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`;
}

/** Accounts grouped by driver into the pools the meter draws, multi-account pools first. */
export function derivePools(
  accounts: readonly LimitAccount[],
  now: number,
  ring: ReadingRing = RING,
): readonly MeterPool[] {
  const pools = [...byDriver(accounts)].map(([driver, members]): MeterPool => {
    // By name, so a row never moves — not as clocks reset (the axis already
    // shows reset order), nor when the hub and the token files swap in.
    const rows = members
      .map((account) => rowOf(account, now, ring))
      .sort((left, right) => (left.label ?? "").localeCompare(right.label ?? ""));
    const bars = rows.flatMap((row) => (row.bar ? [row.bar] : []));
    const scope = rows.flatMap((row) => row.weeklies).find((weekly) => weekly.scope)?.scope;
    const scoped = rows.flatMap((row) => row.weeklies.filter((weekly) => weekly.scope === scope));
    const elapsed = scoped.flatMap((weekly) => (weekly.elapsed === null ? [] : [weekly.elapsed]));
    return {
      driver,
      rows,
      axis: {
        from: Math.min(now, ...bars.map((entry) => entry.start)),
        to: Math.max(now + MINUTE, ...bars.map((entry) => entry.reset)),
      },
      pool: rows.length > 1 && bars.length > 0 ? poolBar(bars, now) : null,
      carveOut:
        rows.length > 1 && scope && elapsed.length > 0
          ? { scope, used: mean(scoped.map((weekly) => weekly.used)), elapsed: mean(elapsed) }
          : null,
    };
  });
  return pools.sort((left, right) => Number(right.pool !== null) - Number(left.pool !== null));
}

// ---------------------------------------------------------------------------
// Reading the live presentations
// ---------------------------------------------------------------------------

/** How often the countdown moves, and the bucket the derive is cached in. */
export const METER_TICK_MS = 30_000;

export interface MeterView {
  /** `stale`: the driver's last reading, held since its source stopped reporting. */
  readonly pools: readonly (MeterPool & { readonly stale: boolean })[];
}

/** One entry, shared by the footer meter and its header chip: they derive the same pools. */
let memo: { readonly key: string; readonly view: MeterView } | null = null;
const held = new Map<ServerProvider["driver"], readonly LimitAccount[]>();

/**
 * The pools to draw, each marked live or stale.
 *
 * Provider limits are runtime snapshot state: a reconnect, a server restart, or
 * a provider republishing its snapshot delivers a `serverConfig` with none
 * until the poller publishes again — and it goes per provider rather than all
 * at once. The meter is on screen permanently, so each driver's last reading is
 * held and marked stale rather than blinking out; nothing is drawn only when
 * there has never been a reading, and a reload starts empty again.
 *
 * Cached on the limits slice and the tick, because the presentations atom
 * updates on every `serverConfig` change and the sidebar is always mounted.
 */
export function readMeter(presentations: LimitPresentations, now: number): MeterView {
  const key = `${limitsFingerprint(presentations)}|${Math.floor(now / METER_TICK_MS)}`;
  if (memo?.key === key) return memo.view;
  const live = byDriver(meterAccounts(presentations));
  for (const [driver, accounts] of live) held.set(driver, accounts);
  const pools = derivePools([...held.values()].flat(), now).map((pool) => ({
    ...pool,
    stale: !live.has(pool.driver),
  }));
  memo = { key, view: { pools } };
  return memo.view;
}

/**
 * Identity of the limits slice of the presentations map. The atom updates on
 * every `serverConfig` change and the meter is always on screen, so the derive
 * runs only when a reading actually lands (or the countdown ticks).
 */
export function limitsFingerprint(presentations: LimitPresentations): string {
  const parts: string[] = [];
  for (const [environmentId, presentation] of presentations) {
    for (const provider of presentation.serverConfig?.providers ?? []) {
      if (provider.usageLimits)
        parts.push(`${provider.instanceId}@${provider.usageLimits.checkedAt}`);
    }
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      parts.push(`${environmentId}/${source.id}@${source.checkedAt}`);
    }
  }
  return parts.join("|");
}
