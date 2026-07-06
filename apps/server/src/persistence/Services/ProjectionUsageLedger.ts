/**
 * ProjectionUsageLedgerRepository - Repository for the per-message usage
 * ledger behind the /usage dashboard (docs/usage-dashboard-design.md §3 D1).
 *
 * One row per `thread.token-usage.updated` runtime event: model attribution,
 * the four token buckets, and the provider-authoritative cost delta. Written
 * only by ProviderRuntimeIngestion (a side channel, not the projector);
 * `event_id` PK + INSERT OR IGNORE keeps replays from double-counting.
 *
 * @module ProjectionUsageLedgerRepository
 */
import { EventId, IsoDateTime, ThreadId, TurnId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionUsageLedgerRow = Schema.Struct({
  eventId: EventId,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  providerInstanceId: Schema.NullOr(Schema.String),
  // Real backend provider identity (e.g. "google-vertex-claude", "openai-codex");
  // null when the emitting adapter can't resolve a real backend.
  providerId: Schema.NullOr(Schema.String),
  requestedModel: Schema.NullOr(Schema.String),
  resolvedModel: Schema.NullOr(Schema.String),
  inputTokens: Schema.Number,
  cacheReadTokens: Schema.Number,
  cacheWriteTokens: Schema.Number,
  outputTokens: Schema.Number,
  costUsd: Schema.Number,
  createdAt: IsoDateTime,
});
export type ProjectionUsageLedgerRow = typeof ProjectionUsageLedgerRow.Type;

export interface ProjectionUsageLedgerRepositoryShape {
  /** Insert a ledger row; a replayed event id is silently ignored. */
  readonly insert: (
    row: ProjectionUsageLedgerRow,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionUsageLedgerRepository extends Context.Service<
  ProjectionUsageLedgerRepository,
  ProjectionUsageLedgerRepositoryShape
>()("t3/persistence/Services/ProjectionUsageLedger/ProjectionUsageLedgerRepository") {}
