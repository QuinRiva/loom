/**
 * Account-scoped subscription usage — loom's server-internal telemetry shape.
 *
 * Upstream owns the user-facing usage story (`ServerProviderUsageLimits` on the
 * provider instance, rendered by the Usage → Limits page), and the
 * {@link SubscriptionUsagePoller} feeds it for pi. What upstream's shape cannot
 * express is what loom's *failover* needs: per-subscription-account keying
 * (loom runs one pi instance over several accounts), Codex's explicit
 * `limitReached`, and per-model carve-out windows resolved to model ids. So the
 * exhaustion side keeps this richer shape, entirely inside the server — nothing
 * here crosses the wire.
 *
 * Two keys, as before:
 *   - **routing key** (`providerInstanceId ?? providerName`): the instance an
 *     account belongs to. Exhaustion marks and failover routing key by this, so
 *     pooled accounts of one instance share it (the router fails over between
 *     them; the instance is exhausted only when ALL its accounts are).
 *   - **storage key** (routing key + label): distinguishes pooled accounts
 *     within one instance. Falls back to the routing key when there is no label.
 *
 * @module provider/accountUsage.loom
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
  for (const window of incoming.windows) byKey.set(windowMergeKey(window), window);
  const next = new Map(store);
  next.set(accountUsageStorageKey(incoming), {
    ...incoming,
    windows: Array.from(byKey.values()),
  });
  return next;
};
