import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { toPersistenceSqlError } from "../Errors.ts";

import {
  ProjectionUsageLedgerRow,
  ProjectionUsageLedgerRepository,
  type ProjectionUsageLedgerRepositoryShape,
} from "../Services/ProjectionUsageLedger.ts";

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

  return { insert } satisfies ProjectionUsageLedgerRepositoryShape;
});

export const ProjectionUsageLedgerRepositoryLive = Layer.effect(
  ProjectionUsageLedgerRepository,
  makeProjectionUsageLedgerRepository,
);
