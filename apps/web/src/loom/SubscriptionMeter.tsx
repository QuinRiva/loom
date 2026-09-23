/**
 * loom: the always-on subscription meter — one bar per pooled subscription in
 * the sidebar footer, mirrored as a chip in the chat header while the sidebar
 * is closed.
 *
 * It reads the presentations atom every client already subscribes to, so it
 * adds no RPC and no wire traffic. Tier 4 state throughout
 * (`docs/architecture/loom-ui-state-tiers.md`): the pools are derived, the only
 * mutable state is a 30-second countdown tick, and the header chip *reads*
 * sidebar visibility without ever writing it.
 *
 * @module loom/SubscriptionMeter
 */
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import {
  formatDuration,
  type LimitPace,
  type LimitPool,
  type LimitPoolWindow,
} from "@t3tools/shared/usageLimits";
import { memo, useEffect, useState } from "react";

import { ProviderInstanceIcon } from "~/components/chat/ProviderInstanceIcon";
import { getDriverOption } from "~/components/settings/providerDriverMeta";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { useSidebarVisibility } from "~/components/ui/sidebar";
import { AccountName } from "~/components/usage/UsageLimitsPooled";
import { cn } from "~/lib/utils";
import { environmentPresentations } from "~/state/presentation";
import {
  headlinePoolWindow,
  METER_TICK_MS,
  type MeterPoolView,
  meterTone,
  type MeterTone,
  poolTone,
  poolWindowLabel,
  readMeter,
} from "./subscriptionMeter";

const LABEL_TONE: Record<MeterTone, string> = {
  quiet: "text-muted-foreground",
  warning: "text-warning",
  destructive: "text-destructive",
};

const BAR_TONE: Record<MeterTone, string> = {
  quiet: "bg-muted-foreground/50",
  warning: "bg-warning",
  destructive: "bg-destructive",
};

const PACE_LABEL: Record<LimitPace, string> = {
  ahead: "ahead of pace",
  on: "on pace",
  under: "under pace",
};

/** The pools to draw, each marked live or stale, and the countdown clock. */
function useMeterReading(): { readonly views: readonly MeterPoolView[]; readonly now: number } {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), METER_TICK_MS);
    return () => window.clearInterval(id);
  }, []);
  return { views: readMeter(presentations, now), now };
}

function percentOf(pool: LimitPool): number {
  return headlinePoolWindow(pool)?.usedPercent ?? 0;
}

function driverLabel(pool: LimitPool): string {
  return getDriverOption(pool.driver)?.label ?? String(pool.driver);
}

/** One pooled window: what is spent, the pace, and every account's own share. */
function WindowRow({ window }: { readonly window: LimitPoolWindow }) {
  // Each row carries its own tone; the bar outside takes the loudest of them.
  const tone = meterTone(window.usedPercent);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3 text-[11px] leading-4">
        <span className="text-muted-foreground/70">{poolWindowLabel(window)} pool</span>
        <span className="tabular-nums text-muted-foreground/80">
          {window.usedPercent}% used{window.pace ? ` · ${PACE_LABEL[window.pace]}` : ""}
        </span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={window.usedPercent}
        aria-label={`${poolWindowLabel(window)} pool usage`}
      >
        <div
          className={cn("h-full rounded-full", BAR_TONE[tone])}
          style={{ width: `${window.usedPercent}%` }}
        />
      </div>
      {window.members.length > 1 ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground/70">
          {window.members.map((member) => (
            <span key={member.account.key} className="inline-flex items-center gap-1">
              <AccountName account={member.account} className="max-w-24 truncate" />
              <span className="tabular-nums">{Math.round(member.window.usedPercent)}%</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The pooled breakdown: every window, then the resets in the order they land. */
function MeterPopover({
  pool,
  now,
  stale,
  readAt,
}: {
  readonly pool: LimitPool;
  readonly now: number;
  readonly stale: boolean;
  readonly readAt: number;
}) {
  const plan = pool.accounts.every((entry) => entry.plan === pool.accounts[0]?.plan)
    ? pool.accounts[0]?.plan
    : undefined;
  const ladder = (headlinePoolWindow(pool)?.resets ?? []).filter(
    (reset) => reset.restoresPercent > 0,
  );
  return (
    <div className="flex w-72 max-w-[calc(100vw-3rem)] flex-col gap-2.5 p-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium text-foreground">
          {driverLabel(pool)} · {pool.accounts.length}{" "}
          {pool.accounts.length === 1 ? "account" : "accounts"}
        </span>
        {plan ? <span className="text-[11px] text-muted-foreground/60">{plan}</span> : null}
      </div>
      {pool.windows.map((window) => (
        <WindowRow key={`${window.kind}:${window.id}`} window={window} />
      ))}
      {ladder.length > 0 ? (
        <div className="flex flex-col gap-0.5 border-t border-border/60 pt-2 text-[11px] text-muted-foreground/60">
          {ladder.slice(0, 3).map((reset) => (
            <span key={reset.member.account.key} className="flex items-center gap-1 tabular-nums">
              ↻ <AccountName account={reset.member.account} className="max-w-24 truncate" />
              {reset.at <= now ? "now" : formatDuration(reset.at - now)} · +{reset.restoresPercent}%
              of pool
            </span>
          ))}
        </div>
      ) : null}
      <span className="text-[11px] text-muted-foreground/50">
        {stale
          ? `Not reported since the last read ${formatDuration(now - readAt)} ago.`
          : `Pooled subscription limits as last reported to ${driverLabel(pool)}.`}
      </span>
    </div>
  );
}

/** Bar, chip, and their shared popover; clicking either opens the Usage page. */
function MeterControl({
  view: { pool, stale, readAt },
  now,
  compact,
}: {
  readonly view: MeterPoolView;
  readonly now: number;
  readonly compact: boolean;
}) {
  const navigate = useNavigate();
  const tone = poolTone(pool);
  const percent = percentOf(pool);
  const label = driverLabel(pool);
  const open = () => void navigate({ to: "/usage" });
  const ariaLabel = `${label} subscription usage ${percent}% used across ${pool.accounts.length} ${
    pool.accounts.length === 1 ? "account" : "accounts"
  }${stale ? ", not reported recently" : ""}`;
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            onClick={open}
            aria-label={ariaLabel}
            className={cn(
              "flex min-w-0 items-center rounded-md outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
              compact
                ? "h-6 gap-1 border border-border/60 px-1.5 text-[11px]"
                : "flex-[1_1_calc(50%-0.5rem)] flex-col gap-1.5 px-1 py-0.5 text-left",
              LABEL_TONE[tone],
              stale && "opacity-50",
            )}
          />
        }
      >
        {compact ? (
          <>
            <ProviderInstanceIcon
              driverKind={pool.driver}
              displayName={label}
              indicatorBackground="var(--background)"
              className="size-3.5"
              iconClassName="size-3 text-foreground/80"
            />
            <span className="shrink-0 font-medium tabular-nums">{percent}%</span>
          </>
        ) : (
          <>
            <span className="flex w-full items-baseline justify-between gap-2 text-xs font-medium">
              <span className="truncate">{label}</span>
              <span className="shrink-0 tabular-nums">{percent}%</span>
            </span>
            <span
              className="h-1 w-full overflow-hidden rounded-full bg-muted/60"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
            >
              <span
                className={cn("block h-full rounded-full", BAR_TONE[tone])}
                style={{ width: `${percent}%` }}
              />
            </span>
          </>
        )}
      </PopoverTrigger>
      <PopoverPopup tooltipStyle side="top" align="start" className="w-72 max-w-none p-0">
        <MeterPopover pool={pool} now={now} stale={stale} readAt={readAt} />
      </PopoverPopup>
    </Popover>
  );
}

/** One bar per pooled subscription, for the sidebar footer. */
export const SubscriptionMeter = memo(function SubscriptionMeter() {
  const { views, now } = useMeterReading();
  if (views.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-2 p-1">
      {views.map((view) => (
        <MeterControl key={view.pool.driver} view={view} now={now} compact={false} />
      ))}
    </div>
  );
});

function SubscriptionMeterChipRow() {
  const { views, now } = useMeterReading();
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {views.map((view) => (
        <MeterControl key={view.pool.driver} view={view} now={now} compact />
      ))}
    </div>
  );
}

/**
 * The same meter in the chat header, shown only while the sidebar is closed —
 * an offcanvas sidebar takes its footer to zero width. Read-only: an indicator
 * must never nudge the sidebar open or closed.
 */
export const SubscriptionMeterChip = memo(function SubscriptionMeterChip() {
  const sidebarVisible = useSidebarVisibility();
  return sidebarVisible ? null : <SubscriptionMeterChipRow />;
});
