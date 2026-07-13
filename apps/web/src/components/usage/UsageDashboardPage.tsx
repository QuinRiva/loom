import { AlertTriangleIcon, RefreshCwIcon } from "lucide-react";
import type { AccountUsageWindowKind } from "@t3tools/contracts";
import {
  deriveUsageScopeTabs,
  formatClockTime,
  gaugeAppliesToScope,
  normalizeUsageScope,
  usageProviderDisplayName,
} from "@t3tools/client-runtime/usageDashboard";
import { accountUsageStorageKey } from "@t3tools/shared/accountUsage";
import { useMemo } from "react";

import { cn } from "~/lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { SettingsSection, useRelativeTimeTick } from "../settings/settingsLayout";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { BurnChart } from "./BurnChart";
import { ModelBreakdownTable } from "./ModelBreakdownTable";
import { TopConsumersTable } from "./TopConsumersTable";
import { WindowGaugeCard } from "./WindowGaugeCard";

const WINDOW_OPTIONS: ReadonlyArray<{ kind: AccountUsageWindowKind; label: string }> = [
  { kind: "primary", label: "5-hour" },
  { kind: "secondary", label: "Weekly" },
];

const WINDOW_GAUGE_LABELS: Record<AccountUsageWindowKind, string> = {
  primary: "5-hour window",
  secondary: "Weekly window",
};

const NO_DATA_LABEL =
  "No usage tracked in this window yet — T3 Code records usage from new turns only.";

export function UsageDashboardPage({
  windowKind,
  scope,
  onWindowChange,
  onScopeChange,
}: {
  windowKind: AccountUsageWindowKind;
  scope: string | undefined;
  onWindowChange: (window: AccountUsageWindowKind) => void;
  onScopeChange: (scope: string) => void;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const nowMs = useRelativeTimeTick(30_000);
  // Legacy meter-key deep-links (pill → scope="claudeAgent") land on the matching
  // per-backend tab; a bare /usage defaults to "All providers".
  const selectedScope = normalizeUsageScope(scope ?? "all");
  const { data, error, isPending, refresh } = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.usageBreakdown({
          environmentId,
          input: { window: windowKind, scope: selectedScope },
        }),
  );

  const scopeTabs = useMemo(
    () => deriveUsageScopeTabs(data?.providers ?? [], data?.gauges ?? []),
    [data?.providers, data?.gauges],
  );
  const scopedGauges = useMemo(
    () =>
      data === null ? [] : data.gauges.filter((gauge) => gaugeAppliesToScope(gauge, selectedScope)),
    [data, selectedScope],
  );

  if (environmentId === null) {
    return (
      <div className="px-4 py-10 text-center text-xs text-muted-foreground">
        No connected environment.
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center rounded-md border border-border/60 p-0.5">
          {WINDOW_OPTIONS.map((option) => (
            <button
              key={option.kind}
              type="button"
              className={cn(
                "h-6 rounded-sm px-2.5 text-[11px] font-medium text-muted-foreground hover:text-foreground",
                windowKind === option.kind && "bg-muted text-foreground",
              )}
              onClick={() => onWindowChange(option.kind)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {scopeTabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={cn(
                "h-6 rounded-full border border-border/60 px-2.5 text-[11px] font-medium text-muted-foreground hover:text-foreground",
                selectedScope === tab.key && "border-transparent bg-muted text-foreground",
              )}
              onClick={() => onScopeChange(tab.key)}
            >
              {tab.label}
            </button>
          ))}
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Refresh usage breakdown"
            className="size-6 rounded-full p-0 text-muted-foreground hover:text-foreground"
            onClick={refresh}
          >
            <RefreshCwIcon className={cn("size-3", isPending && "animate-spin")} />
          </Button>
        </div>
      </div>

      {error !== null ? (
        <div className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-xs text-destructive">
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
          <span className="flex-1">{error}</span>
          <Button size="xs" variant="outline" onClick={refresh}>
            Retry
          </Button>
        </div>
      ) : null}

      {data === null ? (
        error === null ? (
          <div className="flex justify-center py-16">
            <Spinner className="size-5 text-muted-foreground" />
          </div>
        ) : null
      ) : (
        <>
          {data.boundarySource === "trailing" ? (
            <div className="rounded-xl border border-warning/40 bg-warning/5 px-4 py-3 text-xs text-warning-foreground">
              Approximate trailing window — no provider reset data. Official meter gauges are hidden
              because the provider hasn't reported window boundaries.
            </div>
          ) : scopedGauges.length > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2">
              {scopedGauges.map((gauge) => (
                <WindowGaugeCard
                  key={`${accountUsageStorageKey(gauge)}:${gauge.scopeDisplayName ?? ""}`}
                  gauge={gauge}
                  windowLabel={WINDOW_GAUGE_LABELS[data.window]}
                  nowMs={nowMs}
                />
              ))}
            </div>
          ) : selectedScope !== "all" ? (
            <div className="rounded-xl border border-border/60 bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
              No official meter for {usageProviderDisplayName(selectedScope)} — this is a
              pay-per-use backend, so only tracked burn is shown below.
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground/70">
            <span>
              Window: {formatClockTime(data.windowStart, nowMs)} –{" "}
              {formatClockTime(data.windowEnd, nowMs)}
            </span>
            <Badge size="sm" variant="outline" className="text-muted-foreground">
              Tracked by T3 Code only — will not sum to the official meter
            </Badge>
          </div>

          <SettingsSection title="Burn">
            <BurnChart data={data} nowMs={nowMs} />
          </SettingsSection>

          <SettingsSection title="By model">
            <ModelBreakdownTable
              models={data.models}
              scope={data.scope}
              gauges={data.gauges}
              emptyLabel={NO_DATA_LABEL}
            />
          </SettingsSection>

          <SettingsSection title="Top consumers">
            <TopConsumersTable
              consumers={data.consumers}
              environmentId={environmentId}
              emptyLabel={NO_DATA_LABEL}
            />
          </SettingsSection>

          <p className="pb-4 text-[11px] text-muted-foreground/60">
            Costs are API-equivalent — subscription-billed messages carry notional API-rate dollars.
            Usage from other clients on the same account (and pi-internal subagent/oracle calls) is
            not visible to T3 Code.
          </p>
        </>
      )}
    </div>
  );
}
