import { Button } from "../ui/button";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
// loom: workstream spend roll-up rendered alongside upstream's context figures.
import type { ContextCostSummary } from "~/loom/contextCost";
import { formatCostUsd } from "~/loom/costFormat";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { formatContextWindowCompactionMessage } from "./ContextWindowMeter.logic";
import { Minimize2Icon } from "lucide-react";
import { composerFloatingLayerProps } from "./composerEventScope";

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot;
  // loom: pre-derived workstream spend for this thread (see ~/loom/contextCost).
  cost?: ContextCostSummary | null;
  modelDisplayName?: string | null;
  onCompact?: (() => void) | undefined;
  compactDisabled?: boolean | undefined;
  compactDisabledReason?: string | null | undefined;
}) {
  const { usage, cost, modelDisplayName, onCompact, compactDisabled, compactDisabledReason } =
    props;
  // loom: headline = the whole subtree's spend when this thread has descendants
  // (so a root orchestrator shows its entire workstream), else its own spend.
  const headlineCost = formatCostUsd(
    cost ? (cost.hasDescendants ? cost.subtreeCostUsd : cost.ownCostUsd) : 0,
  );
  const ownCost = formatCostUsd(cost?.ownCostUsd ?? 0);
  const subtreeCost = formatCostUsd(cost?.subtreeCostUsd ?? 0);
  const showSpend = Boolean(cost) && (headlineCost !== null || ownCost !== null);
  const usedPercentage = formatPercentage(usage.usedPercentage);
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - normalizedPercentage / 100);
  const totalProcessedTokens = usage.totalProcessedTokens ?? null;
  const showTotalProcessed = totalProcessedTokens !== null && totalProcessedTokens > 0;
  const isOverloaded = normalizedPercentage > 90;
  const usageColor = isOverloaded
    ? "var(--color-error)"
    : "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={onCompact ? 150 : 0}
        render={
          <Button
            size="icon-sm"
            variant="ghost-muted"
            className="size-7 rounded-full hover:text-muted-foreground data-pressed:text-muted-foreground"
            aria-label={
              usage.maxTokens !== null && usedPercentage
                ? `Context window ${usedPercentage} used`
                : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`
            }
          >
            <span className="relative flex size-5 items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="-rotate-90 absolute inset-0 size-full transform-gpu mx-0!"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke="color-mix(in oklab, var(--color-muted-foreground) 24%, transparent)"
                  strokeWidth="3"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke={usageColor}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className="transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none"
                />
              </svg>
            </span>
          </Button>
        }
      />
      <PopoverPopup
        {...composerFloatingLayerProps}
        tooltipStyle
        side="top"
        align="end"
        viewportClassName="p-0"
        className="w-64 max-w-none text-left whitespace-normal"
      >
        <div className="flex flex-col gap-2 p-[var(--floating-content-inset)]">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-muted-foreground text-xs">Context Window</div>
            {usage.maxTokens !== null && usedPercentage ? (
              <div className="text-secondary-label text-[11px] tabular-nums">
                <span>{usedPercentage}</span>
                <span className="mx-1">·</span>
                <span>
                  {formatContextWindowTokens(usage.usedTokens)}/
                  {formatContextWindowTokens(usage.maxTokens ?? null)}
                </span>
              </div>
            ) : (
              <div className="text-secondary-label text-[11px] tabular-nums">
                {formatContextWindowTokens(usage.usedTokens)}
              </div>
            )}
          </div>
          {usage.maxTokens !== null ? (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(normalizedPercentage)}
              aria-label="Context window usage"
            >
              <div
                className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
                style={{ width: `${normalizedPercentage}%`, backgroundColor: usageColor }}
              />
            </div>
          ) : null}
          {showTotalProcessed ? (
            <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
              <span className="text-secondary-label">Total processed</span>
              <span className="font-medium tabular-nums text-secondary-label">
                {formatContextWindowTokens(totalProcessedTokens)}
              </span>
            </div>
          ) : null}
          {usage.compactsAutomatically ? (
            <div className="mt-1 text-pretty text-secondary-label text-[11px] font-medium">
              {formatContextWindowCompactionMessage(modelDisplayName, usage.autoCompactThreshold)}
            </div>
          ) : null}
          {showSpend && cost ? (
            // loom: spend block — headline, this thread, subtree, per-branch rows.
            <div className="mt-1 flex flex-col gap-1 border-border/60 border-t pt-2">
              <div className="flex items-center justify-between gap-3">
                <div className="font-medium text-muted-foreground text-xs">Spend</div>
                <div className="text-secondary-label text-[11px] tabular-nums">
                  {headlineCost ?? "—"}
                </div>
              </div>
              <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
                <span className="text-secondary-label">This thread</span>
                <span className="font-medium tabular-nums text-secondary-label">
                  {ownCost ?? "$0.00"}
                </span>
              </div>
              {cost.hasDescendants ? (
                <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
                  <span className="text-secondary-label">
                    Subtree ({cost.descendantCount} descendant
                    {cost.descendantCount === 1 ? "" : "s"})
                  </span>
                  <span className="font-medium tabular-nums text-secondary-label">
                    {subtreeCost ?? "$0.00"}
                  </span>
                </div>
              ) : null}
              {cost.children.length > 0 ? (
                // A wide workstream has dozens of branches; scroll them rather
                // than growing the popup past the viewport (which clips the
                // footnote and the Compact button out of reach).
                <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
                  {cost.children.map((child) => (
                    <div
                      key={child.id}
                      className="flex items-center justify-between gap-3 text-[11px] leading-4"
                    >
                      <span className="truncate text-secondary-label/70">{child.title}</span>
                      <span className="shrink-0 tabular-nums text-secondary-label/70">
                        {formatCostUsd(child.costUsd) ?? "<$0.01"}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="mt-0.5 text-pretty text-secondary-label/70 text-[11px]">
                Metered-equivalent; may not reflect subscription plans.
              </div>
            </div>
          ) : null}
          {onCompact ? (
            <>
              <Button
                size="xs"
                variant="outline"
                className="mt-1 w-full justify-center"
                disabled={compactDisabled}
                onClick={onCompact}
              >
                <Minimize2Icon aria-hidden="true" />
                Compact context
              </Button>
              {compactDisabled && compactDisabledReason ? (
                <div className="text-pretty text-secondary-label text-[11px]">
                  {compactDisabledReason}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/** Holds the meter's footprint while a thread's activities are still loading. */
export function ContextWindowMeterPlaceholder() {
  return <span aria-hidden="true" className="size-7 shrink-0" />;
}
