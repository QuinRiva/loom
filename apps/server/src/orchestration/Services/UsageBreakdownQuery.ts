/**
 * UsageBreakdownQuery — server-side aggregation behind the /usage dashboard
 * (docs/usage-dashboard-design.md §3 D2/D3/D4).
 *
 * Derives the selected provider window's boundaries from the live
 * AccountUsageRegistry (trailing-window fallback when no reset data), then runs
 * SQL GROUP BYs over `projection_usage_ledger` to produce the burn-chart series
 * (cost per time bucket, stacked by model), the per-model token/cost table, and
 * the per-thread consumers rollup (to workstream root via a recursive CTE). It
 * also carries the official gauge %s + linear depletion/cost projections. Pull
 * only — one RPC per client refetch, no push stream.
 *
 * @module UsageBreakdownQuery
 */
import type { ServerUsageBreakdownInput, ServerUsageBreakdownResult } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface UsageBreakdownQueryShape {
  readonly getBreakdown: (
    input: ServerUsageBreakdownInput,
  ) => Effect.Effect<ServerUsageBreakdownResult, ProjectionRepositoryError>;
}

export class UsageBreakdownQuery extends Context.Service<
  UsageBreakdownQuery,
  UsageBreakdownQueryShape
>()("t3/orchestration/Services/UsageBreakdownQuery") {}
