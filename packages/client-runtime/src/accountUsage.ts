import {
  type AccountUsageSnapshot,
  type AccountUsageWindow,
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
} from "@t3tools/contracts";

/**
 * Shared derive/format logic for the account subscription-usage pill (5-hour +
 * weekly limits). Mirrors `lib/contextWindow.ts` so web and mobile read the same
 * pure selector. Pure functions only — no IO, no atoms.
 */

export type AccountUsageTone = "quiet" | "warning" | "destructive";

/** A window is loud at ≥80% (warning) and ≥100% (destructive/throttled). */
export const ACCOUNT_USAGE_WARNING_PERCENT = 80;
export const ACCOUNT_USAGE_DESTRUCTIVE_PERCENT = 100;

export function accountUsageTone(usedPercent: number): AccountUsageTone {
  if (usedPercent >= ACCOUNT_USAGE_DESTRUCTIVE_PERCENT) return "destructive";
  if (usedPercent >= ACCOUNT_USAGE_WARNING_PERCENT) return "warning";
  return "quiet";
}

export interface AccountUsageWindowView {
  readonly kind: AccountUsageWindow["kind"];
  readonly label: string;
  readonly usedPercent: number;
  readonly tone: AccountUsageTone;
  readonly resetsAt: string | null;
  /** e.g. "resets in 2h 14m"; null when no/elapsed reset time is known. */
  readonly resetLabel: string | null;
}

export interface AccountUsageView {
  /** Stable per-account key (instance id, falling back to provider name). */
  readonly key: string;
  readonly providerName: string;
  readonly providerDisplayName: string;
  readonly planType: string | null;
  /** Windows ordered primary (5-hour) then secondary (weekly). */
  readonly windows: ReadonlyArray<AccountUsageWindowView>;
  /** The 5-hour (primary) window's used-% — the number the compact pill shows. */
  readonly displayPercent: number;
  /** Tone derived from the loudest window, so either window can drive the highlight. */
  readonly tone: AccountUsageTone;
  readonly observedAt: string;
}

const WINDOW_ORDER: Record<AccountUsageWindow["kind"], number> = { primary: 0, secondary: 1 };

function windowLabel(kind: AccountUsageWindow["kind"]): string {
  return kind === "primary" ? "5-hour limit" : "Weekly limit";
}

function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

/** Format the time until a reset as a compact "resets in …" label. */
export function formatAccountUsageReset(resetsAt: string | null, nowMs: number): string | null {
  if (resetsAt === null) return null;
  const resetMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetMs)) return null;
  const diff = resetMs - nowMs;
  if (diff <= 0) return null;
  const minutes = Math.floor(diff / 60_000);
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `resets in ${days}d ${hours}h`;
  if (hours > 0) return `resets in ${hours}h ${mins}m`;
  if (mins > 0) return `resets in ${mins}m`;
  return "resets in <1m";
}

function providerDisplayName(providerName: string): string {
  return PROVIDER_DISPLAY_NAMES[providerName as ProviderDriverKind] ?? providerName;
}

function toWindowView(window: AccountUsageWindow, nowMs: number): AccountUsageWindowView {
  const usedPercent = clampPercent(window.usedPercent);
  return {
    kind: window.kind,
    label: windowLabel(window.kind),
    usedPercent,
    tone: accountUsageTone(usedPercent),
    resetsAt: window.resetsAt,
    resetLabel: formatAccountUsageReset(window.resetsAt, nowMs),
  };
}

/**
 * Derive the per-account pill views from the raw snapshot list. Snapshots with
 * no windows are dropped; when the same account key appears more than once the
 * latest `observedAt` wins (defensive — the server registry already dedupes by
 * instance). Result is ordered by provider display name for a stable pill row.
 */
export function deriveAccountUsageViews(
  snapshots: ReadonlyArray<AccountUsageSnapshot>,
  nowMs: number,
): ReadonlyArray<AccountUsageView> {
  const latest = new Map<string, AccountUsageSnapshot>();
  for (const snapshot of snapshots) {
    if (snapshot.windows.length === 0) continue;
    const key = snapshot.providerInstanceId ?? snapshot.providerName;
    const existing = latest.get(key);
    if (!existing || snapshot.observedAt > existing.observedAt) {
      latest.set(key, snapshot);
    }
  }

  return Array.from(latest.entries())
    .map(([key, snapshot]): AccountUsageView => {
      const windows = snapshot.windows
        .map((window) => toWindowView(window, nowMs))
        .sort((left, right) => WINDOW_ORDER[left.kind] - WINDOW_ORDER[right.kind]);
      const loudestPercent = windows.reduce((max, window) => Math.max(max, window.usedPercent), 0);
      const displayPercent =
        (windows.find((window) => window.kind === "primary") ?? windows[0])?.usedPercent ?? 0;
      return {
        key,
        providerName: snapshot.providerName,
        providerDisplayName: providerDisplayName(snapshot.providerName),
        planType: snapshot.planType,
        windows,
        displayPercent,
        tone: accountUsageTone(loudestPercent),
        observedAt: snapshot.observedAt,
      };
    })
    .sort((left, right) => left.providerDisplayName.localeCompare(right.providerDisplayName));
}
