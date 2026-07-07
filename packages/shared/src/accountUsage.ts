import type { AccountUsageSnapshot } from "@t3tools/contracts";

/**
 * Account-usage key helpers — the single source of truth for how a
 * subscription-usage snapshot is keyed, shared by the server registry, the
 * usage-dashboard query, and the client pill so the key format can never drift.
 *
 * Two distinct keys:
 *   - **routing key** (`providerInstanceId ?? providerName`): the instance an
 *     account belongs to. Exhaustion marks and failover routing key by this, so
 *     pooled accounts of one instance share it (the router fails over between
 *     them; the instance is exhausted only when ALL its accounts are).
 *   - **storage key** (routing key + label): distinguishes pooled accounts
 *     within one instance for registry storage, slope buffers, and the pill.
 *     Falls back to the routing key when there is no label (today's shape).
 */

type RoutingIdentity = Pick<AccountUsageSnapshot, "providerInstanceId" | "providerName">;
type StorageIdentity = RoutingIdentity & Pick<AccountUsageSnapshot, "accountLabel">;

export const accountUsageRoutingKey = (snapshot: RoutingIdentity): string =>
  snapshot.providerInstanceId ?? snapshot.providerName;

export const accountUsageStorageKey = (snapshot: StorageIdentity): string =>
  snapshot.accountLabel
    ? `${accountUsageRoutingKey(snapshot)}\u0000${snapshot.accountLabel}`
    : accountUsageRoutingKey(snapshot);
