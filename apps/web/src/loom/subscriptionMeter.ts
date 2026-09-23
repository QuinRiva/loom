/**
 * loom: the derive behind the always-on subscription meter.
 *
 * Loom runs one pi instance over several subscription accounts, so
 * `SubscriptionUsagePoller` folds every account's windows into that instance's
 * flat window list with the account encoded in each id
 * (`@t3tools/shared/usageWindowId`). Upstream's pooled selectors group by
 * `account.driver` and key windows by `kind:id`, so the pi account is split
 * back into one synthetic account per encoded account before it is pooled —
 * otherwise Claude and Codex average into a single `pi` bar and every window
 * forms a single-member pool of its own.
 *
 * Pure: no atoms, no IO. The component memoises it on the limits slice.
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
  collectLimitPools,
  type LimitAccount,
  type LimitPool,
  type LimitPoolWindow,
  type LimitPresentations,
} from "@t3tools/shared/usageLimits";
import { decodeUsageWindowId } from "@t3tools/shared/usageWindowId";

/** The poller writes `providerInstanceId ?? providerName` into the account key. */
const DRIVER_OF: Record<string, ServerProvider["driver"]> = {
  claudeAgent: ProviderDriverKind.make("claudeAgent"),
  codex: ProviderDriverKind.make("codex"),
};

/** A window is loud at 80% used (warning) and at 100% (destructive). */
export const METER_WARNING_PERCENT = 80;
export const METER_DESTRUCTIVE_PERCENT = 100;

export type MeterTone = "quiet" | "warning" | "destructive";

export function meterTone(usedPercent: number): MeterTone {
  if (usedPercent >= METER_DESTRUCTIVE_PERCENT) return "destructive";
  if (usedPercent >= METER_WARNING_PERCENT) return "warning";
  return "quiet";
}

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
    const windows = byAccount.get(key) ?? [];
    windows.push({ ...window, id });
    byAccount.set(key, windows);
  }
  return [...byAccount].map(([key, windows]) => ({
    ...account,
    key: `pi:${key}`,
    driver: DRIVER_OF[key.split(":")[0]!] ?? account.driver,
    displayName: key.split(":")[1] || null,
    limits: { ...account.limits, windows },
  }));
}

/** Every connected environment's accounts, split and pooled by driver. */
export function meterPools(presentations: LimitPresentations, now: number): readonly LimitPool[] {
  return collectLimitPools(collectLimitAccounts(presentations).flatMap(splitLoomPiAccount), now);
}

/** How often the countdown moves, and the bucket the derive is cached in. */
export const METER_TICK_MS = 30_000;

export interface MeterPoolView {
  readonly pool: LimitPool;
  /** The tick this pool last came from a live reading. */
  readonly readAt: number;
  readonly stale: boolean;
}

/** One entry, shared by the footer meter and its header chip: they derive the same pools. */
let memo: {
  readonly key: string;
  readonly now: number;
  readonly pools: readonly LimitPool[];
} | null = null;
const held = new Map<
  ServerProvider["driver"],
  { readonly pool: LimitPool; readonly readAt: number }
>();

/**
 * The pools to draw, each marked live or stale.
 *
 * Provider limits are runtime snapshot state: a reconnect, a server restart, or
 * a provider republishing its snapshot delivers a `serverConfig` with none
 * until the poller publishes again — and it goes per provider rather than all
 * at once (a hub's snapshot survives what drops an instance's windows). The
 * meter is on screen permanently, so each driver's last reading is held and
 * marked stale rather than blinking out; nothing is drawn only when there has
 * never been a reading, and a reload starts empty again.
 *
 * Cached on the limits slice and the tick, because the presentations atom
 * updates on every `serverConfig` change and the sidebar is always mounted.
 */
export function readMeter(
  presentations: LimitPresentations,
  now: number,
): readonly MeterPoolView[] {
  const key = `${limitsFingerprint(presentations)}|${Math.floor(now / METER_TICK_MS)}`;
  if (memo?.key !== key) memo = { key, now, pools: meterPools(presentations, now) };
  const live = new Set(memo.pools.map((pool) => pool.driver));
  // Held in first-seen order, so a bar never jumps position between readings.
  for (const pool of memo.pools) held.set(pool.driver, { pool, readAt: memo.now });
  return [...held].map(([driver, entry]) => ({ ...entry, stale: !live.has(driver) }));
}

/**
 * Identity of the limits slice of the presentations map. The atom updates on
 * every `serverConfig` change and the meter is always on screen, so the derive
 * runs only when a reading actually lands.
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

/** Labels come from the window kind: a pooled label is inherited from whichever member was first. */
const KIND_LABEL: Record<ServerProviderUsageWindow["kind"], string> = {
  session: "Session",
  weekly: "Weekly",
  monthly: "Monthly",
  other: "Other",
};

/**
 * A pooled window's label. `LimitPoolWindow.label` is inherited from whichever
 * member landed first — for loom's split windows that is one account's own
 * label (`carl3@ 5-hour`) — so the kind names the row, and only the per-model
 * carve-out's scope is taken from the id (loom's `kind:scope`) or from the
 * inherited label (a hub's `Weekly · Fable`).
 */
export function poolWindowLabel(window: LimitPoolWindow): string {
  const scope = window.id.split(":")[1] ?? window.label.split(" · ")[1];
  return scope ? `${KIND_LABEL[window.kind]} · ${scope}` : KIND_LABEL[window.kind];
}

/**
 * The number the bar shows: the account-wide session window. Scoped carve-outs
 * are weekly by construction, so they never reach the headline. A subscription
 * reported both natively and through a hub keys its session window twice, so
 * the widest pool wins and the louder one breaks the tie.
 */
export function headlinePoolWindow(pool: LimitPool): LimitPoolWindow | undefined {
  return [...pool.windows]
    .filter((window) => window.kind === "session")
    .sort(
      (left, right) =>
        right.members.length - left.members.length || right.usedPercent - left.usedPercent,
    )[0];
}

/** Tone follows the loudest window, so a weekly carve-out can drive the highlight. */
export function poolTone(pool: LimitPool): MeterTone {
  return meterTone(Math.max(0, ...pool.windows.map((window) => window.usedPercent)));
}
