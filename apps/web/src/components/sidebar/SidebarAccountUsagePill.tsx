import { useNavigate } from "@tanstack/react-router";
import {
  type AccountUsageTone,
  type AccountUsageView,
  deriveAccountUsageViews,
} from "@t3tools/client-runtime";
import { useEffect, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { useAccountUsage } from "../../rpc/serverState";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

const LABEL_TONE_STYLES: Record<AccountUsageTone, string> = {
  quiet: "text-muted-foreground",
  warning: "text-warning",
  destructive: "text-destructive",
};

const BAR_TONE_STYLES: Record<AccountUsageTone, string> = {
  quiet: "bg-muted-foreground/50",
  warning: "bg-warning",
  destructive: "bg-destructive",
};

function AccountUsagePill({
  view,
  onOpenSettings,
}: {
  view: AccountUsageView;
  onOpenSettings: () => void;
}) {
  const percent = Math.round(view.tightestPercent);
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            onClick={onOpenSettings}
            aria-label={`${view.providerDisplayName} subscription usage ${percent}%`}
            className={cn(
              "flex min-w-0 flex-[1_1_calc(50%-0.5rem)] flex-col gap-1.5 rounded-md px-1 py-0.5 text-left outline-none transition-colors",
              "hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
              LABEL_TONE_STYLES[view.tone],
            )}
          >
            <span className="flex items-baseline justify-between gap-2 text-xs font-medium">
              <span className="truncate">{view.providerDisplayName}</span>
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
                className={cn(
                  "block h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none",
                  BAR_TONE_STYLES[view.tone],
                )}
                style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
              />
            </span>
          </button>
        }
      />
      <PopoverPopup tooltipStyle side="top" align="start" className="w-64 max-w-none p-0">
        <div className="flex flex-col gap-2.5 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-muted-foreground text-xs">
              {view.providerDisplayName} usage
            </div>
            {view.planType ? (
              <div className="text-[11px] text-muted-foreground/60 capitalize">{view.planType}</div>
            ) : null}
          </div>
          {view.windows.map((window) => (
            <div key={window.kind} className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
                <span className="text-muted-foreground/70">{window.label}</span>
                <span className="font-medium tabular-nums text-muted-foreground/80">
                  {Math.round(window.usedPercent)}%
                </span>
              </div>
              <div
                className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(window.usedPercent)}
                aria-label={`${window.label} usage`}
              >
                <div
                  className={cn(
                    "h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none",
                    BAR_TONE_STYLES[window.tone],
                  )}
                  style={{ width: `${Math.max(0, Math.min(100, window.usedPercent))}%` }}
                />
              </div>
              {window.resetLabel ? (
                <div className="text-[11px] text-muted-foreground/50">{window.resetLabel}</div>
              ) : null}
            </div>
          ))}
          <div className="text-pretty text-[11px] text-muted-foreground/50">
            Subscription limits as last reported by {view.providerDisplayName}.
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export function SidebarAccountUsagePill() {
  const navigate = useNavigate();
  const usage = useAccountUsage();
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const views = useMemo(() => deriveAccountUsageViews(usage, nowMs), [usage, nowMs]);
  if (views.length === 0) {
    return null;
  }

  const openProviderSettings = () => {
    void navigate({ to: "/settings/providers" });
  };

  return (
    <div className="flex flex-wrap gap-x-4 gap-y-3 p-1">
      {views.map((view) => (
        <AccountUsagePill key={view.key} view={view} onOpenSettings={openProviderSettings} />
      ))}
    </div>
  );
}
