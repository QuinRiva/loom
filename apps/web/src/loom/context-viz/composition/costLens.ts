// loom: the composition's money figures: the cache arm's list prices from `cacheLiveness.ts`, the
// arm read off what the thread's own calls paid per written token.
import {
  type CacheModelPrice,
  cacheModelPrice,
  cacheWritePrice,
} from "@t3tools/client-runtime/state/loom/cacheLiveness";
import type { LoomContextItem, LoomContextReport } from "@t3tools/contracts";

import { formatCostUsd } from "../../costFormat";

export interface CachePrices {
  readonly price: CacheModelPrice;
  /** $ per token. */
  readonly write: number;
  readonly read: number;
}

export function cachePrices(report: LoomContextReport): CachePrices | null {
  const price = report.model === null ? null : cacheModelPrice(report.model);
  if (price === null) return null;
  const paid = report.calls.findLast((call) => call.writeUnitUsd !== null)?.writeUnitUsd ?? null;
  const long =
    paid === null || Math.abs(paid * 1e6 - price.write1h) <= Math.abs(paid * 1e6 - price.write5m);
  return {
    price,
    write: cacheWritePrice(price, long ? "long" : "short") / 1e6,
    read: price.cacheRead / 1e6,
  };
}

/** What re-writing the whole latest window would cost if the cache went cold now. */
export const coldCacheUsd = (report: LoomContextReport, prices: CachePrices | null) =>
  prices === null ? null : report.totals.latestCtx * prices.write;

/**
 * Dropping the older copies of `echoes` mid-window: everything from the first copy on is re-written
 * once, less what is dropped; each later call then reads that much less.
 */
export function pruneTradeoff(
  window: ReadonlyArray<LoomContextItem>,
  echoes: ReadonlyArray<LoomContextItem>,
  prices: CachePrices,
) {
  const first = Math.min(...echoes.map((item) => item.firstSeenCall));
  const latest = new Map<string | null, LoomContextItem>();
  for (const item of echoes) {
    const held = latest.get(item.tool);
    if (!held || item.firstSeenCall >= held.firstSeenCall) latest.set(item.tool, item);
  }
  const dropped =
    echoes.reduce((sum, item) => sum + item.tokens, 0) -
    [...latest.values()].reduce((sum, item) => sum + item.tokens, 0);
  const rewrite =
    window
      .filter((item) => item.firstSeenCall >= first)
      .reduce((sum, item) => sum + item.tokens, 0) - dropped;
  return {
    dropped,
    older: echoes.length - latest.size,
    rewrite,
    rewriteUsd: rewrite * prices.write,
    savedPerCallUsd: dropped * prices.read,
  };
}

export const formatUsd = (usd: number) => formatCostUsd(usd) ?? "$0";
