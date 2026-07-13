import type {
  ServerUsageBreakdownGauge,
  ServerUsageBreakdownInput,
  ServerUsageBreakdownResult,
  ServerUsageBreakdownSeriesBucket,
  AccountUsageSnapshot,
  AccountUsageWindow,
} from "@t3tools/contracts";
import { IsoDateTime, ThreadId, USAGE_METER_PROVIDER_NAMES } from "@t3tools/contracts";
import { accountUsageStorageKey } from "@t3tools/shared/accountUsage";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../../persistence/Errors.ts";
import { AccountUsageRegistry } from "../../provider/Services/AccountUsageRegistry.ts";
import {
  UsageBreakdownQuery,
  type UsageBreakdownQueryShape,
} from "../Services/UsageBreakdownQuery.ts";

// Window durations (piQuotas hardcodes these; a provider's own
// windowDurationMins overrides when present).
const PRIMARY_DURATION_MINS = 5 * 60;
const SECONDARY_DURATION_MINS = 7 * 24 * 60;
const MS_PER_MIN = 60_000;

// Burn-chart bucket sizes (§D3): 5 min for the 5h window, 60 min for the weekly.
const PRIMARY_BUCKET_MINS = 5;
const SECONDARY_BUCKET_MINS = 60;

// Cost projection guard (§D4.2): linear extrapolation is noise below 15 min.
const COST_PROJECTION_MIN_ELAPSED_MINS = 15;

// Matches the registry storage key so slope-buffer lookups and pill scope
// navigation resolve per pooled account, not per instance.
const usageAccountKey = accountUsageStorageKey;

const iso = (ms: number): string => DateTime.formatIso(DateTime.makeUnsafe(ms));

// Reconstruct a full Zulu ISO timestamp from a `substr(created_at, 1, 16)`
// ("YYYY-MM-DDTHH:MM") prefix so Date.parse is unambiguous (bare ISO without
// a zone is engine-dependent).
const parsePrefixMs = (prefix: string): number => Date.parse(`${prefix}:00.000Z`);

const BucketRow = Schema.Struct({
  bucketKey: Schema.String,
  model: Schema.String,
  costUsd: Schema.Number,
});
const ModelRow = Schema.Struct({
  model: Schema.String,
  providerId: Schema.String,
  inputTokens: Schema.Number,
  cacheReadTokens: Schema.Number,
  cacheWriteTokens: Schema.Number,
  outputTokens: Schema.Number,
  costUsd: Schema.Number,
});
const ConsumerRow = Schema.Struct({
  threadId: ThreadId,
  rootThreadId: ThreadId,
  title: Schema.NullOr(Schema.String),
  role: Schema.NullOr(Schema.String),
  totalTokens: Schema.Number,
  costUsd: Schema.Number,
  turnCount: Schema.Number,
  lastActivityAt: IsoDateTime,
});
const WindowTotalsRow = Schema.Struct({
  firstAt: Schema.NullOr(Schema.String),
  windowCost: Schema.Number,
});
const ProviderRow = Schema.Struct({
  providerId: Schema.String,
  costUsd: Schema.Number,
});

// Compiled once at module scope (the schema literal + compiled decoder are
// otherwise rebuilt on every query).
const decodeBucketRows = Schema.decodeUnknownEffect(Schema.Array(BucketRow));
const decodeModelRows = Schema.decodeUnknownEffect(Schema.Array(ModelRow));
const decodeConsumerRows = Schema.decodeUnknownEffect(Schema.Array(ConsumerRow));
const decodeWindowTotalsRows = Schema.decodeUnknownEffect(Schema.Array(WindowTotalsRow));
const decodeProviderRows = Schema.decodeUnknownEffect(Schema.Array(ProviderRow));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const registry = yield* AccountUsageRegistry;

  const runRows = <A>(
    operation: string,
    decode: (rows: unknown) => Effect.Effect<A, Schema.SchemaError>,
    query: Effect.Effect<ReadonlyArray<unknown>, SqlError>,
  ): Effect.Effect<A, ProjectionRepositoryError> =>
    query.pipe(
      Effect.mapError(toPersistenceSqlError(operation)),
      Effect.flatMap((rows) =>
        decode(rows).pipe(Effect.mapError(toPersistenceDecodeError(operation))),
      ),
    );

  const getBreakdown = (
    input: ServerUsageBreakdownInput,
  ): Effect.Effect<ServerUsageBreakdownResult, ProjectionRepositoryError> =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const kind = input.window;
      const durationMins = kind === "primary" ? PRIMARY_DURATION_MINS : SECONDARY_DURATION_MINS;
      const bucketMinutes = kind === "primary" ? PRIMARY_BUCKET_MINS : SECONDARY_BUCKET_MINS;

      const snapshots = yield* registry.snapshot;
      // Candidate gauges: every snapshot that reports the requested window kind.
      const candidates = snapshots.flatMap((snapshot) =>
        snapshot.windows
          .filter((window) => window.kind === kind)
          .map((window) => ({ snapshot, window })),
      );
      const freshest = (
        list: ReadonlyArray<{ snapshot: AccountUsageSnapshot; window: AccountUsageWindow }>,
      ) =>
        list.reduce<{ snapshot: AccountUsageSnapshot; window: AccountUsageWindow } | undefined>(
          (best, cur) =>
            best === undefined || cur.snapshot.observedAt > best.snapshot.observedAt ? cur : best,
          undefined,
        );

      // A reset in the past means the snapshot is stale (the registry has no
      // TTL; persistent poll failures leave the last reading behind). Treat it
      // as no usable reset so the trailing fallback engages instead of
      // computing the breakdown over a dead window (§5: stale official data ⇒
      // honest fallback, never extrapolation).
      const usableResetMs = (window: AccountUsageWindow): number | null => {
        const ms = window.resetsAt !== null ? Date.parse(window.resetsAt) : NaN;
        return Number.isFinite(ms) && ms > nowMs ? ms : null;
      };

      // Boundary provider: the requested scope's snapshot, else the freshest
      // snapshot with a usable reset time, else the freshest snapshot (§D2).
      // The scope arrives in two shapes: a pooled-account storage key (pill
      // deep-link — exact key match) or a backend provider id from the scope
      // tabs ("anthropic") — matched via the snapshot's meter → backend map,
      // mirroring the client's gaugeAppliesToScope.
      // Caveat: a requested scope with no live snapshot falls through to
      // ANOTHER provider's reset while rows still filter to the requested
      // meter — window and row set then describe different subscriptions.
      // Rare (scopes are normally picked from live meters); accepted.
      const requested = input.scope;
      // Backends a snapshot's meter covers: the static meter → backend map,
      // extended by ids declared on the instance's usage-source config (pooled
      // routers, e.g. ["cliproxy"]) — declared, never inferred.
      const meteredBackends = (snapshot: AccountUsageSnapshot): ReadonlyArray<string> => [
        ...(USAGE_METER_PROVIDER_NAMES[snapshot.providerName] ?? []),
        ...(snapshot.meteredProviderIds ?? []),
      ];
      const matchesScope = (snapshot: AccountUsageSnapshot, scope: string): boolean =>
        usageAccountKey(snapshot) === scope || meteredBackends(snapshot).includes(scope);
      // Pooled accounts all match a backend-id scope but reset at different
      // times; prefer a usable reset, then freshest observation.
      const scopedCandidates = requested
        ? candidates.filter((c) => matchesScope(c.snapshot, requested))
        : [];
      const boundary =
        (requested && requested !== "all"
          ? (freshest(scopedCandidates.filter((c) => usableResetMs(c.window) !== null)) ??
            freshest(scopedCandidates))
          : undefined) ??
        freshest(candidates.filter((c) => usableResetMs(c.window) !== null)) ??
        freshest(candidates);

      const resolvedScope = requested ?? (boundary ? usageAccountKey(boundary.snapshot) : "all");

      // Window boundaries: [resetsAt − duration, resetsAt] from the provider,
      // falling back to a trailing window ending now (§D2).
      const resetMs = boundary ? usableResetMs(boundary.window) : null;
      const provider = resetMs !== null;
      const windowEndMs = resetMs ?? nowMs;
      const windowStartMs =
        resetMs !== null
          ? resetMs - (boundary?.window.windowDurationMins ?? durationMins) * MS_PER_MIN
          : nowMs - durationMins * MS_PER_MIN;
      const windowStartIso = iso(windowStartMs);
      const windowEndIso = iso(windowEndMs);
      const boundarySource = provider ? "provider" : "trailing";

      // Row filter for the selected meter scope (§D6). "all" applies none. A
      // pooled-account scope arrives as a storage key (`instance\0label`); the
      // ledger is attributed per instance/backend, not per pooled account, so
      // strip the label suffix to the routing key before the meter lookup —
      // otherwise the NUL-suffixed string matches no `provider_id` and the burn
      // chart is silently empty for a per-account pill deep-link. A pooled
      // account's snapshot may declare the backend ids its meter covers
      // (meteredProviderIds); those take over when the routing key itself is
      // not a ledger backend (e.g. scope "pi\0carl@" → rows provider_id IN
      // ('cliproxy')). Note the pooled rows are shared across the instance's
      // accounts — the ledger cannot attribute per pooled account.
      const scopeRoutingKey =
        resolvedScope === "all" ? "all" : (resolvedScope.split("\u0000")[0] ?? resolvedScope);
      const scopeSnapshot = snapshots.find(
        (snapshot) => usageAccountKey(snapshot) === resolvedScope,
      );
      const scopeNames =
        scopeRoutingKey === "all"
          ? null
          : (USAGE_METER_PROVIDER_NAMES[scopeRoutingKey] ??
            (scopeSnapshot?.meteredProviderIds?.length
              ? scopeSnapshot.meteredProviderIds
              : [scopeRoutingKey]));
      // A fresh fragment per statement — reusing one Fragment across several
      // compiled statements misaligns bound parameters. Scope on the real
      // backend `provider_id` (NULL historical rows never match a scope, only
      // "all").
      const scopeFilter = () =>
        scopeNames ? sql.in("provider_id", scopeNames) : sql.literal("1=1");

      // ── Gauges: official % + linear depletion projection (§D4.1) ──────────
      const gauges: Array<ServerUsageBreakdownGauge> = [];
      for (const { snapshot, window } of candidates) {
        const slope = yield* registry.usageSlopePerMinute(
          usageAccountKey(snapshot),
          kind,
          nowMs,
          window.scope?.displayName,
        );
        let projectedExhaustionAt: string | null = null;
        if (slope !== null && window.resetsAt !== null) {
          const gaugeResetMs = Date.parse(window.resetsAt);
          const minutesToFull = (100 - window.usedPercent) / slope;
          const exhaustionMs = nowMs + minutesToFull * MS_PER_MIN;
          if (minutesToFull > 0 && Number.isFinite(gaugeResetMs) && exhaustionMs < gaugeResetMs) {
            projectedExhaustionAt = iso(exhaustionMs);
          }
        }
        gauges.push({
          providerName: snapshot.providerName,
          providerInstanceId: snapshot.providerInstanceId,
          ...(snapshot.accountLabel ? { accountLabel: snapshot.accountLabel } : {}),
          planType: snapshot.planType,
          usedPercent: window.usedPercent,
          resetsAt: window.resetsAt,
          windowDurationMins: window.windowDurationMins,
          observedAt: snapshot.observedAt,
          projectedExhaustionAt,
          ...(window.scope ? { scopeDisplayName: window.scope.displayName } : {}),
          ...(snapshot.meteredProviderIds?.length
            ? { meteredProviderIds: snapshot.meteredProviderIds }
            : {}),
        });
      }

      // ── Burn-chart series: cost per time bucket, stacked by model ──────────
      const bucketRows = yield* runRows(
        "UsageBreakdownQuery.series",
        decodeBucketRows,
        sql`
          SELECT substr(created_at, 1, 16) AS "bucketKey",
                 COALESCE(requested_model, 'unknown') AS "model",
                 COALESCE(SUM(cost_usd), 0) AS "costUsd"
          FROM projection_usage_ledger
          WHERE created_at >= ${windowStartIso} AND created_at < ${windowEndIso}
            AND ${scopeFilter()}
          GROUP BY "bucketKey", COALESCE(requested_model, 'unknown')
        `,
      );
      // Both windows group by the minute prefix: windowStart inherits the
      // provider reset's arbitrary sub-minute alignment (Codex resets are
      // epoch-second), so a coarser hour prefix would drop first-partial-hour
      // rows and shift others a bucket early. Minute grouping plus the clamp
      // below bounds residual misassignment to <60 s — invisible at 5/60-min
      // bucket scale — with zero drops, so the series always sums to the
      // model/window totals.
      const bucketMs = bucketMinutes * MS_PER_MIN;
      const byBucket = new Map<number, Record<string, number>>();
      for (const row of bucketRows) {
        const at = parsePrefixMs(row.bucketKey);
        if (!Number.isFinite(at)) continue;
        // Rows in the window's first partial minute truncate to a prefix just
        // before windowStart; they belong to bucket 0, never off-grid.
        const index = Math.max(0, Math.floor((at - windowStartMs) / bucketMs));
        const bucket = byBucket.get(index) ?? {};
        bucket[row.model] = (bucket[row.model] ?? 0) + row.costUsd;
        byBucket.set(index, bucket);
      }
      // Emit a contiguous grid from windowStart to the bucket containing now
      // (clamped to windowEnd) so WP4 can stack cumulatively without gap logic.
      const lastBucket = Math.max(
        0,
        Math.floor((Math.min(nowMs, windowEndMs) - windowStartMs) / bucketMs),
      );
      const series: Array<ServerUsageBreakdownSeriesBucket> = [];
      for (let i = 0; i <= lastBucket; i += 1) {
        series.push({
          bucketStart: iso(windowStartMs + i * bucketMs),
          byModel: byBucket.get(i) ?? {},
        });
      }

      // ── Per-model token/cost table ────────────────────────────────────────
      const modelRows = yield* runRows(
        "UsageBreakdownQuery.models",
        decodeModelRows,
        sql`
          SELECT COALESCE(requested_model, 'unknown') AS "model",
                 COALESCE(provider_id, 'unknown') AS "providerId",
                 COALESCE(SUM(input_tokens), 0) AS "inputTokens",
                 COALESCE(SUM(cache_read_tokens), 0) AS "cacheReadTokens",
                 COALESCE(SUM(cache_write_tokens), 0) AS "cacheWriteTokens",
                 COALESCE(SUM(output_tokens), 0) AS "outputTokens",
                 COALESCE(SUM(cost_usd), 0) AS "costUsd"
          FROM projection_usage_ledger
          WHERE created_at >= ${windowStartIso} AND created_at < ${windowEndIso}
            AND ${scopeFilter()}
          GROUP BY COALESCE(requested_model, 'unknown'), COALESCE(provider_id, 'unknown')
          ORDER BY "costUsd" DESC
        `,
      );
      const windowCost = modelRows.reduce((sum, row) => sum + row.costUsd, 0);
      const models = modelRows.map((row) => ({
        ...row,
        costShare: windowCost > 0 ? row.costUsd / windowCost : 0,
      }));

      // ── Consumers: per-thread aggregate rolled up to workstream root ───────
      const consumers = yield* runRows(
        "UsageBreakdownQuery.consumers",
        decodeConsumerRows,
        sql`
          WITH RECURSIVE
            per_thread AS (
              SELECT thread_id,
                     COALESCE(SUM(input_tokens + cache_read_tokens + cache_write_tokens + output_tokens), 0) AS total_tokens,
                     COALESCE(SUM(cost_usd), 0) AS cost_usd,
                     COUNT(DISTINCT turn_id) AS turn_count,
                     MAX(created_at) AS last_activity_at
              FROM projection_usage_ledger
              WHERE created_at >= ${windowStartIso} AND created_at < ${windowEndIso}
                AND ${scopeFilter()}
              GROUP BY thread_id
            ),
            ancestry(origin, node, parent) AS (
              SELECT pt.thread_id, pt.thread_id, thr.parent_thread_id
              FROM per_thread pt
              LEFT JOIN projection_threads thr ON thr.thread_id = pt.thread_id
              UNION ALL
              SELECT a.origin, thr.thread_id, thr.parent_thread_id
              FROM ancestry a
              JOIN projection_threads thr ON thr.thread_id = a.parent
              WHERE a.parent IS NOT NULL
            ),
            roots AS (
              SELECT origin, node AS root FROM ancestry WHERE parent IS NULL
            )
          SELECT pt.thread_id AS "threadId",
                 COALESCE(r.root, pt.thread_id) AS "rootThreadId",
                 thr.title AS "title",
                 thr.role AS "role",
                 pt.total_tokens AS "totalTokens",
                 pt.cost_usd AS "costUsd",
                 pt.turn_count AS "turnCount",
                 pt.last_activity_at AS "lastActivityAt"
          FROM per_thread pt
          LEFT JOIN projection_threads thr ON thr.thread_id = pt.thread_id
          LEFT JOIN roots r ON r.origin = pt.thread_id
          ORDER BY pt.cost_usd DESC, pt.total_tokens DESC
        `,
      );

      // ── Backend inventory (scope-independent): drives per-backend tabs ─────
      // No scope filter — the client needs the full set of backends present in
      // the window (incl. meterless ones like Vertex) to build a stable tab bar
      // regardless of which tab is selected. NULL provider_id (historical) rows
      // are excluded; they only aggregate under "all".
      const providerRows = yield* runRows(
        "UsageBreakdownQuery.providers",
        decodeProviderRows,
        sql`
          SELECT provider_id AS "providerId", COALESCE(SUM(cost_usd), 0) AS "costUsd"
          FROM projection_usage_ledger
          WHERE created_at >= ${windowStartIso} AND created_at < ${windowEndIso}
            AND provider_id IS NOT NULL
          GROUP BY provider_id
          ORDER BY "costUsd" DESC
        `,
      );

      // ── Cost projection to the window end (§D4.2) ─────────────────────────
      const totals = yield* runRows(
        "UsageBreakdownQuery.windowTotals",
        decodeWindowTotalsRows,
        sql`
          SELECT MIN(created_at) AS "firstAt", COALESCE(SUM(cost_usd), 0) AS "windowCost"
          FROM projection_usage_ledger
          WHERE created_at >= ${windowStartIso} AND created_at < ${windowEndIso}
            AND ${scopeFilter()}
        `,
      );
      const firstAt = totals[0]?.firstAt ?? null;
      const firstRowMs = firstAt ? Date.parse(firstAt) : NaN;
      const elapsedStartMs = Number.isFinite(firstRowMs)
        ? Math.max(windowStartMs, firstRowMs)
        : NaN;
      const minutesElapsed = (nowMs - elapsedStartMs) / MS_PER_MIN;
      // Trailing mode has no reset to project to (windowEnd = now), so the
      // "projection" would just echo windowCost — return null instead (§D4).
      const projectedCostAtReset =
        provider &&
        Number.isFinite(elapsedStartMs) &&
        minutesElapsed >= COST_PROJECTION_MIN_ELAPSED_MINS
          ? windowCost +
            (windowCost / minutesElapsed) * Math.max(0, (windowEndMs - nowMs) / MS_PER_MIN)
          : null;

      return {
        window: kind,
        scope: resolvedScope,
        windowStart: windowStartIso,
        windowEnd: windowEndIso,
        boundarySource,
        generatedAt: iso(nowMs),
        gauges,
        bucketMinutes,
        series,
        projectedCostAtReset,
        models,
        consumers,
        providers: providerRows,
      } satisfies ServerUsageBreakdownResult;
    });

  return { getBreakdown } satisfies UsageBreakdownQueryShape;
});

export const UsageBreakdownQueryLive = Layer.effect(UsageBreakdownQuery, make);
