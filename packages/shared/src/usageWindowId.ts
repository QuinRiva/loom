// loom: the id format of the usage-limit windows SubscriptionUsagePoller folds
// into a provider instance's published `usageLimits`.
//
// Upstream merges an instance's windows by id (last writer wins), and loom runs
// one pi instance over several subscription accounts — two global ones
// (`claudeAgent`, `codex`) plus any pooled `usageSources` an instance declares.
// So the id must carry the account, or the pooled accounts overwrite each
// other and the Limits page shows one flapping account. The server encodes,
// the failover settings card decodes; this is the only place either knows the
// shape. A window an adapter emitted natively (`five_hour`, `primary`) does
// not decode and is not an account row.

export type UsageWindowKind = "primary" | "secondary";

export interface UsageWindowIdentity {
  /** Routing key: `providerInstanceId ?? providerName` — what pausedAccounts and exhaustion marks key by. */
  readonly accountKey: string;
  /** Pooled-account label within the instance; absent for its sole account. */
  readonly accountLabel?: string;
  readonly kind: UsageWindowKind;
  /** Per-model carve-out display name (Anthropic `weekly_scoped`). */
  readonly scope?: string;
}

/**
 * The prefix every id this account's windows carry. A feeder that stops
 * reporting an account (the poller's Anthropic arms once a cliproxy hub owns
 * Claude quota) retracts its published windows by this prefix.
 */
export const usageWindowAccountPrefix = (
  account: Pick<UsageWindowIdentity, "accountKey" | "accountLabel">,
): string => `${account.accountKey}:${account.accountLabel ?? ""}:`;

export const encodeUsageWindowId = (identity: UsageWindowIdentity): string =>
  [
    `${usageWindowAccountPrefix(identity)}${identity.kind}`,
    ...(identity.scope ? [identity.scope] : []),
  ].join(":");

export const decodeUsageWindowId = (id: string): UsageWindowIdentity | null => {
  const [accountKey, accountLabel, kind, ...scope] = id.split(":");
  if (!accountKey || (kind !== "primary" && kind !== "secondary")) return null;
  return {
    accountKey,
    ...(accountLabel ? { accountLabel } : {}),
    kind,
    ...(scope.length > 0 ? { scope: scope.join(":") } : {}),
  };
};
