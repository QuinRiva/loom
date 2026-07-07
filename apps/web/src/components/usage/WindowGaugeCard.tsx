import type { ServerUsageBreakdownGauge } from "@t3tools/contracts";
import {
  type AccountUsageTone,
  accountUsageTone,
  formatAccountUsageReset,
} from "@t3tools/client-runtime/accountUsage";
import {
  formatClockTime,
  gaugeProjectionSentence,
  usageProviderDisplayName,
} from "@t3tools/client-runtime/usageDashboard";

import { cn } from "~/lib/utils";

const PERCENT_TONE_STYLES: Record<AccountUsageTone, string> = {
  quiet: "text-foreground",
  warning: "text-warning",
  destructive: "text-destructive",
};

const BAR_TONE_STYLES: Record<AccountUsageTone, string> = {
  quiet: "bg-muted-foreground/50",
  warning: "bg-warning",
  destructive: "bg-destructive",
};

/**
 * Official provider utilisation for the selected window: the % is rendered
 * verbatim from the provider meter — never locally computed (§1, §D6).
 */
export function WindowGaugeCard({
  gauge,
  windowLabel,
  nowMs,
}: {
  gauge: ServerUsageBreakdownGauge;
  windowLabel: string;
  nowMs: number;
}) {
  const providerDisplayName = usageProviderDisplayName(gauge.providerName);
  // A pooled account (router proxy) labels its own card so two accounts of one
  // instance are distinguishable; a sole account keeps just the provider name.
  const displayName = gauge.accountLabel
    ? `${providerDisplayName} · ${gauge.accountLabel}`
    : providerDisplayName;
  // A per-model carve-out (e.g. the Anthropic weekly limit for "Fable") shows
  // its model name so it reads distinctly from the account-wide weekly gauge.
  const meterLabel = gauge.scopeDisplayName
    ? `${windowLabel} · ${gauge.scopeDisplayName}`
    : windowLabel;
  const percent = Math.max(0, Math.min(100, Math.round(gauge.usedPercent)));
  const tone = accountUsageTone(gauge.usedPercent);
  const resetLabel = formatAccountUsageReset(gauge.resetsAt, nowMs);
  const projection = gaugeProjectionSentence(gauge, nowMs);

  return (
    <div className="flex flex-col gap-2.5 rounded-2xl border bg-card p-4 text-card-foreground shadow-xs/5">
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{displayName}</div>
          <div className="text-[11px] text-muted-foreground/70">
            {meterLabel}
            {gauge.planType ? ` · ${gauge.planType}` : ""}
          </div>
        </div>
        <div className={cn("text-2xl font-semibold tabular-nums", PERCENT_TONE_STYLES[tone])}>
          {percent}%
        </div>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label={`${displayName} ${meterLabel} usage`}
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none",
            BAR_TONE_STYLES[tone],
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        {resetLabel && gauge.resetsAt ? (
          <span>
            {resetLabel} ({formatClockTime(gauge.resetsAt, nowMs)})
          </span>
        ) : null}
        {projection ? <span>{projection}</span> : null}
      </div>
      <div className="border-t border-border/60 pt-2 text-[11px] text-muted-foreground/60">
        Official {providerDisplayName} figure — counts all clients on this account, not just T3
        Code.
      </div>
    </div>
  );
}
