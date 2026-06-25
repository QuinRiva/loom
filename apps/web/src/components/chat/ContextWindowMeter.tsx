import { cn } from "~/lib/utils";
import {
  type ContextCostSummary,
  type ContextWindowSnapshot,
  formatContextWindowTokens,
  formatCostUsd,
} from "~/lib/contextWindow";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

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
  cost?: ContextCostSummary | null;
  providerDisplayName?: string | null;
}) {
  const { usage, cost, providerDisplayName } = props;
  // Headline = the whole subtree's spend when this thread has descendants (so the
  // root orchestrator shows the entire workstream), else this thread's own spend.
  const headlineCostValue = cost
    ? cost.hasDescendants
      ? cost.subtreeCostUsd
      : cost.ownCostUsd
    : 0;
  const headlineCost = formatCostUsd(headlineCostValue);
  const ownCost = formatCostUsd(cost?.ownCostUsd ?? 0);
  const subtreeCost = formatCostUsd(cost?.subtreeCostUsd ?? 0);
  const showCostBreakdown =
    cost !== null && cost !== undefined && (headlineCost !== null || ownCost !== null);
  const usedPercentage = formatPercentage(usage.usedPercentage);
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (normalizedPercentage / 100) * circumference;
  const totalProcessedTokens = usage.totalProcessedTokens ?? null;
  const showTotalProcessed = totalProcessedTokens !== null && totalProcessedTokens > 0;
  const isOverloaded = normalizedPercentage > 90;
  const usageColor = isOverloaded ? "var(--color-red-500)" : "var(--color-blue-500)";

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            className={cn(
              "inline-flex size-6 cursor-pointer items-center justify-center rounded-full border border-transparent text-muted-foreground outline-none transition-colors",
              "hover:bg-accent data-[pressed]:bg-accent",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
            )}
            aria-label={
              usage.maxTokens !== null && usedPercentage
                ? `Context window ${usedPercentage} used`
                : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`
            }
          >
            <span className="relative flex size-4 items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="-rotate-90 absolute inset-0 size-full transform-gpu"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke="color-mix(in oklab, var(--color-muted-foreground) 35%, transparent)"
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
                  className="transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
                />
              </svg>
            </span>
          </button>
        }
      />
      <PopoverPopup tooltipStyle side="top" align="end" className="w-64 max-w-none p-0">
        <div className="flex flex-col gap-2 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-muted-foreground text-xs">Context Window</div>
            {usage.maxTokens !== null && usedPercentage ? (
              <div className="text-[11px] tabular-nums text-muted-foreground/70">
                <span>{usedPercentage}</span>
                <span className="mx-1">·</span>
                <span>
                  {formatContextWindowTokens(usage.usedTokens)}/
                  {formatContextWindowTokens(usage.maxTokens ?? null)}
                </span>
              </div>
            ) : (
              <div className="text-[11px] tabular-nums text-muted-foreground/70">
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
              <span className="text-muted-foreground/60">Total processed</span>
              <span className="font-medium tabular-nums text-muted-foreground/80">
                {formatContextWindowTokens(totalProcessedTokens)}
              </span>
            </div>
          ) : null}
          {usage.compactsAutomatically ? (
            <div className="mt-1 text-pretty text-[11px] font-medium text-muted-foreground/70">
              {providerDisplayName ?? "It"} automatically compacts its context when needed.
            </div>
          ) : null}
          {showCostBreakdown && cost ? (
            <div className="mt-1 flex flex-col gap-1 border-border/60 border-t pt-2">
              <div className="flex items-center justify-between gap-3">
                <div className="font-medium text-muted-foreground text-xs">Spend</div>
                <div className="text-[11px] tabular-nums text-muted-foreground/70">
                  {headlineCost ?? "—"}
                </div>
              </div>
              <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
                <span className="text-muted-foreground/60">This thread</span>
                <span className="font-medium tabular-nums text-muted-foreground/80">
                  {ownCost ?? "$0.00"}
                </span>
              </div>
              {cost.hasDescendants ? (
                <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
                  <span className="text-muted-foreground/60">
                    Subtree ({cost.descendantCount} descendant
                    {cost.descendantCount === 1 ? "" : "s"})
                  </span>
                  <span className="font-medium tabular-nums text-muted-foreground/80">
                    {subtreeCost ?? "$0.00"}
                  </span>
                </div>
              ) : null}
              {cost.children.map((child) => (
                <div
                  key={child.id}
                  className="flex items-center justify-between gap-3 text-[11px] leading-4"
                >
                  <span className="truncate text-muted-foreground/50">{child.title}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground/70">
                    {formatCostUsd(child.costUsd) ?? "<$0.01"}
                  </span>
                </div>
              ))}
              <div className="mt-0.5 text-pretty text-[11px] text-muted-foreground/50">
                Metered-equivalent; may not reflect subscription plans.
              </div>
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
