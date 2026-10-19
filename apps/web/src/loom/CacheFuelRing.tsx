/**
 * loom: the prompt-cache fuel ring on sidebar and command-palette thread rows —
 * counting down to when the cache really goes cold, keep-alive pings included:
 * neutral while warm or kept warm, orange in the last 10 minutes once no ping is
 * coming, a grey snowflake once cold. Shown only on rows that are the user's move (never Working, Waiting on
 * sub-threads, Snoozed or Settled) and only on pi threads with a cache arm.
 * Re-evaluates on the shared minute tick; never animates.
 */
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type CacheLiveness,
  type CacheModelPrice,
  cacheLiveness,
  cacheModelPrice,
  cacheStakeUsd,
} from "@t3tools/client-runtime/state/loom/cacheLiveness";
import {
  cacheStateKey,
  getCacheState,
  subscribeCacheState,
} from "@t3tools/client-runtime/state/loom/cacheState";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import type { LoomThreadCache } from "@t3tools/contracts";
import { SnowflakeIcon } from "lucide-react";
import { useSyncExternalStore } from "react";

import { resolveSidebarThreadStatus } from "../components/Sidebar.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useNowMinute } from "../hooks/useNowMinute";
import { cn } from "../lib/utils";
import type { SidebarThreadSummary } from "../types";
import { useLoomSubThreadsUnsettled } from "./LoomRollupBadge";

export const CACHE_HOT_CLASS = "text-cache-hot";

export interface CacheView {
  readonly liveness: CacheLiveness;
  readonly price: CacheModelPrice | null;
  readonly contextTokens: number | null;
  /** Null when the model is unpriced or the context size is unknown. */
  readonly stakeUsd: number | null;
}

export const cacheView = (
  liveness: CacheLiveness,
  model: string,
  contextTokens: number | null,
): CacheView => {
  const price = cacheModelPrice(model);
  const tokens = contextTokens || null; // 0 = nothing measured yet
  return {
    liveness,
    price,
    contextTokens: tokens,
    stakeUsd:
      price === null || tokens === null ? null : cacheStakeUsd(tokens, price, liveness.retention),
  };
};

const minuteIso = (nowMinute: string) => `${nowMinute}:00.000Z`;

/** The thread's cache view on the minute tick, from its live cache row, else the snapshot's. */
export function useCacheView(thread: SidebarThreadSummary, cache: LoomThreadCache): CacheView {
  const nowMinute = useNowMinute();
  const key = cacheStateKey(thread.environmentId, thread.id);
  const subscribe = (listener: () => void) => subscribeCacheState(key, listener);
  const live = useSyncExternalStore(subscribe, () => getCacheState(key));
  // The minute tick is the clock: Date.now() between ticks would make renders disagree.
  const nowMs = Date.parse(minuteIso(nowMinute));
  return cacheView(
    cacheLiveness(nowMs, live ?? cache),
    thread.modelSelection.model,
    thread.source.workstream?.contextUsage?.usedTokens ?? null,
  );
}

const MINUTE_MS = 60_000;

/** `38m`, `1h 5m`, `3h`. */
export const formatCacheDuration = (ms: number) => {
  const minutes = Math.max(1, Math.round(ms / MINUTE_MS));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 || hours >= 3 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
};

/** Row-tooltip dollars, rounded: `96¢`, `$1.6`, `$4`. */
const formatStakeRounded = (usd: number) =>
  usd < 1 ? `${Math.round(usd * 100)}¢` : usd >= 3 ? `$${Math.round(usd)}` : `$${usd.toFixed(1)}`;

export const cacheArmLabel = (liveness: CacheLiveness) =>
  liveness.retention === "long" ? "1-hour" : "5-minute";

/** Local wall-clock time, `14:32`. */
export const cacheClock = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function ringTooltip({ liveness, stakeUsd }: CacheView): string {
  const arm = `${cacheArmLabel(liveness)} cache`;
  const remaining = liveness.remainingMs ?? 0;
  const stake = stakeUsd === null ? null : `≈ ${formatStakeRounded(stakeUsd)}`;
  const ifCold = stake ? ` If it goes cold: ${stake} more.` : "";
  return liveness.state === "cold"
    ? `Cache cold for ~${formatCacheDuration(-remaining)} (${arm}).${stake ? ` Next reply ${stake} more than warm, now or later.` : ""}`
    : liveness.keptWarm
      ? `Kept warm until ~${cacheClock(liveness.expiresAtMs ?? 0)} (${arm}).${ifCold}`
      : `Cache warm, ~${formatCacheDuration(remaining)} left (${arm}).${ifCold}`;
}

/** Point on the ring at `deg` clockwise from 12 o'clock (viewBox 16, radius 6). */
const point = (deg: number) => {
  const rad = (deg * Math.PI) / 180;
  return `${(8 + 6 * Math.sin(rad)).toFixed(2)} ${(8 - 6 * Math.cos(rad)).toFixed(2)}`;
};
const arc = (from: number, to: number) =>
  `M${point(from)} A6 6 0 ${to - from > 180 ? 1 : 0} 1 ${point(to)}`;

function RingGlyph({ liveness }: { liveness: CacheLiveness }) {
  const { steps, litSteps } = liveness;
  // 5-minute caches draw one gapped segment per minute; 1-hour ones a continuous gauge.
  const segments =
    liveness.retention === "short"
      ? Array.from({ length: steps }, (_, i) => ({
          d: arc((i * 360) / steps + 9, ((i + 1) * 360) / steps - 9),
          lit: i < litSteps,
        }))
      : null;
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      fill="none"
      strokeWidth={2.2}
      strokeLinecap="round"
      className={cn(
        "size-3.5 shrink-0 stroke-current",
        liveness.state === "expiring" ? CACHE_HOT_CLASS : "text-muted-foreground",
      )}
    >
      {segments ? (
        segments.map(({ d, lit }) => (
          <path key={d} d={d} strokeLinecap="butt" strokeOpacity={lit ? 1 : 0.28} />
        ))
      ) : (
        <>
          <circle cx="8" cy="8" r="6" strokeOpacity={0.28} />
          {litSteps >= steps ? (
            <circle cx="8" cy="8" r="6" />
          ) : litSteps > 0 ? (
            <path d={arc(0, (litSteps / steps) * 360)} />
          ) : null}
        </>
      )}
    </svg>
  );
}

/** The ring itself, from a computed view: what the preview harness renders. */
export function CacheFuelRingView({ view }: { view: CacheView }) {
  if (view.liveness.state === "unknown") return null;
  const label = ringTooltip(view);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={label}
            data-cache-state={view.liveness.state}
            className="inline-flex shrink-0 items-center"
          />
        }
      >
        {view.liveness.state === "cold" ? (
          <SnowflakeIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground/65" />
        ) : (
          <RingGlyph liveness={view.liveness} />
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

function ConnectedFuelRing({
  thread,
  cache,
}: {
  thread: SidebarThreadSummary;
  cache: LoomThreadCache;
}) {
  const view = useCacheView(thread, cache);
  const now = minuteIso(useNowMinute());
  const status = resolveSidebarThreadStatus(thread);
  const subThreadsUnsettled = useLoomSubThreadsUnsettled(
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
  );
  const yourMove =
    status !== "working" &&
    status !== "waiting" &&
    !subThreadsUnsettled &&
    thread.settledOverride !== "settled" &&
    !effectiveSnoozed(thread, { now });
  return yourMove ? <CacheFuelRingView view={view} /> : null;
}

/** Mount point for a thread row: renders nothing for threads without a pi cache arm. */
export function CacheFuelRing({ thread }: { thread: SidebarThreadSummary }) {
  const cache = thread.source.workstream?.cache;
  return cache ? <ConnectedFuelRing thread={thread} cache={cache} /> : null;
}
