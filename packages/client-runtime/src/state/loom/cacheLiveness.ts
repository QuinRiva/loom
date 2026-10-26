/**
 * loom: when a thread's prompt cache really goes cold if nobody replies, counting pi's keep-alive
 * pings. Anthropic reports no expiry, so the cache lives `ttl` past its last touch (request or ping);
 * pings are replayed from the row: `delay` after the last dispatch, then after each ping, within the
 * arm's horizon. A ping not landed by pi's own refresh deadline is not coming.
 */
import {
  LOOM_CACHE_HORIZON_MS,
  type LoomCacheRetention,
  type LoomThreadCache,
} from "@t3tools/contracts";

const MINUTE_MS = 60_000;

export const CACHE_TTL_MS: Record<LoomCacheRetention, number> = {
  long: 60 * MINUTE_MS,
  short: 5 * MINUTE_MS,
};

/** pi pings at 90% of the TTL: 54 min on a 1-hour cache, 4.5 min on a 5-minute one. */
const pingDelayMs = (retention: LoomCacheRetention) => 0.9 * CACHE_TTL_MS[retention];

/**
 * How late a ping may land before it is taken as not coming: pi abandons one past half its
 * pre-expiry margin; 30 s more covers the transport. 3.5 min (1-hour), 45 s (5-minute).
 */
const pingGraceMs = (retention: LoomCacheRetention) =>
  (CACHE_TTL_MS[retention] - pingDelayMs(retention)) / 2 + 30_000;

/** Under this much left the cache is "expiring": the only urgent colour. */
export const CACHE_EXPIRING_MS = 10 * MINUTE_MS;

export type CacheLivenessState = "warm" | "expiring" | "cold" | "unknown";

export interface CacheLiveness {
  readonly state: CacheLivenessState;
  readonly retention: LoomCacheRetention;
  /** Null while `unknown` (no request or ping on record): the end of the last request or ping. */
  readonly touchedAtMs: number | null;
  /** When the cache goes cold if nobody replies, counting the pings still coming. */
  readonly expiresAtMs: number | null;
  /** Negative once cold: how long ago it expired. */
  readonly remainingMs: number | null;
  /** A keep-alive ping is still coming: `expiresAtMs` is after the last one pi will send. */
  readonly keptWarm: boolean;
  /** Fuel-gauge steps: 12 five-minute steps on a 1-hour cache, 5 one-minute steps on a 5-minute one. */
  readonly steps: number;
  readonly litSteps: number;
}

const ms = (iso: string | null) => (iso === null ? null : Date.parse(iso));

export function cacheLiveness(nowMs: number, facts: LoomThreadCache): CacheLiveness {
  const { retention, warming } = facts;
  const ttlMs = CACHE_TTL_MS[retention];
  const delayMs = pingDelayMs(retention);
  const stepMs = retention === "long" ? 5 * MINUTE_MS : MINUTE_MS;
  const steps = ttlMs / stepMs;
  const startedMs = ms(facts.requestStartedAt);
  const endedMs = ms(facts.requestEndedAt);
  const pingedMs = ms(facts.pingedAt);
  if (endedMs === null) {
    return {
      state: "unknown",
      retention,
      touchedAtMs: null,
      expiresAtMs: null,
      remainingMs: null,
      keptWarm: false,
      steps,
      litSteps: 0,
    };
  }
  const touchedAtMs = Math.max(endedMs, pingedMs ?? endedMs);
  // pi counts the next ping from the last ping's end, else from the request's dispatch.
  const baseMs = pingedMs !== null && pingedMs > endedMs ? pingedMs : startedMs;
  const horizonMs = startedMs === null ? null : startedMs + LOOM_CACHE_HORIZON_MS[retention];
  const keptWarm =
    warming === "scheduled" &&
    baseMs !== null &&
    horizonMs !== null &&
    baseMs + delayMs <= horizonMs &&
    nowMs < baseMs + delayMs + pingGraceMs(retention);
  // Kept warm: alive until a TTL after the last ping the horizon admits.
  const expiresAtMs = keptWarm
    ? baseMs + Math.floor((horizonMs - baseMs) / delayMs) * delayMs + ttlMs
    : touchedAtMs + ttlMs;
  const remainingMs = expiresAtMs - nowMs;
  return {
    state:
      remainingMs <= 0
        ? "cold"
        : // Orange only once no ping is known to be coming; undecided stays neutral.
          remainingMs <= CACHE_EXPIRING_MS && !keptWarm && warming !== null
          ? "expiring"
          : "warm",
    retention,
    touchedAtMs,
    expiresAtMs,
    remainingMs,
    keptWarm,
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
