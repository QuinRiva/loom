/**
 * Overlays active account-wide exhaustion marks onto the `ServerProvider` snapshots the config
 * stream serves, as `status: "warning"` with a reason. Model-scoped marks are ignored: one model
 * does not make the provider unavailable. Pure, so it serves both the stream and the initial load.
 */
import type { ServerProvider } from "@t3tools/contracts";

import { ACCOUNT_WIDE_SCOPE, type ExhaustionMark, isActive } from "./ProviderHealthRegistry.ts";

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
  const clock = formatResetClock(mark.until);
  return clock ? `Subscription limit reached, resets ${clock}` : "Subscription limit reached";
};

/**
 * A mark matches a provider whose `instanceId` or `driver` equals its account key (the key's two
 * forms). Providers already `error`/`disabled` are untouched: a warning never downgrades a failure.
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
