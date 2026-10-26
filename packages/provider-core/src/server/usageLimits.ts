import type {
  ProviderUsageLimitsUpdate,
  ServerProviderAuthStatus,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";

const WINDOW_KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

export function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

function sortWindows(
  windows: Iterable<ServerProviderUsageWindow>,
): ReadonlyArray<ServerProviderUsageWindow> {
  return [...windows].toSorted(
    (left, right) =>
      WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind] ||
      left.id.localeCompare(right.id),
  );
}

export function makeUsageLimits(input: {
  readonly checkedAt: string;
  readonly windows: Iterable<ServerProviderUsageWindow>;
}): ServerProviderUsageLimits {
  return { checkedAt: input.checkedAt, windows: sortWindows(input.windows) };
}

export function makeUnavailableUsageLimits(input: {
  readonly checkedAt: string;
  readonly reason: "unsupported" | "probeFailed";
  readonly message?: string;
}): ServerProviderUsageLimits {
  return {
    checkedAt: input.checkedAt,
    windows: [],
    unavailable: {
      reason: input.reason,
      ...(input.message ? { message: input.message } : {}),
    },
  };
}

export function applyUsageLimitsUpdate(input: {
  readonly previous: ServerProviderUsageLimits | undefined;
  readonly update: ProviderUsageLimitsUpdate;
  readonly checkedAt: string;
}): ServerProviderUsageLimits | undefined {
  const { previous, update } = input;
  if (update.windows.length === 0 || previous?.unavailable?.reason === "unsupported") {
    return previous;
  }
  const merged = new Map(previous?.windows.map((window) => [window.id, window] as const));
  // Codex repeats unchanged limits on token ticks; avoid allocating snapshots for no-ops.
  let changed = false;
  for (const window of update.windows) {
    const existing = merged.get(window.id);
    const next: ServerProviderUsageWindow = {
      ...window,
      usedPercent: clampPercent(window.usedPercent),
      ...(window.resetsAt === undefined && existing?.resetsAt !== undefined
        ? { resetsAt: existing.resetsAt }
        : {}),
      ...(window.windowDurationMins === undefined && existing?.windowDurationMins !== undefined
        ? { windowDurationMins: existing.windowDurationMins }
        : {}),
    };
    if (existing === undefined || !usageWindowEquals(existing, next)) {
      merged.set(window.id, next);
      changed = true;
    }
  }
  if (!changed && previous !== undefined) {
    return previous;
  }
  const unavailable =
    previous === undefined ? { reason: "probeFailed" as const } : previous.unavailable;
  return {
    ...makeUsageLimits({ checkedAt: input.checkedAt, windows: merged.values() }),
    ...(previous?.resetCredits !== undefined ? { resetCredits: previous.resetCredits } : {}),
    ...(unavailable !== undefined ? { unavailable } : {}),
  };
}

/**
 * loom: drop the published windows of accounts a feeder has stood down.
 *
 * `applyUsageLimitsUpdate` only ever upserts and `resolveUsageLimitsAfterProbe`
 * holds what it published across probes, so a reading nobody refreshes any more
 * would otherwise sit frozen on the card until the server restarts. That is
 * exactly what happens when a cliproxy hub takes over Claude quota and the
 * poller's Anthropic arms stand down. Matching is by account prefix
 * (`usageWindowAccountPrefix`), so one account's whole set — 5-hour, weekly and
 * every per-model carve-out — goes together and the other accounts on the card
 * (Codex) are untouched. Unchanged input returns `previous` so no republish.
 */
export function removeUsageLimitWindows(input: {
  readonly previous: ServerProviderUsageLimits | undefined;
  readonly accountPrefixes: ReadonlyArray<string>;
  readonly checkedAt: string;
}): ServerProviderUsageLimits | undefined {
  const { previous } = input;
  const kept = previous?.windows.filter(
    (window) => !input.accountPrefixes.some((prefix) => window.id.startsWith(prefix)),
  );
  if (previous === undefined || kept === undefined || kept.length === previous.windows.length) {
    return previous;
  }
  return {
    ...makeUsageLimits({ checkedAt: input.checkedAt, windows: kept }),
    ...(previous.resetCredits !== undefined ? { resetCredits: previous.resetCredits } : {}),
  };
}

function usageWindowEquals(a: ServerProviderUsageWindow, b: ServerProviderUsageWindow): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.label === b.label &&
    a.usedPercent === b.usedPercent &&
    a.resetsAt === b.resetsAt &&
    a.windowDurationMins === b.windowDurationMins
  );
}

/**
 * loom: a probe that carries no limits at all (`probed === undefined`) is
 * uninformative and keeps the published reading. pi never reads its own quota —
 * the subscription-usage poller is its only feeder — and the other drivers omit
 * the field on their not-installed and timed-out paths for the same "we did not
 * look" reason. Signing out is the one silent probe that is authoritative: those
 * windows belong to an account that is gone, so an `unauthenticated` probe
 * clears them.
 */
export function resolveUsageLimitsAfterProbe(input: {
  readonly published: ServerProviderUsageLimits | undefined;
  readonly probed: ServerProviderUsageLimits | undefined;
  // loom: the probe's own auth status, the only thing that tells a silent
  // probe apart from a signed-out one. Omitted reads as "still signed in".
  readonly probedAuthStatus?: ServerProviderAuthStatus;
}): ServerProviderUsageLimits | undefined {
  const { published, probed } = input;
  if (probed?.unavailable?.reason === "probeFailed" && published && !published.unavailable) {
    return published;
  }
  // loom: see the note above — a silent probe keeps the published reading.
  if (probed === undefined && published && input.probedAuthStatus !== "unauthenticated") {
    return published;
  }
  if (
    published &&
    probed &&
    !published.unavailable &&
    !probed.unavailable &&
    Date.parse(published.checkedAt) > Date.parse(probed.checkedAt)
  ) {
    return { ...probed, checkedAt: published.checkedAt, windows: published.windows };
  }
  return probed;
}
