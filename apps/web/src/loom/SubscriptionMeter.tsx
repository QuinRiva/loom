/**
 * loom: the always-on subscription meter — the accepted "Timeline" design
 * (`plans/usage-meter-redesign/plan.mdx`) in the sidebar footer, mirrored as a
 * tier-1 chip in the chat header while the sidebar is closed.
 *
 * Every 5-hour window is a bar on its pool's wall-clock axis: the bar's end is
 * its reset, the vertical line is now (fill past it is over pace), and an
 * amber ▼ marks where the current burn empties the window before its reset —
 * hollow while the burn is only the window average. Weekly clocks show only as
 * ▲ risk / ▽ opportunity; the numbers are on hover. Fixed height: nothing
 * reflows as thresholds cross, and nothing animates.
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
import { memo, type ReactNode, useEffect, useState } from "react";

import { getDriverOption } from "~/components/settings/providerDriverMeta";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { useSidebarVisibility } from "~/components/ui/sidebar";
import { accountHue } from "~/components/usage/UsageLimitsPooled";
import { cn } from "~/lib/utils";
import { environmentPresentations } from "~/state/presentation";
import {
  formatCountdown,
  METER_TICK_MS,
  type MeterBar,
  type MeterMark,
  type MeterPool,
  type MeterRow,
  type MeterTone,
  type MeterView,
  readMeter,
  RISK_USED,
  toneOf,
} from "./subscriptionMeter";

const FILL: Record<MeterTone, string> = {
  quiet: "bg-muted-foreground/55",
  warning: "bg-warning",
  destructive: "bg-destructive",
};

const TEXT: Record<MeterTone, string> = {
  quiet: "text-foreground",
  warning: "text-warning",
  destructive: "text-destructive",
};

const MARK: Record<MeterMark, { readonly glyph: string; readonly className: string }> = {
  risk: { glyph: "▲", className: "text-warning" },
  opp: { glyph: "▽", className: "text-success" },
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (value: number) => String(value).padStart(2, "0");
/** `15:00`, local. */
const clock = (at: number) => {
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
/** `Sat 05:30`, local: when a weekly clock resets. */
const weekdayClock = (at: number) => `${WEEKDAYS[new Date(at).getDay()]} ${clock(at)}`;

/** The pools to draw and the countdown clock. */
function useMeterReading(): { readonly view: MeterView; readonly now: number } {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), METER_TICK_MS);
    return () => window.clearInterval(id);
  }, []);
  return { view: readMeter(presentations, now), now };
}

function rowName(row: MeterRow, pool: MeterPool): string {
  return row.label ?? getDriverOption(pool.driver)?.label ?? String(pool.driver);
}

/**
 * A window on an axis: its track from start to reset, the fill, the now-line
 * (a pace tick on a 0–1 axis), and the ▼ where the burn empties it — hollow
 * while that burn is only the window average.
 */
function Track({
  axis,
  start,
  end,
  now,
  used,
  tone,
  empty,
  height,
}: {
  readonly axis: MeterPool["axis"];
  readonly start: number;
  readonly end: number;
  readonly now: number | null;
  readonly used: number;
  readonly tone: MeterTone;
  readonly empty?: { readonly at: number; readonly hollow: boolean } | null;
  readonly height: number;
}) {
  const x = (at: number) => `${((at - axis.from) / (axis.to - axis.from)) * 100}%`;
  return (
    <span className="relative block h-full w-full">
      <span
        className="absolute top-1/2 -translate-y-1/2 overflow-hidden rounded-full bg-foreground/[0.07]"
        style={{
          left: x(start),
          width: `${((end - start) / (axis.to - axis.from)) * 100}%`,
          height,
        }}
      >
        <span
          className={cn("block h-full rounded-full", FILL[tone])}
          style={{ width: `${Math.min(used, 100)}%` }}
        />
      </span>
      {now !== null ? (
        <span className="absolute inset-y-0 w-px bg-foreground/70" style={{ left: x(now) }} />
      ) : null}
      {empty ? (
        <svg
          aria-hidden
          width={6}
          height={5}
          viewBox="0 0 6 5"
          className="absolute top-0 -translate-x-1/2 overflow-visible text-warning"
          style={{ left: x(empty.at) }}
        >
          <polygon
            points="0.5,0.5 5.5,0.5 3,4.5"
            fill={empty.hollow ? "none" : "currentColor"}
            stroke="currentColor"
          />
        </svg>
      ) : null}
    </span>
  );
}

const TimeBar = ({
  bar,
  axis,
  now,
  height,
}: {
  readonly bar: MeterBar;
  readonly axis: MeterPool["axis"];
  readonly now: number;
  readonly height: number;
}) => (
  <Track
    axis={axis}
    start={bar.start}
    end={bar.reset}
    now={now}
    used={bar.used}
    tone={bar.tone}
    empty={bar.emptyAt === null ? null : { at: bar.emptyAt, hollow: bar.burn?.coarse ?? false }}
    height={height}
  />
);

const UNIT = { from: 0, to: 1 };
/** A normalised 0–100 bar with its pace tick at the elapsed share. */
const PaceBar = ({
  used,
  elapsed,
  height,
}: {
  readonly used: number;
  readonly elapsed: number | null;
  readonly height: number;
}) => (
  <Track
    axis={UNIT}
    start={0}
    end={1}
    now={elapsed}
    used={used}
    tone={toneOf(used)}
    height={height}
  />
);

/**
 * `empty ~2h 30m · ↻ 2h 58m`, or just the reset when the burn does not empty
 * the window first. The chip drops the reset beside a projection, as drawn.
 */
function ResetText({
  bar,
  now,
  withReset = true,
}: {
  readonly bar: MeterBar;
  readonly now: number;
  readonly withReset?: boolean;
}) {
  const reset = bar.resetKnown ? `↻ ${formatCountdown(bar.reset - now)}` : "idle";
  return bar.emptyAt === null ? (
    <span className="text-muted-foreground/75">{reset}</span>
  ) : (
    <span className="text-muted-foreground/75">
      <span className="font-medium text-warning">empty ~{formatCountdown(bar.emptyAt - now)}</span>
      {withReset ? ` · ${reset}` : null}
    </span>
  );
}

/** Three columns — name, the pool's axis, mark + countdown — shared by every row. */
function Grid({
  className,
  children,
}: {
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className={cn("grid grid-cols-[54px_minmax(0,1fr)_50px] items-center gap-x-1", className)}>
      {children}
    </div>
  );
}

function Identity({ row, name }: { readonly row: MeterRow; readonly name: string }) {
  const key = row.email ?? row.label;
  return key ? (
    <span
      className="size-1.5 shrink-0 rounded-full"
      style={{ backgroundColor: `oklch(0.78 0.12 ${accountHue(key)})` }}
    />
  ) : (
    <span className="size-1.5 shrink-0 rounded-[2px] bg-muted-foreground" aria-label={name} />
  );
}

/** One window in a row's popover: bar with pace tick, reset, and the reason it is marked. */
function PopoverWindow({
  name,
  used,
  elapsed,
  reset,
  note,
}: {
  readonly name: string;
  readonly used: number;
  readonly elapsed: number | null;
  readonly reset: string | null;
  readonly note?: { readonly text: string; readonly className: string } | null;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="text-muted-foreground/75">{name}</span>
        <span className={cn("font-medium tabular-nums", TEXT[toneOf(used)])}>
          {Math.round(used)}% used
        </span>
      </div>
      <span className="block h-2">
        <PaceBar used={used} elapsed={elapsed} height={5} />
      </span>
      {reset ? <span className="text-[10px] text-muted-foreground/45">{reset}</span> : null}
      {note ? <span className={cn("text-[10px]", note.className)}>{note.text}</span> : null}
    </div>
  );
}

function RowPopover({
  row,
  pool,
  now,
}: {
  readonly row: MeterRow;
  readonly pool: MeterPool;
  readonly now: number;
}) {
  const name = rowName(row, pool);
  const bar = row.bar;
  return (
    <div className="flex flex-col gap-2.5 p-3 tabular-nums">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          <Identity row={row} name={name} />
          {name}
        </span>
        {row.email ? (
          <span className="truncate text-[10px] text-muted-foreground/45">{row.email}</span>
        ) : null}
      </div>
      {bar ? (
        <PopoverWindow
          name="5-hour"
          used={bar.used}
          elapsed={
            bar.resetKnown
              ? Math.min(1, Math.max(0, (now - bar.start) / (bar.reset - bar.start)))
              : null
          }
          reset={
            bar.resetKnown
              ? `resets ${clock(bar.reset)} · in ${formatCountdown(bar.reset - now)}`
              : "idle — starts at first use"
          }
          note={
            bar.emptyAt !== null && bar.burn
              ? {
                  text: `empty ~${clock(bar.emptyAt)} at ${Math.round(bar.burn.rate)} pts/h${
                    bar.burn.coarse ? " (window average)" : ""
                  }`,
                  className: "text-warning",
                }
              : null
          }
        />
      ) : null}
      {row.weeklies.map((weekly) => (
        <PopoverWindow
          key={weekly.label}
          name={weekly.label}
          used={weekly.used}
          elapsed={weekly.elapsed}
          reset={
            weekly.resetsAt === null
              ? null
              : `resets ${weekdayClock(weekly.resetsAt)} · in ${formatCountdown(weekly.resetsAt - now)}`
          }
          note={
            weekly.mark === "risk"
              ? {
                  text:
                    weekly.used >= 100
                      ? "▲ exhausted"
                      : weekly.used >= RISK_USED
                        ? "▲ near max"
                        : "▲ hits max before reset",
                  className: MARK.risk.className,
                }
              : weekly.mark === "opp"
                ? {
                    text: `▽ ${Math.round(100 - weekly.used)}% left to spend by then`,
                    className: MARK.opp.className,
                  }
                : null
          }
        />
      ))}
      <span className="border-t border-border/60 pt-2 text-[10px] text-muted-foreground/45">
        Pin a thread here from the model picker.
      </span>
    </div>
  );
}

/** One account on its pool's axis — a pool member and a one-account pool alike. */
function AccountRow({
  row,
  pool,
  now,
}: {
  readonly row: MeterRow;
  readonly pool: MeterPool;
  readonly now: number;
}) {
  const navigate = useNavigate();
  const name = rowName(row, pool);
  const mark = row.mark ? MARK[row.mark] : null;
  const bar = row.bar;
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            onClick={() => void navigate({ to: "/usage" })}
            aria-label={`${name}: 5-hour ${Math.round(bar?.used ?? 0)}% used${
              bar?.resetKnown ? `, resets in ${formatCountdown(bar.reset - now)}` : ""
            }${bar?.emptyAt ? `, empties in ~${formatCountdown(bar.emptyAt - now)}` : ""}`}
            className="block w-full rounded-[4px] text-left outline-none hover:bg-foreground/5 focus-visible:ring-1 focus-visible:ring-ring"
          />
        }
      >
        <Grid className="h-3">
          <span className="flex min-w-0 items-center gap-1">
            <Identity row={row} name={name} />
            <span
              className={cn(
                "truncate text-[10px]",
                row.exhausted
                  ? "font-medium text-destructive"
                  : mark
                    ? cn("font-medium", mark.className)
                    : "text-muted-foreground",
              )}
            >
              {name}
            </span>
          </span>
          <span className="h-3">
            {bar ? <TimeBar bar={bar} axis={pool.axis} now={now} height={4} /> : null}
          </span>
          <span className="flex items-center justify-end gap-[3px] whitespace-nowrap text-[10px]">
            {mark ? (
              <span className={cn("text-[9px] font-bold", mark.className)}>{mark.glyph}</span>
            ) : null}
            <span className={mark ? "text-muted-foreground" : "text-muted-foreground/75"}>
              {bar?.resetKnown ? `↻ ${formatCountdown(bar.reset - now)}` : "idle"}
            </span>
          </span>
        </Grid>
      </PopoverTrigger>
      <PopoverPopup
        tooltipStyle
        side="right"
        align="start"
        className="w-64 max-w-none"
        viewportClassName="p-0"
      >
        <RowPopover row={row} pool={pool} now={now} />
      </PopoverPopup>
    </Popover>
  );
}

/**
 * A pool of several accounts: its 5-hour mean, the pooled per-model weekly,
 * then one row per account, all on one axis. A one-account pool is its row.
 */
function PoolBlock({
  pool,
  now,
  stale,
}: {
  readonly pool: MeterPool;
  readonly now: number;
  readonly stale: boolean;
}) {
  const rows = pool.rows.map((row) => <AccountRow key={row.key} row={row} pool={pool} now={now} />);
  if (!pool.pool) return <div className={cn(stale && "opacity-50")}>{rows}</div>;
  return (
    <div className={cn("flex flex-col gap-px", stale && "opacity-50")}>
      <div className="flex h-3 items-center gap-1 text-[11px] tabular-nums">
        <span className="font-medium text-foreground">5-hour</span>
        <span className="text-muted-foreground">{Math.round(pool.pool.used)}%</span>
        <span className="flex-1" />
        <span className="text-[10px]">
          <ResetText bar={pool.pool} now={now} />
        </span>
      </div>
      <Grid className="h-3">
        <span className="text-[9px] text-muted-foreground/45">pool</span>
        <span className="h-3">
          <TimeBar bar={pool.pool} axis={pool.axis} now={now} height={6} />
        </span>
        <span />
      </Grid>
      {pool.carveOut ? (
        <Grid className="mt-0.5 h-3">
          <span className="truncate text-[10px] text-muted-foreground">
            {pool.carveOut.scope} wk
          </span>
          <span className="h-3">
            <PaceBar used={pool.carveOut.used} elapsed={pool.carveOut.elapsed} height={4} />
          </span>
          <span className="text-right text-[10px] text-muted-foreground tabular-nums">
            {Math.round(pool.carveOut.used)}%
          </span>
        </Grid>
      ) : null}
      <div className="mt-[3px] flex flex-col">{rows}</div>
    </div>
  );
}

/**
 * The whole meter, from a derived view: the sidebar footer and the chip's
 * popover. Memoised: `readMeter` hands back the same view until a reading
 * lands or the tick moves, so unrelated presentation updates skip the rows.
 */
export const SubscriptionMeterView = memo(function SubscriptionMeterView({
  view,
  now,
}: {
  readonly view: MeterView;
  readonly now: number;
}) {
  return (
    <div className="flex w-full flex-col gap-px py-[3px] tabular-nums leading-none">
      {view.pools.map((pool, index) => (
        <div key={pool.driver}>
          {index > 0 ? <div className="my-0.5 h-px bg-border/60" /> : null}
          <PoolBlock pool={pool} now={now} stale={pool.stale} />
        </div>
      ))}
    </div>
  );
});

/** The meter for the sidebar footer. */
export const SubscriptionMeter = memo(function SubscriptionMeter() {
  const { view, now } = useMeterReading();
  return view.pools.length === 0 ? null : <SubscriptionMeterView view={view} now={now} />;
});

/**
 * Tier 1 only, for the chat header: the first pool's 5-hour bar on its axis
 * with the time-to-empty, and its per-model weekly pace. Hover shows the whole
 * footer; click opens the Usage page.
 */
export function SubscriptionMeterChipView({
  view,
  now,
}: {
  readonly view: MeterView;
  readonly now: number;
}) {
  const navigate = useNavigate();
  const pool = view.pools[0];
  const bar = pool?.pool ?? pool?.rows[0]?.bar;
  if (!pool || !bar) return null;
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            onClick={() => void navigate({ to: "/usage" })}
            aria-label={`Subscription usage: 5-hour ${Math.round(bar.used)}% used`}
            className={cn(
              "flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-border/60 px-[7px] text-[10px] tabular-nums outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring",
              pool.stale && "opacity-50",
            )}
          />
        }
      >
        <span className="text-muted-foreground/75">5h</span>
        <span className="h-3 w-14">
          <TimeBar bar={bar} axis={pool.axis} now={now} height={6} />
        </span>
        <ResetText bar={bar} now={now} withReset={false} />
        {pool.carveOut ? (
          <>
            <span className="h-3 w-px bg-border/60" />
            <span className="text-muted-foreground/75">{pool.carveOut.scope[0]}</span>
            <span className="h-3 w-7">
              <PaceBar used={pool.carveOut.used} elapsed={pool.carveOut.elapsed} height={6} />
            </span>
          </>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup
        tooltipStyle
        side="bottom"
        align="end"
        className="w-64 max-w-none"
        viewportClassName="px-2 py-1"
      >
        <SubscriptionMeterView view={view} now={now} />
      </PopoverPopup>
    </Popover>
  );
}

function SubscriptionMeterChipLive() {
  const { view, now } = useMeterReading();
  return <SubscriptionMeterChipView view={view} now={now} />;
}

/**
 * The chip, shown only while the sidebar is closed — an offcanvas sidebar
 * takes its footer to zero width. Read-only: an indicator must never nudge the
 * sidebar open or closed.
 */
export const SubscriptionMeterChip = memo(function SubscriptionMeterChip() {
  return useSidebarVisibility() ? null : <SubscriptionMeterChipLive />;
});
