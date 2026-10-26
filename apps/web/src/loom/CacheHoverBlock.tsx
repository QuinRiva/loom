/**
 * loom: the "Prompt cache" block in a sidebar row's hover card: which cache, its last touch, until
 * when pings hold it warm (or when it expires), the context and model price, and what a cold reply
 * costs over a warm one (API-list dollars). Mounted only while the card is open.
 */
import {
  cacheWarmReadUsd,
  cacheWritePrice,
} from "@t3tools/client-runtime/state/loom/cacheLiveness";
import type { LoomThreadCache } from "@t3tools/contracts";

import { resolveSidebarThreadStatus } from "../components/Sidebar.logic";
import { cn } from "../lib/utils";
import type { SidebarThreadSummary } from "../types";
import {
  CACHE_HOT_CLASS,
  type CacheView,
  cacheArmLabel,
  cacheClock,
  formatCacheDuration,
  useCacheView,
} from "./CacheFuelRing";
import { formatCostUsd } from "./costFormat";

const usd = (value: number) => formatCostUsd(value) ?? "$0.00";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span>{label}</span>
      <span className="text-right text-foreground/85 tabular-nums">{value}</span>
    </>
  );
}

/** The block from a computed view: what the preview harness renders. */
export function CacheHoverBlockView({ view, working }: { view: CacheView; working: boolean }) {
  const { liveness, price, contextTokens, stakeUsd } = view;
  const hot = liveness.state === "expiring";
  const remaining = liveness.remainingMs ?? 0;
  const head = working
    ? "Working · kept warm"
    : liveness.state === "unknown"
      ? "No call on record"
      : liveness.state === "cold"
        ? `Cold · ~${formatCacheDuration(-remaining)}`
        : `Warm · ~${formatCacheDuration(remaining)} left`;
  const tokens = contextTokens === null ? null : `${Math.round(contextTokens / 1000)}k tokens`;
  return (
    <div className="mt-1 grid gap-1.5 border-t border-border/60 pt-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-2xs tracking-wide uppercase">Prompt cache</span>
        <span
          className={cn(
            liveness.state === "warm" || working ? "font-medium text-foreground" : "",
            hot && !working && cn("font-medium", CACHE_HOT_CLASS),
          )}
        >
          {head}
        </span>
      </div>
      {working ? (
        <p>pi refreshes the cache while it runs, so there is nothing to watch until it stops.</p>
      ) : (
        <>
          <div
            aria-hidden
            className="grid h-1.5 gap-0.5"
            style={{ gridTemplateColumns: `repeat(${liveness.steps}, 1fr)` }}
          >
            {Array.from({ length: liveness.steps }, (_, i) => (
              <span
                key={i}
                className={cn(
                  "rounded-xs",
                  i >= liveness.litSteps
                    ? "bg-muted"
                    : hot
                      ? "bg-cache-hot"
                      : "bg-muted-foreground",
                )}
              />
            ))}
          </div>
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            <Row label="Cache" value={cacheArmLabel(liveness)} />
            {liveness.touchedAtMs !== null && liveness.expiresAtMs !== null ? (
              <>
                <Row label="Last call or ping ended" value={cacheClock(liveness.touchedAtMs)} />
                <Row
                  label={
                    liveness.state === "cold"
                      ? "Expired"
                      : liveness.keptWarm
                        ? "Kept warm until"
                        : "Expires"
                  }
                  value={`~${cacheClock(liveness.expiresAtMs)}`}
                />
              </>
            ) : null}
            {tokens ? <Row label="Context" value={tokens} /> : null}
            {price ? (
              <Row
                label="Model"
                value={`${price.label} · $${cacheWritePrice(price, liveness.retention)}/M write`}
              />
            ) : null}
          </div>
          {stakeUsd !== null &&
          contextTokens !== null &&
          price !== null &&
          liveness.state !== "unknown" ? (
            <div
              className={cn(
                "rounded-md px-2 py-1.5 text-foreground/85",
                hot ? "bg-cache-hot/10" : "bg-muted",
              )}
            >
              {liveness.state === "cold" ? (
                <>
                  Next reply re-writes {tokens}:{" "}
                  <span className="font-semibold tabular-nums">≈ {usd(stakeUsd)}</span> more than a
                  warm reply. Same cost now or later.
                </>
              ) : (
                <>
                  If it goes cold:{" "}
                  <span className="font-semibold tabular-nums">≈ {usd(stakeUsd)}</span> more on the
                  next reply. Warm, it reads for ≈ {usd(cacheWarmReadUsd(contextTokens, price))}.
                </>
              )}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function ConnectedHoverBlock({
  thread,
  cache,
}: {
  thread: SidebarThreadSummary;
  cache: LoomThreadCache;
}) {
  return (
    <CacheHoverBlockView
      view={useCacheView(thread, cache)}
      working={resolveSidebarThreadStatus(thread) === "working"}
    />
  );
}

/** Mount point in the thread hover card: nothing for threads without a pi cache arm. */
export function CacheHoverBlock({ thread }: { thread: SidebarThreadSummary }) {
  const cache = thread.source.workstream?.cache;
  return cache ? <ConnectedHoverBlock thread={thread} cache={cache} /> : null;
}
