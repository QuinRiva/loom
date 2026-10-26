/**
 * Account-scoped subscription usage, server-internal (nothing crosses the wire): failover needs
 * per-account keying, Codex's `limitReached` and per-model windows that upstream's shape lacks.
 * The routing key (`providerInstanceId ?? providerName`) keys exhaustion marks and failover, so an
 * instance is exhausted only when ALL its pooled accounts are; the storage key adds the label.
 */

/** `primary` ≈ the 5-hour rolling window, `secondary` ≈ the weekly window. */
export type AccountUsageWindowKind = "primary" | "secondary";

export interface AccountUsageWindow {
  readonly kind: AccountUsageWindowKind;
  readonly usedPercent: number;
  readonly resetsAt: string | null;
  readonly windowDurationMins: number | null;
  /**
   * Per-model carve-out (Anthropic's `weekly_scoped`). `modelId` is the pi
   * model the display name resolved to, or null when it resolved to none — a
   * display-only window that must never produce a routing mark.
   */
  readonly scope?: {
    readonly displayName: string;
    readonly modelId?: string | null;
  };
}

export interface AccountUsageSnapshot {
  /** Driver kind, e.g. "codex", "claudeAgent". */
  readonly providerName: string;
  readonly providerInstanceId: string | null;
  /** Distinguishes pooled accounts within a single instance; absent ⇒ sole account. */
  readonly accountLabel?: string;
  readonly windows: ReadonlyArray<AccountUsageWindow>;
  readonly observedAt: string;
  /** Explicit provider exhaustion flag (Codex `limit_reached`), account-wide. */
  readonly limitReached?: boolean;
  /**
   * The account's login is dead: it has no quota to offer, so its windows are
   * dropped rather than merged (a stale reading must not pass for headroom).
   * Sent with `limitReached`, so a pool is exhausted once every account is.
   */
  readonly signedOut?: boolean;
}

type RoutingIdentity = Pick<AccountUsageSnapshot, "providerInstanceId" | "providerName">;
type StorageIdentity = RoutingIdentity & Pick<AccountUsageSnapshot, "accountLabel">;

export const accountUsageRoutingKey = (snapshot: RoutingIdentity): string =>
  snapshot.providerInstanceId ?? snapshot.providerName;

const accountUsageStorageKey = (snapshot: StorageIdentity): string =>
  snapshot.accountLabel
    ? `${accountUsageRoutingKey(snapshot)}\u0000${snapshot.accountLabel}`
    : accountUsageRoutingKey(snapshot);

const windowMergeKey = (window: AccountUsageWindow): string =>
  `${window.kind}\u0000${window.scope?.displayName ?? ""}`;

/**
 * Merge one incoming snapshot into the per-account store. Provider updates are
 * sparse rolling reports (Codex documents this; Claude reports one window per
 * event), so windows merge by kind+scope.
 */
export const mergeAccountUsage = (
  store: ReadonlyMap<string, AccountUsageSnapshot>,
  incoming: AccountUsageSnapshot,
): ReadonlyMap<string, AccountUsageSnapshot> => {
  const existing = store.get(accountUsageStorageKey(incoming));
  const byKey = new Map(
    (existing?.windows ?? []).map((window) => [windowMergeKey(window), window] as const),
  );
  if (incoming.signedOut) byKey.clear();
  for (const window of incoming.windows) byKey.set(windowMergeKey(window), window);
  const next = new Map(store);
  next.set(accountUsageStorageKey(incoming), {
    ...incoming,
    windows: Array.from(byKey.values()),
  });
  return next;
};
