import type { ServerUsageBreakdownResult } from "@t3tools/contracts";
import {
  buildUsageBurnChartGeometry,
  formatClockTime,
  formatUsd,
} from "@t3tools/client-runtime/usageDashboard";
import { useMemo } from "react";

const CHART_WIDTH = 760;
const CHART_HEIGHT = 260;

export function BurnChart({ data, nowMs }: { data: ServerUsageBreakdownResult; nowMs: number }) {
  const nowIso = new Date(nowMs).toISOString();
  const geometry = useMemo(
    () =>
      buildUsageBurnChartGeometry({
        series: data.series,
        models: data.models,
        windowStart: data.windowStart,
        windowEnd: data.windowEnd,
        now: nowIso,
        bucketMinutes: data.bucketMinutes,
        projectedCostAtReset: data.projectedCostAtReset,
        width: CHART_WIDTH,
        height: CHART_HEIGHT,
      }),
    [data, nowIso],
  );
  const hasData = geometry.currentCostUsd > 0;

  return (
    <div className="flex flex-col gap-3 px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <div className="text-[11px] text-muted-foreground/70">API-equivalent cumulative cost</div>
          <div className="text-xl font-semibold tabular-nums">
            {formatUsd(geometry.currentCostUsd)}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[11px] text-muted-foreground/70">Projected at reset</div>
          <div className="text-xl font-semibold tabular-nums text-muted-foreground">
            {data.projectedCostAtReset === null ? "—" : formatUsd(data.projectedCostAtReset)}
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-border/60 bg-muted/10">
        <svg
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          role="img"
          aria-label="Stacked cumulative usage cost by model"
          className="h-[260px] w-full"
        >
          <line
            x1={geometry.plot.left}
            x2={geometry.plot.right}
            y1={geometry.plot.bottom}
            y2={geometry.plot.bottom}
            className="stroke-border"
          />
          <line
            x1={geometry.plot.left}
            x2={geometry.plot.left}
            y1={geometry.plot.top}
            y2={geometry.plot.bottom}
            className="stroke-border"
          />
          {geometry.layers.map((layer) => (
            <path key={layer.model} d={layer.path} fill={layer.color} fillOpacity={0.55} />
          ))}
          {geometry.projectionPath ? (
            <path
              d={geometry.projectionPath}
              fill="none"
              stroke="currentColor"
              strokeDasharray="5 5"
              strokeWidth={2}
              className="text-muted-foreground"
            />
          ) : null}
          <line
            x1={geometry.nowX}
            x2={geometry.nowX}
            y1={geometry.plot.top}
            y2={geometry.plot.bottom}
            stroke="currentColor"
            strokeDasharray="3 4"
            className="text-foreground/60"
          />
          <text
            x={geometry.plot.left - 8}
            y={geometry.plot.top + 4}
            textAnchor="end"
            className="fill-muted-foreground text-[10px]"
          >
            {formatUsd(geometry.yMax)}
          </text>
          <text
            x={geometry.plot.left - 8}
            y={geometry.plot.bottom + 3}
            textAnchor="end"
            className="fill-muted-foreground text-[10px]"
          >
            $0.00
          </text>
          <text
            x={geometry.plot.left}
            y={CHART_HEIGHT - 8}
            className="fill-muted-foreground text-[10px]"
          >
            {formatClockTime(data.windowStart, nowMs)}
          </text>
          <text
            x={geometry.nowX}
            y={CHART_HEIGHT - 8}
            textAnchor="middle"
            className="fill-foreground/70 text-[10px]"
          >
            now
          </text>
          <text
            x={geometry.plot.right}
            y={CHART_HEIGHT - 8}
            textAnchor="end"
            className="fill-muted-foreground text-[10px]"
          >
            reset {formatClockTime(data.windowEnd, nowMs)}
          </text>
        </svg>
        {!hasData ? (
          <div className="border-t border-border/60 px-4 py-3 text-xs text-muted-foreground">
            No burn to chart yet for this scope and window.
          </div>
        ) : null}
      </div>

      {geometry.layers.length > 0 ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground">
          {geometry.layers.map((layer) => (
            <div key={layer.model} className="flex items-center gap-1.5">
              <span
                className="size-2.5 rounded-full"
                style={{ backgroundColor: layer.color }}
                aria-hidden
              />
              <span className="max-w-48 truncate">{layer.model}</span>
              <span className="tabular-nums text-muted-foreground/70">
                {formatUsd(layer.costUsd)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
