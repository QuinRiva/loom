/**
 * loom: a thread's prompt-cache liveness, as the sidebar's fuel ring and hover
 * card show it (and the mobile list later). Anthropic reports no expiry, so it
 * is an estimate: the cache lives `ttl` after its last touch — the end of the
 * last real request or a pi warming ping — and a cold reply re-writes the whole
 * context instead of reading it.
 */
import type { LoomCacheRetention } from "@t3tools/contracts";

const MINUTE_MS = 60_000;

export const CACHE_TTL_MS: Record<LoomCacheRetention, number> = {
  long: 60 * MINUTE_MS,
  short: 5 * MINUTE_MS,
};

/** Under this much left the cache is "expiring": the only urgent colour. */
export const CACHE_EXPIRING_MS = 10 * MINUTE_MS;

export type CacheLivenessState = "warm" | "expiring" | "cold" | "unknown";

export interface CacheLiveness {
  readonly state: CacheLivenessState;
  readonly retention: LoomCacheRetention;
  /** Null while `unknown` (no request or ping on record). */
  readonly touchedAtMs: number | null;
  readonly expiresAtMs: number | null;
  /** Negative once cold: how long ago it expired. */
  readonly remainingMs: number | null;
  /** Fuel-gauge steps: 12 five-minute steps on a 1-hour cache, 5 one-minute steps on a 5-minute one. */
  readonly steps: number;
  readonly litSteps: number;
}

/** The latest of the touch times on record; null when there are none. */
export const latestTouchMs = (...touches: ReadonlyArray<string | number | null | undefined>) =>
  touches.reduce<number | null>((latest, touch) => {
    const ms = typeof touch === "string" ? Date.parse(touch) : touch;
    return ms == null || Number.isNaN(ms) ? latest : Math.max(latest ?? ms, ms);
  }, null);

export function cacheLiveness(
  nowMs: number,
  touchedAtMs: number | null,
  retention: LoomCacheRetention,
): CacheLiveness {
  const ttlMs = CACHE_TTL_MS[retention];
  const stepMs = retention === "long" ? 5 * MINUTE_MS : MINUTE_MS;
  const steps = ttlMs / stepMs;
  if (touchedAtMs === null) {
    return {
      state: "unknown",
      retention,
      touchedAtMs,
      expiresAtMs: null,
      remainingMs: null,
      steps,
      litSteps: 0,
    };
  }
  const expiresAtMs = touchedAtMs + ttlMs;
  const remainingMs = expiresAtMs - nowMs;
  return {
    state: remainingMs <= 0 ? "cold" : remainingMs <= CACHE_EXPIRING_MS ? "expiring" : "warm",
    retention,
    touchedAtMs,
    expiresAtMs,
    remainingMs,
    steps,
    litSteps: Math.min(steps, Math.max(0, Math.ceil(remainingMs / stepMs))),
  };
}

/** API-list $ per million tokens. Refreshed by the monthly platform update. */
export interface CacheModelPrice {
  readonly label: string;
  readonly input: number;
  readonly cacheRead: number;
  readonly write5m: number;
  readonly write1h: number;
}

const PRICES: Record<string, CacheModelPrice> = {
  "claude-opus-5-5": { label: "Opus 5.5", input: 4, cacheRead: 0.2, write5m: 5, write1h: 8 },
  "claude-fable-5-1": {
    label: "Fable 5.1",
    input: 10,
    cacheRead: 0.25,
    write5m: 12.5,
    write1h: 20,
  },
  "claude-sonnet-5-5": { label: "Sonnet 5.5", input: 2, cacheRead: 0.1, write5m: 2.5, write1h: 4 },
  "claude-opus-5": { label: "Opus 5", input: 5, cacheRead: 0.5, write5m: 6.25, write1h: 10 },
};

/** The price row for a model slug (`cliproxy/claude-opus-5-5` or bare); null if unpriced. */
export const cacheModelPrice = (model: string): CacheModelPrice | null =>
  PRICES[model.slice(model.lastIndexOf("/") + 1)] ?? null;

export const cacheWritePrice = (price: CacheModelPrice, retention: LoomCacheRetention) =>
  retention === "long" ? price.write1h : price.write5m;

/**
 * What a cold reply costs over a warm one, in API-list dollars: the context is
 * re-written at the arm's write price instead of read at the cache-read price.
 */
export const cacheStakeUsd = (
  contextTokens: number,
  price: CacheModelPrice,
  retention: LoomCacheRetention,
) => (contextTokens / 1e6) * (cacheWritePrice(price, retention) - price.cacheRead);

/** A warm reply's read of the cached context, in API-list dollars. */
export const cacheWarmReadUsd = (contextTokens: number, price: CacheModelPrice) =>
  (contextTokens / 1e6) * price.cacheRead;
