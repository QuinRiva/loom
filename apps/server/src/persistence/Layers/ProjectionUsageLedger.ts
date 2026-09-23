import { ThreadSpendInput, ThreadSpendRow } from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../Errors.ts";

import {
  ProjectionUsageLedgerRow,
  ProjectionUsageLedgerRepository,
  type ProjectionUsageLedgerRepositoryShape,
} from "../Services/ProjectionUsageLedger.ts";

/** Rows the Usage page's top-spending-threads section shows. */
const TOP_SPENDING_THREAD_LIMIT = 10;

const makeProjectionUsageLedgerRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertRow = SqlSchema.void({
    Request: ProjectionUsageLedgerRow,
    execute: (row) =>
      sql`
        INSERT OR IGNORE INTO projection_usage_ledger (
          event_id, thread_id, turn_id, provider_instance_id,
          provider_id, requested_model, resolved_model,
          input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
          cost_usd, created_at
        ) VALUES (
          ${row.eventId}, ${row.threadId}, ${row.turnId},
          ${row.providerInstanceId}, ${row.providerId}, ${row.requestedModel}, ${row.resolvedModel},
          ${row.inputTokens}, ${row.cacheReadTokens}, ${row.cacheWriteTokens},
          ${row.outputTokens}, ${row.costUsd}, ${row.createdAt}
        )
      `,
  });

  const insert: ProjectionUsageLedgerRepositoryShape["insert"] = (row) =>
    insertRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionUsageLedgerRepository.insert:query")),
    );

  // No index orders by cost, so the window is scanned and grouped behind the
  // `created_at` index: ~50 ms for 30 days and ~150 ms over the whole 176k-row
  // ledger of the cockpit database, on the read lane.
  // A thread whose projection row is gone (deleted, or never projected) joins to
  // NULL and is reported by id alone.
  const selectTopSpendingThreads = SqlSchema.findAll({
    Request: ThreadSpendInput,
    Result: ThreadSpendRow,
    execute: ({ sinceTime, untilTime }) =>
      sql`
        SELECT
          ledger.thread_id AS "threadId",
          thread.title AS "title",
          sum(ledger.cost_usd) AS "costUsd",
          sum(
            ledger.input_tokens + ledger.cache_read_tokens
            + ledger.cache_write_tokens + ledger.output_tokens
          ) AS "totalTokens",
          count(DISTINCT ledger.turn_id) AS "turns"
        FROM projection_usage_ledger AS ledger
        LEFT JOIN projection_threads AS thread
          ON thread.thread_id = ledger.thread_id AND thread.deleted_at IS NULL
        WHERE ledger.created_at >= ${sinceTime} AND ledger.created_at < ${untilTime}
        GROUP BY ledger.thread_id
        ORDER BY "costUsd" DESC
        LIMIT ${TOP_SPENDING_THREAD_LIMIT}
      `,
  });

  const topSpendingThreads: ProjectionUsageLedgerRepositoryShape["topSpendingThreads"] = (input) =>
    selectTopSpendingThreads(input).pipe(
      Effect.mapError((cause): ProjectionRepositoryError =>
        Schema.isSchemaError(cause)
          ? toPersistenceDecodeError(
              "ProjectionUsageLedgerRepository.topSpendingThreads:decodeRows",
            )(cause)
          : toPersistenceSqlError("ProjectionUsageLedgerRepository.topSpendingThreads:query")(
              cause,
            ),
      ),
    );

  return { insert, topSpendingThreads } satisfies ProjectionUsageLedgerRepositoryShape;
});

export const ProjectionUsageLedgerRepositoryLive = Layer.effect(
  ProjectionUsageLedgerRepository,
  makeProjectionUsageLedgerRepository,
);
