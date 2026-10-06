/**
 * LoomUsageLedger — seam 11's two spend queries over `loom_usage_ledger`
 * (migration 1049: V1's ledger renamed; V2 rows written by `UsageLedgerReactor`,
 * one per terminal provider turn). 3d's Cost tab and context chips build
 * against exactly these signatures and test with their own fixture layer.
 *
 * `cachedTokens` = cache read + cache write; `inputTokens` is pure input (V1's
 * column meaning). A read failure is a defect: the queries carry no error.
 *
 * @module loom/economics/LoomUsageLedger
 */
import type { IsoDateTime, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

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

type SpendRow = ThreadSpend & { readonly threadId: ThreadId };

const spendColumns = (sql: SqlClient.SqlClient) => sql`
  thread_id AS "threadId",
  total(cost_usd) AS "costUsd",
  total(input_tokens) AS "inputTokens",
  total(output_tokens) AS "outputTokens",
  total(cache_read_tokens + cache_write_tokens) AS "cachedTokens"`;

export const layer = Layer.effect(
  LoomUsageLedger,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return {
      threadSpend: (threadIds) =>
        threadIds.length === 0
          ? Effect.succeed(new Map())
          : sql<SpendRow>`
              SELECT ${spendColumns(sql)} FROM loom_usage_ledger
              WHERE ${sql.in("thread_id", threadIds)}
              GROUP BY thread_id`.pipe(
              Effect.map(
                (rows) => new Map(rows.map(({ threadId, ...spend }) => [threadId, spend])),
              ),
              Effect.orDie,
            ),
      topSpend: (limit, since) =>
        sql<SpendRow>`
          SELECT ${spendColumns(sql)} FROM loom_usage_ledger
          WHERE created_at >= ${since}
          GROUP BY thread_id
          ORDER BY "costUsd" DESC
          LIMIT ${limit}`.pipe(Effect.orDie),
    } satisfies LoomUsageLedgerShape;
  }),
);
