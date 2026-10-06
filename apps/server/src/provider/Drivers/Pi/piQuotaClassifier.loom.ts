/**
 * Loom's pi quota classifier (pull 9 Phase 3 track 3c, P3-11).
 *
 * Upstream's `UsageLimitRecoveryWorker` parks and resumes a thread whose run
 * failed with `class: "usage_limit"` and a future `resetAt`; upstream's pi
 * adapter reports every model error as `provider_error`. `classifyPiFailure`
 * reads pi's error text (plus Loom's provider-health marks when the text names
 * no reset) and says whether the failure is a usage limit and when it resets,
 * so the adapter hunk can make pi's quota errors look like upstream's.
 *
 * Pure: the caller passes the health snapshot and the clock.
 *
 * @module provider/Drivers/Pi/piQuotaClassifier
 */
import type { IsoDateTime } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { PI_QUOTA_ERROR_RE, subscriptionScopeForSelection } from "../../exhaustionMapping.ts";
import { type ExhaustionMark, isActive, matches } from "../../Services/ProviderHealthRegistry.ts";

export interface ClassifiedPiFailure {
  readonly usageLimit: boolean;
  /** Absent when neither the text nor a telemetry mark names a reset; never guessed. */
  readonly resetAt?: IsoDateTime;
  /** The provider's own wait, when the text carries one. */
  readonly retryAfterMs?: number;
  /** The tripped window ("5-hour", "weekly") when `resetAt` came from a telemetry mark. */
  readonly windowLabel?: string;
}

/** The selection the failed turn ran with (pi slug in `model`, the pi instance in `instanceId`). */
export interface PiFailureSelection {
  readonly instanceId: string;
  readonly model: string;
}

/** A malformed request replays identically; never a window, whatever else it says. */
const BAD_REQUEST_RE = /invalid_request_error|\[HTTP 400\]|^400\b|should match pattern/i;
/** CLI Proxy's pool-wide refusal: every pooled account for the model is benched (DL-77 defect 1). */
const POOL_COOLING_DOWN_RE = /are cooling down/i;
/** A plain throttle; a usage limit only with a provider wait or an active mark. */
const RATE_LIMITED_RE = /\b429\b|rate.?limit|too many requests/i;
/** pi-ai's text for a `Retry-After` above its provider retry cap. */
const SERVER_RETRY_DELAY_RE = /Server requested (\d+)s retry delay/i;
/** pi-ai's ChatGPT usage-limit text, from the response's `resets_at`. */
const CODEX_TRY_AGAIN_RE = /Try again in ~(\d+) min/i;

const isoAt = (ms: number): IsoDateTime => DateTime.formatIso(DateTime.makeUnsafe(ms));

const retryAfterMsOf = (text: string): number | undefined => {
  const seconds = SERVER_RETRY_DELAY_RE.exec(text)?.[1];
  if (seconds !== undefined) return Number(seconds) * 1_000;
  const minutes = CODEX_TRY_AGAIN_RE.exec(text)?.[1];
  return minutes === undefined ? undefined : Number(minutes) * 60_000;
};

export function classifyPiFailure(
  errorText: string,
  selection: PiFailureSelection,
  healthSnapshot: ReadonlyArray<ExhaustionMark>,
  nowMs: number,
): ClassifiedPiFailure {
  if (BAD_REQUEST_RE.test(errorText)) return { usageLimit: false };
  // A pooled instance meters under its own id, so the instance stands in when the slug has no account.
  const { accountKey, modelId } = subscriptionScopeForSelection(
    selection,
    new Set([selection.instanceId]),
  );
  const marks = healthSnapshot.filter(
    (mark) => accountKey !== null && isActive(mark, nowMs) && matches(mark, accountKey, modelId),
  );
  const retryAfterMs = retryAfterMsOf(errorText);
  const usageLimit =
    PI_QUOTA_ERROR_RE.test(errorText) ||
    POOL_COOLING_DOWN_RE.test(errorText) ||
    (RATE_LIMITED_RE.test(errorText) && (retryAfterMs !== undefined || marks.length > 0));
  if (!usageLimit) return { usageLimit: false };
  if (retryAfterMs !== undefined)
    return {
      usageLimit,
      retryAfterMs,
      resetAt: isoAt(nowMs + retryAfterMs),
    };
  // The account is back only when every active mark clears; an open-ended one names no reset.
  const telemetry = marks.filter((mark) => mark.source === "telemetry");
  if (telemetry.length === 0 || telemetry.some((mark) => mark.until === null))
    return { usageLimit };
  const latest = telemetry.reduce((a, b) => (Date.parse(b.until!) > Date.parse(a.until!) ? b : a));
  return {
    usageLimit,
    resetAt: isoAt(Date.parse(latest.until!)),
    ...(latest.windowLabel === undefined ? {} : { windowLabel: latest.windowLabel }),
  };
}
