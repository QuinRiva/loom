/**
 * Account-usage fetchers for the driver-independent subscription-usage poller.
 *
 * The endpoints, request headers, and response field meanings are derived from
 * `@latentminds/pi-quotas@0.2.6` (MIT, https://github.com/latentminds-ai/pi-quotas),
 * re-expressed as Effect-native `HttpClient` calls + `Schema` decoders because
 * the repo lint plugin (`effect-tsgo`) forbids raw `fetch`/`Date`. Each fetcher
 * maps straight onto the shared {@link AccountUsageWindow} contract rather than
 * carrying pi-quotas' intermediate window type.
 *
 * Scales verified live (2026-06-30): Anthropic `utilization` and Codex
 * `used_percent` are BOTH already 0-100, so they map to `usedPercent` with no
 * rescaling — only a defensive clamp. Codex `reset_at` is epoch seconds;
 * Anthropic `resets_at` is already an ISO-8601 string.
 *
 * @module provider/quotas/piQuotas
 */
import type { AccountUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

const REQUEST_TIMEOUT = "15 seconds";

// Rolling windows the pill models: 5-hour (primary) and 7-day (secondary).
const PRIMARY_WINDOW_MINS = 5 * 60;
const SECONDARY_WINDOW_MINS = 7 * 24 * 60;

/** Normalised per-provider usage the poller folds into a snapshot. */
export interface ProviderUsage {
  readonly windows: ReadonlyArray<AccountUsageWindow>;
  readonly planType: string | null;
}

const clampPercent = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;

/** Codex hands back epoch seconds (occasionally ms); Anthropic an ISO string. */
const epochToIso = (epoch: number | null | undefined): string | null => {
  if (epoch == null || !Number.isFinite(epoch) || epoch <= 0) return null;
  return DateTime.formatIso(DateTime.makeUnsafe(epoch > 1e11 ? epoch : epoch * 1000));
};

// ── Anthropic: GET /api/oauth/usage ─────────────────────────────────────────
const AnthropicWindow = Schema.Struct({
  utilization: Schema.Number,
  resets_at: Schema.optional(Schema.NullOr(Schema.String)),
});
const AnthropicUsageResponse = Schema.Struct({
  five_hour: Schema.optional(Schema.NullOr(AnthropicWindow)),
  seven_day: Schema.optional(Schema.NullOr(AnthropicWindow)),
});

const anthropicWindow = (
  source: typeof AnthropicWindow.Type | null | undefined,
  kind: AccountUsageWindow["kind"],
  windowDurationMins: number,
): AccountUsageWindow | null =>
  source
    ? {
        kind,
        usedPercent: clampPercent(source.utilization),
        resetsAt: source.resets_at ?? null,
        windowDurationMins,
      }
    : null;

export const fetchAnthropicUsage = Effect.fn("quotas.anthropic")(function* (
  httpClient: HttpClient.HttpClient,
  token: string,
) {
  const data = yield* HttpClientRequest.get("https://api.anthropic.com/api/oauth/usage").pipe(
    HttpClientRequest.setHeaders({
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      Accept: "application/json",
    }),
    httpClient.execute,
    Effect.flatMap(HttpClientResponse.schemaBodyJson(AnthropicUsageResponse)),
    Effect.timeout(REQUEST_TIMEOUT),
  );
  return {
    windows: [
      anthropicWindow(data.five_hour, "primary", PRIMARY_WINDOW_MINS),
      anthropicWindow(data.seven_day, "secondary", SECONDARY_WINDOW_MINS),
    ].filter((window): window is AccountUsageWindow => window !== null),
    planType: null,
  } satisfies ProviderUsage;
});

// ── Codex: GET chatgpt.com/backend-api/wham/usage ───────────────────────────
const CodexWindow = Schema.Struct({
  used_percent: Schema.Number,
  limit_window_seconds: Schema.optional(Schema.NullOr(Schema.Number)),
  reset_at: Schema.optional(Schema.NullOr(Schema.Number)),
});
const CodexUsageResponse = Schema.Struct({
  plan_type: Schema.optional(Schema.NullOr(Schema.String)),
  rate_limit: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        primary_window: Schema.optional(Schema.NullOr(CodexWindow)),
        secondary_window: Schema.optional(Schema.NullOr(CodexWindow)),
      }),
    ),
  ),
});

const codexWindow = (
  source: typeof CodexWindow.Type | null | undefined,
  kind: AccountUsageWindow["kind"],
  fallbackMins: number,
): AccountUsageWindow | null =>
  source
    ? {
        kind,
        usedPercent: clampPercent(source.used_percent),
        resetsAt: epochToIso(source.reset_at),
        windowDurationMins: source.limit_window_seconds
          ? Math.round(source.limit_window_seconds / 60)
          : fallbackMins,
      }
    : null;

export const fetchCodexUsage = Effect.fn("quotas.codex")(function* (
  httpClient: HttpClient.HttpClient,
  token: string,
  accountId: string,
) {
  const data = yield* HttpClientRequest.get("https://chatgpt.com/backend-api/wham/usage").pipe(
    HttpClientRequest.setHeaders({
      Authorization: `Bearer ${token}`,
      "ChatGPT-Account-Id": accountId,
      Accept: "application/json",
      Origin: "https://chatgpt.com",
      Referer: "https://chatgpt.com/",
      "User-Agent": "Mozilla/5.0",
    }),
    httpClient.execute,
    Effect.flatMap(HttpClientResponse.schemaBodyJson(CodexUsageResponse)),
    Effect.timeout(REQUEST_TIMEOUT),
  );
  const rateLimit = data.rate_limit ?? undefined;
  return {
    windows: [
      codexWindow(rateLimit?.primary_window, "primary", PRIMARY_WINDOW_MINS),
      codexWindow(rateLimit?.secondary_window, "secondary", SECONDARY_WINDOW_MINS),
    ].filter((window): window is AccountUsageWindow => window !== null),
    planType: data.plan_type ?? null,
  } satisfies ProviderUsage;
});
