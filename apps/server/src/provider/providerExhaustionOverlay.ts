/**
 * Overlay active account-wide exhaustion marks from {@link ProviderHealthRegistry}
 * onto the `ServerProvider` snapshots the config WS stream serves (§8.2). A
 * subscription account (`codex`/`claudeAgent`) whose whole account is exhausted
 * or paused surfaces on its provider card as `status: "warning"` with a
 * human-readable reason. Model-scoped marks are deliberately ignored here — a
 * single carved-out model does not make the provider unavailable, and the pill's
 * scoped bars already show it.
 *
 * Pure and synchronous so it composes into both the live stream and the initial
 * `loadServerConfig` snapshot. Rides the existing `ServerProvider` contract; no
 * schema change.
 */
import type { ServerProvider } from "@t3tools/contracts";

import {
  ACCOUNT_WIDE_SCOPE,
  type ExhaustionMark,
  isActive,
} from "./Services/ProviderHealthRegistry.ts";

const RESET_CLOCK = new Intl.DateTimeFormat([], {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const formatResetClock = (until: string | null): string | null => {
  if (until === null) return null;
  const ms = Date.parse(until);
  return Number.isFinite(ms) ? RESET_CLOCK.format(ms) : null;
};

const exhaustionMessage = (mark: ExhaustionMark): string => {
  if (mark.source === "manual") return "Provider paused — failover routing will avoid it";
  const clock = formatResetClock(mark.until);
  return clock ? `Subscription limit reached — resets ${clock}` : "Subscription limit reached";
};

/**
 * Return `providers` with an exhaustion overlay applied. A provider matches a
 * mark when the mark's account key equals the provider's `instanceId` or its
 * `driver` (the two forms the account key can take). Providers already in a
 * harder state (`error`/`disabled`) are left untouched — warning never
 * downgrades a real failure.
 */
export const overlayProviderExhaustion = (
  providers: ReadonlyArray<ServerProvider>,
  marks: ReadonlyArray<ExhaustionMark>,
  now: number,
): ReadonlyArray<ServerProvider> => {
  const accountWide = new Map<string, ExhaustionMark>();
  for (const mark of marks) {
    if (mark.modelScope === ACCOUNT_WIDE_SCOPE && isActive(mark, now)) {
      accountWide.set(mark.accountKey, mark);
    }
  }
  if (accountWide.size === 0) return providers;

  return providers.map((provider) => {
    const mark = accountWide.get(provider.instanceId) ?? accountWide.get(provider.driver);
    if (!mark || provider.status === "error" || provider.status === "disabled") return provider;
    return { ...provider, status: "warning", message: exhaustionMessage(mark) };
  });
};
