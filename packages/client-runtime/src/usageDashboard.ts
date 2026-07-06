import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ServerUsageBreakdownConsumer,
  type ServerUsageBreakdownGauge,
  type ServerUsageBreakdownModel,
  type ServerUsageBreakdownResult,
  type ServerUsageBreakdownSeriesBucket,
  USAGE_BACKEND_DISPLAY_NAMES,
  USAGE_METER_PROVIDER_NAMES,
} from "@t3tools/contracts";

/**
 * Pure view maths for the /usage dashboard (docs/usage-dashboard-design.md §D5):
 * consumer root-rollup grouping, header-click sort logic, projection/countdown
 * sentences, and number formatting. No IO, no atoms — shared with mobile later
 * and testable without the DOM.
 */

// ── Meter badging (§D6) ───────────────────────────────────────────────

const METERED_PROVIDER_NAMES = new Set(Object.values(USAGE_METER_PROVIDER_NAMES).flat());

/**
 * True when a backend provider id reports into no subscription meter (e.g. a
 * Vertex/Bedrock backend, billed by Google/AWS not the Anthropic OAuth
 * subscription) — such backends get no official gauge, and their models get the
 * "not counted in any meter" badge in the "All providers" scope.
 */
export function isMeterlessProvider(providerId: string): boolean {
  return !METERED_PROVIDER_NAMES.has(providerId);
}

/** Human-readable name for a provider identity — resolves both real backend
 * ids (ledger `provider_id`, e.g. "google-vertex-claude" → "Vertex") and driver
 * kinds / gauge meter keys (e.g. "claudeAgent" → "Claude"), falling back to the
 * raw id. The two key spaces are disjoint so lookup order is immaterial. */
export function usageProviderDisplayName(providerId: string): string {
  return (
    USAGE_BACKEND_DISPLAY_NAMES[providerId] ??
    PROVIDER_DISPLAY_NAMES[providerId as ProviderDriverKind] ??
    providerId
  );
}

// ── Per-backend scope tabs (auto-derived from usage + gauges) ──────────

export interface UsageScopeTab {
  /** Scope param sent to the server: a real backend provider id, or "all". */
  readonly key: string;
  readonly label: string;
  /** True when an official subscription meter covers this backend (⇒ a gauge). */
  readonly hasGauge: boolean;
}

const ALL_SCOPE_TAB: UsageScopeTab = { key: "all", label: "All providers", hasGauge: false };

/** Backend ids officially metered by the currently-reporting gauges. */
function gaugeMeteredBackends(
  gauges: ReadonlyArray<ServerUsageBreakdownGauge>,
): ReadonlySet<string> {
  const set = new Set<string>();
  for (const gauge of gauges)
    for (const backend of USAGE_METER_PROVIDER_NAMES[gauge.providerName] ?? []) set.add(backend);
  return set;
}

/**
 * The dashboard's scope tab set: one tab per real backend provider seen in
 * tracked usage (cost-descending), unioned with any gauge-backed backend that
 * has no rows yet, plus a trailing "All providers". Auto-derived — a new backend
 * (Vertex, etc.) appears the moment it has usage, with no hard-coded chip set.
 */
export function deriveUsageScopeTabs(
  providers: ServerUsageBreakdownResult["providers"],
  gauges: ReadonlyArray<ServerUsageBreakdownGauge>,
): ReadonlyArray<UsageScopeTab> {
  const metered = gaugeMeteredBackends(gauges);
  const keys: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    if (id !== "unknown" && !seen.has(id)) {
      seen.add(id);
      keys.push(id);
    }
  };
  for (const provider of providers) push(provider.providerId);
  // A present gauge guarantees its subscription's CANONICAL (primary) backend a
  // tab even before any rows land; other backends the meter also covers appear
  // only once they have real usage, so we never invent phantom empty tabs.
  for (const gauge of gauges) {
    const primary = USAGE_METER_PROVIDER_NAMES[gauge.providerName]?.[0];
    if (primary) push(primary);
  }
  return [
    ...keys.map((key) => ({
      key,
      label: usageProviderDisplayName(key),
      hasGauge: metered.has(key),
    })),
    ALL_SCOPE_TAB,
  ];
}

/** Whether a gauge card belongs on the selected scope — every gauge under
 * "all", else only the gauge whose meter officially covers this backend. */
export function gaugeAppliesToScope(gauge: ServerUsageBreakdownGauge, scope: string): boolean {
  return scope === "all" || (USAGE_METER_PROVIDER_NAMES[gauge.providerName] ?? []).includes(scope);
}

/** Translate a legacy meter-key scope ("claudeAgent"/"codex", still emitted by
 * the sidebar pill deep-link) to its primary backend id so it lands on the
 * matching per-backend tab; backend ids and "all" pass through unchanged. */
export function normalizeUsageScope(scope: string): string {
  return USAGE_METER_PROVIDER_NAMES[scope]?.[0] ?? scope;
}

// ── Window totals ─────────────────────────────────────────────────────

export interface UsageWindowTotals {
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
}

export function usageWindowTotals(
  models: ReadonlyArray<ServerUsageBreakdownModel>,
): UsageWindowTotals {
  return models.reduce(
    (acc, model) => ({
      costUsd: acc.costUsd + model.costUsd,
      inputTokens: acc.inputTokens + model.inputTokens,
      cacheReadTokens: acc.cacheReadTokens + model.cacheReadTokens,
      cacheWriteTokens: acc.cacheWriteTokens + model.cacheWriteTokens,
      outputTokens: acc.outputTokens + model.outputTokens,
    }),
    { costUsd: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
  );
}

// ── Burn chart stacking (§D4/D5) ──────────────────────────────────────

const MODEL_PALETTE = [
  "#60a5fa",
  "#34d399",
  "#fbbf24",
  "#f472b6",
  "#a78bfa",
  "#fb7185",
  "#22d3ee",
  "#c084fc",
  "#f97316",
  "#84cc16",
] as const;

export interface UsageBurnChartLayer {
  readonly model: string;
  readonly color: string;
  readonly path: string;
  readonly costUsd: number;
}

export interface UsageBurnChartGeometry {
  readonly layers: ReadonlyArray<UsageBurnChartLayer>;
  readonly projectionPath: string | null;
  readonly nowX: number;
  readonly plot: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  };
  readonly yMax: number;
  readonly currentCostUsd: number;
}

const hashModel = (model: string): number =>
  Array.from(model).reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 0);

export function usageModelColor(model: string): string {
  return MODEL_PALETTE[hashModel(model) % MODEL_PALETTE.length]!;
}

export function usageChartModelOrder(
  models: ReadonlyArray<ServerUsageBreakdownModel>,
  series: ReadonlyArray<ServerUsageBreakdownSeriesBucket>,
): ReadonlyArray<string> {
  const totals = new Map<string, number>();
  for (const model of models)
    totals.set(model.model, (totals.get(model.model) ?? 0) + model.costUsd);
  for (const bucket of series) {
    for (const [model, cost] of Object.entries(bucket.byModel)) {
      if (!totals.has(model)) totals.set(model, cost);
    }
  }
  return Array.from(totals.entries())
    .filter(([, cost]) => cost > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([model]) => model);
}

export function buildUsageBurnChartGeometry({
  series,
  models,
  windowStart,
  windowEnd,
  now,
  bucketMinutes,
  projectedCostAtReset,
  width,
  height,
}: {
  readonly series: ReadonlyArray<ServerUsageBreakdownSeriesBucket>;
  readonly models: ReadonlyArray<ServerUsageBreakdownModel>;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly now: string;
  readonly bucketMinutes: number;
  readonly projectedCostAtReset: number | null;
  readonly width: number;
  readonly height: number;
}): UsageBurnChartGeometry {
  const plot = { left: 44, top: 12, right: width - 12, bottom: height - 28 };
  const startMs = Date.parse(windowStart);
  const endMs = Date.parse(windowEnd);
  const nowMs = Math.min(Math.max(Date.parse(now), startMs), endMs);
  const durationMs = Math.max(1, endMs - startMs);
  const modelOrder = usageChartModelOrder(models, series);
  const totalsByModel = new Map(models.map((model) => [model.model, model.costUsd] as const));
  const cumulative = new Map<string, number>(modelOrder.map((model) => [model, 0]));
  const points: Array<{ x: number; values: Map<string, number>; total: number }> = [
    { x: plot.left, values: new Map(cumulative), total: 0 },
  ];

  for (const bucket of series) {
    const bucketStartMs = Math.min(Math.max(Date.parse(bucket.bucketStart), startMs), nowMs, endMs);
    const bucketStartX =
      plot.left + ((bucketStartMs - startMs) / durationMs) * (plot.right - plot.left);
    if ((points.at(-1)?.x ?? plot.left) < bucketStartX) {
      points.push({
        x: bucketStartX,
        values: new Map(cumulative),
        total: Array.from(cumulative.values()).reduce((sum, value) => sum + value, 0),
      });
    }
    for (const [model, cost] of Object.entries(bucket.byModel)) {
      if (cumulative.has(model)) cumulative.set(model, (cumulative.get(model) ?? 0) + cost);
    }
    const total = Array.from(cumulative.values()).reduce((sum, value) => sum + value, 0);
    points.push({ x: bucketStartX, values: new Map(cumulative), total });
    const bucketEndMs = Math.min(bucketStartMs + bucketMinutes * 60_000, nowMs, endMs);
    if (bucketEndMs > bucketStartMs) {
      points.push({
        x: plot.left + ((bucketEndMs - startMs) / durationMs) * (plot.right - plot.left),
        values: new Map(cumulative),
        total,
      });
    }
  }

  const currentCostUsd = points.at(-1)?.total ?? 0;
  const yMax = Math.max(currentCostUsd, projectedCostAtReset ?? 0, 0.01);
  const y = (value: number) => plot.bottom - (value / yMax) * (plot.bottom - plot.top);
  const nowX = plot.left + ((nowMs - startMs) / durationMs) * (plot.right - plot.left);
  let lowerModels: string[] = [];
  const layers = modelOrder.map((model): UsageBurnChartLayer => {
    const lowerAt = (point: (typeof points)[number]) =>
      lowerModels.reduce((sum, previous) => sum + (point.values.get(previous) ?? 0), 0);
    const upper: Array<readonly [number, number]> = points.map((point) => [
      point.x,
      y(lowerAt(point) + (point.values.get(model) ?? 0)),
    ]);
    const lower: Array<readonly [number, number]> = points
      .toReversed()
      .map((point) => [point.x, y(lowerAt(point))]);
    lowerModels = [...lowerModels, model];
    return {
      model,
      color: usageModelColor(model),
      costUsd: totalsByModel.get(model) ?? points.at(-1)?.values.get(model) ?? 0,
      path:
        upper.length === 0
          ? ""
          : `M ${upper[0]![0].toFixed(1)} ${lower.at(-1)![1].toFixed(1)} L ${upper.map(([x, py]) => `${x.toFixed(1)} ${py.toFixed(1)}`).join(" L ")} L ${lower.map(([x, py]) => `${x.toFixed(1)} ${py.toFixed(1)}`).join(" L ")} Z`,
    };
  });

  return {
    layers,
    projectionPath:
      projectedCostAtReset === null || currentCostUsd <= 0
        ? null
        : `M ${nowX.toFixed(1)} ${y(currentCostUsd).toFixed(1)} L ${plot.right.toFixed(1)} ${y(projectedCostAtReset).toFixed(1)}`,
    nowX,
    plot,
    yMax,
    currentCostUsd,
  };
}

// ── Gauge projection sentence (§D4) ───────────────────────────────────

/**
 * The ccusage-monitor-style depletion sentence for a gauge card. Null when the
 * server-side slope guards suppress projection, or when there is no reset time.
 */
export function gaugeProjectionSentence(
  gauge: ServerUsageBreakdownGauge,
  nowMs: number,
): string | null {
  if (gauge.resetsAt === null) return null;
  const reset = formatClockTime(gauge.resetsAt, nowMs);
  if (gauge.usedPercent >= 100) return `Limit reached — resets ${reset}.`;
  if (gauge.projectedExhaustionAt === null) return null;
  return `At the current rate you'll hit 100% at ${formatClockTime(gauge.projectedExhaustionAt, nowMs)} — resets ${reset}.`;
}

// ── Header-click sorting ──────────────────────────────────────────────

export type UsageSortDirection = "asc" | "desc";

export interface UsageSort<Column extends string> {
  readonly column: Column;
  readonly direction: UsageSortDirection;
}

/** Header click: same column flips direction; a new column starts at its default. */
export function toggleUsageSort<Column extends string>(
  sort: UsageSort<Column>,
  column: Column,
  defaultDirection: UsageSortDirection = "desc",
): UsageSort<Column> {
  return sort.column === column
    ? { column, direction: sort.direction === "desc" ? "asc" : "desc" }
    : { column, direction: defaultDirection };
}

/** Sort rows by a selected value; nulls last, strings case-insensitive. */
export function sortUsageRows<Row>(
  rows: ReadonlyArray<Row>,
  value: (row: Row) => number | string | null,
  direction: UsageSortDirection,
): ReadonlyArray<Row> {
  const sign = direction === "asc" ? 1 : -1;
  return rows.toSorted((left, right) => {
    const a = value(left);
    const b = value(right);
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    if (typeof a === "string" || typeof b === "string") {
      return sign * String(a).localeCompare(String(b), undefined, { sensitivity: "base" });
    }
    return sign * (a - b);
  });
}

// ── Consumers rolled up to workstream root (§D5) ──────────────────────

export interface UsageConsumerGroup {
  readonly rootThreadId: ServerUsageBreakdownConsumer["rootThreadId"];
  /** Root thread's title when its row is in-window, else the costliest member's. */
  readonly title: string | null;
  readonly role: string | null;
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly turnCount: number;
  readonly lastActivityAt: string;
  /** All member thread rows (root's own row included), cost-descending. */
  readonly members: ReadonlyArray<ServerUsageBreakdownConsumer>;
  /** False when the group is just the root thread's own usage — nothing to expand. */
  readonly expandable: boolean;
}

/** Group the flat consumer rows by workstream root, cost-descending. */
export function groupUsageConsumers(
  consumers: ReadonlyArray<ServerUsageBreakdownConsumer>,
): ReadonlyArray<UsageConsumerGroup> {
  const byRoot = new Map<string, ServerUsageBreakdownConsumer[]>();
  for (const consumer of consumers) {
    const members = byRoot.get(consumer.rootThreadId);
    if (members) members.push(consumer);
    else byRoot.set(consumer.rootThreadId, [consumer]);
  }
  return Array.from(byRoot.entries())
    .map(([rootThreadId, rows]): UsageConsumerGroup => {
      const members = rows.toSorted((a, b) => b.costUsd - a.costUsd);
      const rootRow = members.find((row) => row.threadId === rootThreadId);
      return {
        rootThreadId: rootThreadId as ServerUsageBreakdownConsumer["rootThreadId"],
        title: rootRow?.title ?? members[0]?.title ?? null,
        role: rootRow?.role ?? null,
        totalTokens: members.reduce((sum, row) => sum + row.totalTokens, 0),
        costUsd: members.reduce((sum, row) => sum + row.costUsd, 0),
        turnCount: members.reduce((sum, row) => sum + row.turnCount, 0),
        lastActivityAt: members.reduce(
          (max, row) => (row.lastActivityAt > max ? row.lastActivityAt : max),
          "",
        ),
        members,
        expandable: members.length > 1 || members[0]?.threadId !== rootThreadId,
      };
    })
    .sort((a, b) => b.costUsd - a.costUsd);
}

// ── Formatting ────────────────────────────────────────────────────────

/** API-equivalent dollars: "$12.34", "<$0.01" for dust, "$0.00" only for zero. */
export function formatUsd(value: number): string {
  if (value > 0 && value < 0.005) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

/** Compact token count: 950, 12.4k, 3.2M, 1.1B. */
export function formatTokenCount(value: number): string {
  const scaled = (divisor: number, unit: string) => {
    const n = value / divisor;
    return `${n >= 100 ? Math.round(n) : n.toFixed(1).replace(/\.0$/, "")}${unit}`;
  };
  if (value >= 1e9) return scaled(1e9, "B");
  if (value >= 1e6) return scaled(1e6, "M");
  if (value >= 1e3) return scaled(1e3, "k");
  return String(Math.round(value));
}

const clockFormatter = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const weekdayClockFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});
const localDayFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "short" });

/** Local wall-clock time, with a date prefix when not today (e.g. "Thu 3 Jul, 17:42"). */
export function formatClockTime(iso: string, nowMs: number): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const sameDay = localDayFormatter.format(ms) === localDayFormatter.format(nowMs);
  return (sameDay ? clockFormatter : weekdayClockFormatter).format(ms);
}

/** "0–1 share" → "42%", keeping a decimal below 10% so small models stay visible. */
export function formatCostShare(share: number): string {
  const percent = share * 100;
  return `${percent >= 10 ? Math.round(percent) : percent.toFixed(1)}%`;
}
