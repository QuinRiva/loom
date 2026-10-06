/**
 * LoomUsageLedger — seam 11's two spend queries over `loom_usage_ledger`.
 *
 * STUB FILE (3d-4): only the service tag, shaped exactly as track 3c's
 * `apps/server/src/loom/economics/LoomUsageLedger.ts` (same path, same names),
 * so 3d's ws methods compile against it. 3c's file — the tag plus its SQL
 * `layer` over migration 1049 — replaces this one at integration, and
 * `LoomUsageLedger.fixture.ts` is deleted with its line in `loom/serverLayers.ts`
 * (DL-438).
 *
 * `cachedTokens` = cache read + cache write; `inputTokens` is pure input.
 * Neither query has an error channel.
 *
 * @module loom/economics/LoomUsageLedger
 */
import type { IsoDateTime, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface ThreadSpend {
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
}

export interface LoomUsageLedgerShape {
  /** Lifetime spend per thread; a thread with no rows is absent from the map. */
  readonly threadSpend: (
    threadIds: ReadonlyArray<ThreadId>,
  ) => Effect.Effect<Map<ThreadId, ThreadSpend>>;
  /** The `limit` costliest threads since `since`, most expensive first. */
  readonly topSpend: (
    limit: number,
    since: IsoDateTime,
  ) => Effect.Effect<ReadonlyArray<ThreadSpend & { readonly threadId: ThreadId }>>;
}

export class LoomUsageLedger extends Context.Service<LoomUsageLedger, LoomUsageLedgerShape>()(
  "t3/loom/economics/LoomUsageLedger",
) {}
