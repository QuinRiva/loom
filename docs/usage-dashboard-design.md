---
manager_sessions:
  - id: 90713a56-4318-41ad-bff8-2045f7fe2614
    role: plan
    authored_at: 2026-07-03T03:35:38.547Z
---

# Usage-window cost breakdown dashboard — design

**Status:** implementation-ready design (v1 scope approved by orchestrator)
**Foundation:** two workstream research reports — data availability (`workstream-reports/dfc2d04e…`) and external design patterns (`workstream-reports/faab6950…`). Key file/line claims in those reports were spot-checked against this worktree on 2026-07-03; all held.

## 1. Intent

Clicking a sidebar subscription meter (`SidebarAccountUsagePill`) today navigates to `/settings/providers`, which answers nothing. Replace that with a `/usage` dashboard that explains the current 5-hour and weekly usage windows: which models consumed how many tokens at what cost, and which threads drove the burn.

Two data sources with strictly separated roles:

- **Official provider utilisation** (Anthropic OAuth `/api/oauth/usage`, Codex `wham/usage`, already polled every 60 s into `AccountUsageRegistry`) is the **only** source for the gauge percentages. The token→% mapping is undocumented and non-linear; we never render a locally computed % as if it were official.
- **Our own per-message usage ledger** (tokens, cost, model, thread) **explains** the burn: charts, tables, attributions. It will not sum to the official % — the meters are account-wide and cover other clients too; the UI says so plainly.

### v1 scope (approved)

1. Two gauge cards (5h + weekly): official %, reset countdown, linear depletion projection.
2. Burn chart: cumulative cost across the window, stacked by model, now-marker, dashed linear projection to the reset boundary, 5h ↔ weekly toggle.
3. Per-model table: input / output / cache-read / cache-write tokens, cost, % of window cost (cache buckets always separate — cache-write dominates cost on Anthropic-style models).
4. Top consumers table: threads rolled up to workstream root, expandable to children, header-click sorting, click-through to the thread.

### Explicitly deferred (schema must not block them; features not designed here)

Rerouting split (the ledger carries nullable `requested_model` / `resolved_model` from day one), window history, hourly heatmap, subscription-value framing, budget alerts. Subagent-level attribution is out of scope permanently (subagents are being removed); pi-internal subagent/oracle usage is invisible to T3's event stream and simply uncounted — noted as a caveat, not solved.

## 2. Current state (verified)

- Pi's `message_end` delivers the full `AssistantMessage`: `model` (requested slug), `usage.{input,output,cacheRead,cacheWrite,cacheWrite1h}` and `usage.cost.total` (authoritative dollars, per-message delta). `PiDriver.ts` (`normalizePiTokenUsage`, `message_end` case ~line 903) folds this into `ThreadTokenUsageSnapshot` (`packages/contracts/src/providerRuntime.ts:313`) and emits `thread.token-usage.updated`. **Gaps:** the snapshot has no model field, and cache-write tokens are folded into `inputTokens` rather than carried separately.
- `ProviderRuntimeIngestion.ts` (case `"thread.token-usage.updated"`, ~line 559) persists each snapshot verbatim as a `context-window.updated` activity in `projection_thread_activities` (payload_json). `ProjectionPipeline.ts` folds `cumulative_cost_usd` per thread. So per-message tokens+cost per thread/turn are already durably logged — just without model, cache-write split, or a window-scoped query path.
- `SubscriptionUsagePoller` → `AccountUsageRegistry` → `ws.ts` `accountUsage` push (~line 1824) → `useAccountUsage` → `deriveAccountUsageViews` (client-runtime) → pill. `AccountUsageWindow` = `{ kind: "primary"|"secondary", usedPercent, resetsAt, windowDurationMins }` — everything needed to derive window boundaries.
- The repo has an established WS RPC pattern (`packages/contracts/src/rpc.ts`, `Rpc.make` + `WS_METHODS`, handled in `ws.ts`, consumed via `packages/client-runtime/src/state/server.ts`) — e.g. `WsServerGetProcessResourceHistoryRpc`. The dashboard reuses it.
- `apps/web` has **no chart library** (checked `package.json`; mermaid exists but is for diagrams). Routing is TanStack file routes under `apps/web/src/routes/`.
- Rerouting (fable → Opus 4.8) is **not observable today**: the anthropic-messages API path and the custom Vertex provider never capture `message_start.message.model`, so `responseModel` is absent. The ledger reserves the column; the feature waits for an upstream patch.

## 3. Decisions

### D1 — Data model: a dedicated usage-ledger table, no backfill

**Decision:** new table `projection_usage_ledger`, one row per `thread.token-usage.updated` event, written by `ProviderRuntimeIngestion` alongside the existing activity insert. Rejected: querying `projection_thread_activities.payload_json` with `json_extract`.

Rationale:

- The model slug is not in any historical payload, so `json_extract` buys no historical coverage anyway — both options start collecting real data on deploy day.
- Typed, indexed columns make the window scan (`WHERE created_at >= ?`) and the group-bys trivial and fast; `json_extract` over an un-indexed `kind` across every activity row is the opposite of this repo's performance-first stance.
- Migration surface is one `CREATE TABLE` plus one insert in an existing handler; the activity-log shape stays untouched.
- Replay safety: `event_id` is the primary key and the insert is `INSERT OR IGNORE`, so event re-ingestion (restart, projection rebuild) cannot double-count. Like other projections, the table is derivable from `orchestration_events` and may be truncated + rebuilt.

**Backfill stance: none.** Data recorded before the change is simply absent from breakdowns. Both windows roll over within 7 days, so the ledger is complete for all visible windows one week after deploy. Backfilling from pi session jsonls was considered and rejected: cross-machine paths, message-id dedupe complexity, and no model attribution for non-pi rows — cost far exceeds a one-week gap.

#### DDL (migration `046_UsageLedger.ts`)

```sql
CREATE TABLE IF NOT EXISTS projection_usage_ledger (
  event_id             TEXT PRIMARY KEY,   -- runtime event id; replay-safe dedupe key
  thread_id            TEXT NOT NULL,
  turn_id              TEXT,
  provider_name        TEXT NOT NULL,      -- driver kind from the event envelope, e.g. "pi"
  provider_instance_id TEXT,               -- envelope providerInstanceId (nullable during migration)
  requested_model      TEXT,               -- pi AssistantMessage.model, e.g. "claude-fable-5"
  resolved_model       TEXT,               -- responseModel when the provider reports it; NULL today
  input_tokens         INTEGER NOT NULL DEFAULT 0,  -- pure input (no cache buckets)
  cache_read_tokens    INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens        INTEGER NOT NULL DEFAULT 0,
  cost_usd             REAL NOT NULL DEFAULT 0,     -- provider-authoritative per-message delta
  created_at           TEXT NOT NULL                -- ISO, from the event envelope
);
CREATE INDEX IF NOT EXISTS idx_usage_ledger_created ON projection_usage_ledger(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_ledger_thread_created ON projection_usage_ledger(thread_id, created_at);
```

#### Contract change (`packages/contracts/src/providerRuntime.ts`)

Extend `ThreadTokenUsageSnapshot` with optional fields (all adapters that cannot supply them leave them unset — never faked):

```ts
// Model attribution for the usage ledger. `model` is the slug the request was
// made with; `resolvedModel` is the concrete inference model when the provider
// reports one (reserved for rerouting visibility — unset today on the
// anthropic/vertex paths).
model: Schema.optional(TrimmedNonEmptyStringSchema),
resolvedModel: Schema.optional(TrimmedNonEmptyStringSchema),
// Cache-write prompt tokens, split out because cache writes are billed at a
// premium and dominate cost in agent workloads. `inputTokens` keeps its
// existing context-window semantics (input + cacheRead + cacheWrite).
cacheWriteTokens: Schema.optional(NonNegativeInt),
```

#### PiDriver change (`apps/server/src/provider/Drivers/PiDriver.ts`)

In `normalizePiTokenUsage` add `cacheWriteTokens: num(record.cacheWrite)` (`cacheWrite1h` is a subset of `cacheWrite` — Anthropic's 1h-retention split — so it must not be added on top). At the `message_end` call site, stamp `model` from `message.message.model` (authoritative per message — survives mid-session model switches; fall back to `session.session.model`) and `resolvedModel` from `message.message.responseModel` when present. That is the entire driver diff.

#### Ingestion change (`apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`)

In the `thread.token-usage.updated` case, alongside the activity, emit a ledger row derived from the snapshot + envelope:
`input_tokens = max(0, inputTokens − cachedInputTokens − cacheWriteTokens)`, other buckets verbatim, `cost_usd = costUsd ?? 0`. Rows with all-zero tokens are already filtered upstream (`usedTokens ≤ 0` drops the snapshot). Non-pi adapters that emit usable snapshots (Claude ACP) get rows automatically; rows without `model` aggregate under "unknown".

### D2 — Window boundaries from `AccountUsageRegistry`, trailing-window fallback

For the selected window kind, take the freshest `AccountUsageSnapshot` whose window has a non-null `resetsAt`:

- `windowEnd = resetsAt`, `windowStart = resetsAt − windowDurationMins` (Anthropic 5h windows start on first activity after the previous reset and end 5h later, so this subtraction is exact for the _current_ window; `windowDurationMins` is always populated — `piQuotas.ts` hardcodes 300/10080, Codex supplies `limit_window_seconds`).
- If several providers report usage (Anthropic + Codex), each gauge card uses its own provider's boundaries; the **burn chart and tables** use the boundaries of the provider whose meter was clicked (carried as a route search param), defaulting to the first provider with data.
- **Per-provider row filtering (v1 requirement, human-decided):** meters are separate subscriptions, so the breakdown (series, model table, consumers) includes **only ledger rows attributable to the selected meter**, via the same static meter → provider-instance mapping as §D6 (Anthropic OAuth meter ⇢ pi/anthropic instances; Codex meter ⇢ codex instances). Instances that report into no meter (e.g. Vertex-served Claude) are visible only under an explicit **"All providers"** scope, which aggregates everything and uses the clicked/default provider's boundaries.
- **Fallback** (no provider data at all, or `resetsAt` null): a trailing window ending now (`now − duration`, duration 5h/7d). The response marks `boundarySource: "provider" | "trailing"`; the UI labels trailing mode "approximate trailing window — no provider reset data" and renders **no gauges** (official % is never invented).

### D3 — Server surface: one pull RPC; aggregation in SQL on the server

No new push stream. The `accountUsage` push already streams gauge data continuously; the breakdown is a **pull** — the dashboard is a transient page and 60 s freshness (matching the poller cadence) is plenty.

New RPC in `packages/contracts/src/rpc.ts` (+ `WS_METHODS.serverGetUsageBreakdown = "server.getUsageBreakdown"`), handled in `ws.ts`, aggregation running server-side against sqlite:

```ts
export const ServerUsageBreakdownInput = Schema.Struct({
  window: AccountUsageWindowKind, // "primary" | "secondary"
  // Meter scope: a provider meter key (boundaries + row filter via the static
  // meter → instance mapping) or "all" (no row filter; boundaries from the
  // default provider). Default = first provider with data.
  scope: Schema.optional(TrimmedNonEmptyString),
});

export const ServerUsageBreakdownResult = Schema.Struct({
  window: AccountUsageWindowKind,
  windowStart: IsoDateTime,
  windowEnd: IsoDateTime, // reset time, or now in trailing mode (per §D2; the earlier now+duration comment was a contradiction, resolved in WP2)
  boundarySource: Schema.Literals(["provider", "trailing"]),
  generatedAt: IsoDateTime,
  // Official gauge data + projection, one entry per provider reporting usage.
  gauges: Schema.Array(
    Schema.Struct({
      providerName: TrimmedNonEmptyString,
      providerInstanceId: Schema.NullOr(ProviderInstanceId),
      planType: Schema.NullOr(TrimmedNonEmptyString),
      usedPercent: Schema.Number, // official, verbatim
      resetsAt: Schema.NullOr(IsoDateTime),
      windowDurationMins: Schema.NullOr(Schema.Number),
      observedAt: IsoDateTime,
      projectedExhaustionAt: Schema.NullOr(IsoDateTime), // null when guards fail (§D4)
    }),
  ),
  // Burn-chart series: cumulative cost per time bucket, stacked by model.
  bucketMinutes: Schema.Number, // 5 for primary, 60 for secondary
  series: Schema.Array(
    Schema.Struct({
      bucketStart: IsoDateTime,
      byModel: Schema.Record(Schema.String, Schema.Number), // model → cost in bucket (USD)
    }),
  ),
  projectedCostAtReset: Schema.NullOr(Schema.Number), // null when guards fail
  models: Schema.Array(
    Schema.Struct({
      model: Schema.String, // requested slug; "unknown" when absent
      providerName: TrimmedNonEmptyString,
      inputTokens: Schema.Number,
      cacheReadTokens: Schema.Number,
      cacheWriteTokens: Schema.Number,
      outputTokens: Schema.Number,
      costUsd: Schema.Number,
      costShare: Schema.Number, // 0–1 of window cost
    }),
  ),
  consumers: Schema.Array(
    Schema.Struct({
      // flat; client groups by rootThreadId
      threadId: ThreadId,
      rootThreadId: ThreadId,
      title: Schema.NullOr(Schema.String),
      role: Schema.NullOr(Schema.String),
      totalTokens: Schema.Number,
      costUsd: Schema.Number,
      turnCount: Schema.Number, // distinct turn_ids in window
      lastActivityAt: IsoDateTime,
    }),
  ),
});
```

Implementation notes for the handler (new `apps/server/src/orchestration/Layers/UsageBreakdownQuery.ts` or similar, following `ProjectionSnapshotQuery.ts`'s shape):

- Every aggregation query is additionally bounded by the scope's provider-instance set (`WHERE provider_instance_id IN (…)`, falling back to `provider_name` for rows with a NULL instance id) unless scope is `"all"`. `costShare` is relative to the _scoped_ window cost.
- Buckets and model rollups are single `GROUP BY` queries over the ledger bounded by `created_at >= windowStart` (the created-at index makes this cheap; ≤ tens of thousands of rows per week).
- Root rollup uses a recursive CTE over `projection_threads.parent_thread_id` to compute each thread's root, joined onto the per-thread aggregate. Thread title/role come from `projection_threads`.
- Bucket sizes: 5 min for the 5h window (60 points), 60 min for the weekly (168 points) — small enough to render as plain SVG with no downsampling logic client-side.
- Client refetches every 60 s while the page is mounted; countdown text re-derives client-side on a 30 s tick (same pattern as the pill).

### D4 — Projection maths (ccusage-style linear, with the researched guards)

Two independent projections; never mixed:

1. **Gauge depletion (official %):** slope from official samples, not from our ledger. Extend `AccountUsageRegistry` to keep an in-memory ring buffer of recent samples per (provider, window) — last 60 min (~60 samples at poller cadence, only appended when `observedAt` changes). `projectedExhaustionAt = now + (100 − current%) / slope`, where slope is the least-squares Δ%/Δt over the buffer. Guards: ≥ 3 distinct samples spanning ≥ 10 min, slope > 0, and projection only shown when it lands **before** `resetsAt` (otherwise the answer is "resets first", which the countdown already conveys). Buffer is memory-only — window _history_ is deferred, and losing the buffer on restart merely suppresses the projection for 10 min.
2. **Cost projection (chart):** `rate = windowCostSoFar / minutesElapsed` where elapsed runs from `max(windowStart, first ledger row in window)` to now; dashed line from the now-marker to `windowEnd` at that rate; `projectedCostAtReset = windowCost + rate × minutesRemaining`. Guard: elapsed ≥ 15 min, else null (early-window linear extrapolation is noise — the single most-cited pitfall).
3. Cache-read tokens are excluded from any burn-_health_ colouring (they inflate token counts meaninglessly); cost figures need no such exclusion because pi prices buckets correctly upstream.

Rendered sentence on each gauge card, verbatim ccusage-monitor style: _"At the current rate you'll hit 100% at 17:42 — resets 19:00."_ / _"On track: resets 19:00 before the limit."_

### D5 — UI: route `/usage`, hand-rolled SVG chart, no new dependency

- **Route:** new TanStack file route `apps/web/src/routes/usage.tsx` with optional search params `{ window?: "primary" | "secondary", scope?: string }` (meter key or `"all"`). `SidebarAccountUsagePill`'s `onOpenSettings` becomes `openUsageDashboard` → `navigate({ to: "/usage", search: { scope: view.key } })`. The hover popover stays as-is. The page shows a scope selector (one chip per meter + "All providers"), preselected from the search param.
- **Chart library: none.** `apps/web` has no charting dependency today and the requirement is one stacked cumulative step-area with ≤ 168 pre-bucketed points, a now-marker and one dashed line — comfortably a plain-SVG component (`<path>` per model layer, cumulative sums computed in a pure helper). Adding recharts/visx for this contradicts the repo's minimal-surface and performance priorities. Revisit only if the deferred heatmap/history features land.
- **Component tree** (`apps/web/src/components/usage/`):

```
routes/usage.tsx                     — route shell; search-param state; 60 s refetch
  UsageDashboardPage
    WindowToggle                     — 5h ↔ weekly (updates search param)
    ScopeSelector                    — meter chips + "All providers" (updates search param)
    WindowGaugeCard (per provider)   — official % bar, countdown, projection sentence, caveat line
    BurnChart                        — plain SVG: stacked cumulative cost, now-marker, dashed projection
      BurnChartLegend                — model → colour swatches
    ModelBreakdownTable              — token buckets × cost × share; header-click sort
    TopConsumersTable                — grouped by rootThreadId, expandable children,
                                       header-click sort, row click → thread route
```

- Pure view maths (bucket → cumulative stack, sort logic, countdown/projection formatting) lives in `packages/client-runtime/src/usageDashboard.ts` next to `accountUsage.ts` — shared with mobile later and unit-testable without the DOM.
- Table sorting is header-click (established preference); consumers default sort = cost desc; thread click-through reuses `threadRoutes.ts` helpers.
- Model colours: stable hash → palette assignment so a model keeps its colour across refetches.

### D6 — Honesty caveats in the UI

- Each gauge card footer: _"Official {provider} figure — counts all clients on this account, not just T3 Code."_ (extends the pill's existing wording).
- Breakdown section header chip: _"Tracked by T3 Code only — will not sum to the official meter."_
- The static provider-name → meter mapping (Anthropic OAuth ⇢ pi/anthropic instances; Codex ⇢ codex instances; everything else meterless) drives both the D2 row filter and badging; no per-message billing signal exists (`usesSubscriptionPricing` is reserved-but-unset). In a meter scope, out-of-meter rows are excluded entirely; in the **"All providers"** scope, models whose provider reports into no meter (e.g. Vertex-served fable/Opus) get a muted _"not counted in any meter"_ badge.
- Costs are labelled "API-equivalent cost" — subscription-billed messages carry notional API-rate dollars.
- Trailing-boundary mode banner per D2.

## 4. Implementation plan — 4 coder-sized work packages

**WP1 — Ledger foundations (server + contracts).** Contract fields on `ThreadTokenUsageSnapshot` (`model`, `resolvedModel`, `cacheWriteTokens`); PiDriver stamping at `message_end` + `normalizePiTokenUsage`; migration `046_UsageLedger.ts`; `INSERT OR IGNORE` in `ProviderRuntimeIngestion`. **Boundary:** no query surface, no UI. **Acceptance:** run a live pi turn; a ledger row appears with correct model, four token buckets, and `cost_usd` matching the activity payload; restart the server and confirm no duplicate rows; `vp check` + `vp run typecheck` pass.

**WP2 — Aggregation + RPC (server + client-runtime plumbing).** `AccountUsageRegistry` sample ring buffer + slope helper; window-boundary derivation incl. trailing fallback; meter-scope resolution (static meter → instance mapping) and row filtering; `UsageBreakdownQuery` (buckets, models, consumers CTE rollup); `ServerUsageBreakdownInput/Result` + `WsServerGetUsageBreakdownRpc` in contracts; `ws.ts` handler; client-runtime accessor. **Boundary:** consumes WP1's table; no UI. **Acceptance:** RPC returns a well-formed result against a live DB with data in-window; a meter scope excludes other providers' rows while `"all"` includes them; trailing mode exercised by clearing registry state; projection nulls respect the guards.

**WP3 — Dashboard page (web).** Route, pill navigation change, `UsageDashboardPage` with gauges, model table, consumers table, window toggle, scope selector, caveat copy, 60 s refetch. Burn chart slot renders a placeholder summary (window cost + projected cost). **Boundary:** consumes WP2's RPC; chart visual deferred to WP4. **Acceptance:** pill click lands on `/usage`; tables sort by header click; consumer rows expand and click through to threads; no-data and trailing states render sanely.

**WP4 — Burn chart + projection polish (web).** Plain-SVG stacked cumulative chart with now-marker and dashed projection, legend, gauge projection sentence, `usageDashboard.ts` pure helpers with unit tests where the maths is fiddly (stacking, slope guards). **Boundary:** pure client work on WP3's page. **Acceptance:** chart matches table totals; projection hidden under guard conditions; visual check across both windows.

WP1 → WP2 → WP3 → WP4 strictly ordered; WP3 and WP4 could overlap if staffed separately, but the chart consumes WP3's data wiring so sequential is simpler.

## 5. Risks & open questions

- **Ledger completeness:** only pi emits cost; Codex-driven threads appear token-only (cost 0). Acceptable for v1 — the table shows tokens regardless; flagged in the model table by provider.
- **Anthropic usage endpoint flakiness** (persistent 429s reported upstream): the poller already tolerates failures; stale `observedAt` should mute the projection (guarded by sample-span requirement) — WP2 must treat "stale official data" as "no projection", not extrapolate stale samples.
- **Per-provider filtering — RESOLVED (human decision, 2026-07-03):** meters are separate subscriptions, so the breakdown filters rows to the selected meter's provider instances by default, with an explicit "All providers" scope for the rest (see §D2/§D3). The earlier unfiltered default is superseded.
- **`projection_usage_ledger` vs projection rebuilds:** if a projection-rebuild path truncates projection tables, it must either also rebuild the ledger from `orchestration_events` or leave it untouched (it is independently replay-safe). WP1 must check the rebuild path and pick accordingly.
- **Rerouting:** `resolved_model` stays NULL until the ~2-line `pi-vertex-claude` patch lands and is verified live; no UI in v1 renders it.

## 6. Out of scope, restated

No window history persistence, no heatmap, no budget alerts, no subscription-value framing, no subagent attribution, no rerouting UI, no backfill. The schema above accommodates all of the first five without further migration except window history (which would persist the registry sample buffer — a new table when it happens).
