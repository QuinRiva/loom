import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { stripUnservedToolOutputImageBytes } from "../orchestration-v2/toolOutputImageBytes.ts";
import { ToolOutputImageStore } from "../orchestration-v2/ToolOutputImageStore.loom.ts";

interface PayloadRow {
  readonly key: number;
  readonly payload_json: string;
}

/**
 * Rewrites stored turn items and their `turn-item.updated` events the way ingest stores new ones:
 * served image bytes move to content-addressed attachment files, unserved ones are dropped. Both
 * sides get the same deterministic rewrite, so replaying a rewritten event yields the rewritten row.
 * Commits per batch; a rewritten row no longer matches, so an interrupted run resumes on re-run.
 */
export const reclaimToolOutputImages = Effect.fn("ToolOutputImageReclaim.reclaim")(function* (
  options: { readonly batchRows?: number } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* ToolOutputImageStore;
  const batchRows = options.batchRows ?? 50;
  const sources = [
    {
      label: "turn items",
      select: (after: number) => sql<PayloadRow>`
        SELECT rowid AS key, payload_json FROM orchestration_v2_projection_turn_items
        WHERE rowid > ${after} AND type = 'dynamic_tool' AND instr(payload_json, 'image') > 0
        ORDER BY rowid LIMIT ${batchRows}`,
      update: (key: number, json: string) =>
        sql`UPDATE orchestration_v2_projection_turn_items SET payload_json = ${json} WHERE rowid = ${key}`,
    },
    {
      label: "turn-item.updated events",
      select: (after: number) => sql<PayloadRow>`
        SELECT sequence AS key, payload_json FROM orchestration_events
        WHERE sequence > ${after} AND event_type = 'turn-item.updated'
          AND instr(payload_json, 'image') > 0
        ORDER BY sequence LIMIT ${batchRows}`,
      update: (key: number, json: string) =>
        sql`UPDATE orchestration_events SET payload_json = ${json} WHERE sequence = ${key}`,
    },
  ];

  let rewrittenRows = 0;
  let bytesFreed = 0;
  for (const source of sources) {
    let after = 0;
    let rows: ReadonlyArray<PayloadRow>;
    do {
      rows = yield* source.select(after);
      const rewrites = yield* Effect.forEach(rows, (row) => {
        // Stored payloads are the JSON encoding of the turn item; only `type`, `threadId` and `output` are read.
        const item = JSON.parse(row.payload_json) as OrchestrationV2TurnItem;
        return store
          .persist(stripUnservedToolOutputImageBytes(item))
          .pipe(Effect.map((next) => (next === item ? [] : [{ row, json: JSON.stringify(next) }])));
      }).pipe(Effect.map((batches) => batches.flat()));
      yield* sql.withTransaction(
        Effect.forEach(rewrites, ({ row, json }) => source.update(row.key, json), {
          discard: true,
        }),
      );
      const freed = rewrites.reduce(
        (sum, { row, json }) => sum + Buffer.byteLength(row.payload_json) - Buffer.byteLength(json),
        0,
      );
      rewrittenRows += rewrites.length;
      bytesFreed += freed;
      after = rows.at(-1)?.key ?? after;
      if (rewrites.length > 0) {
        yield* Console.log(
          `${source.label}: rewrote ${rewrites.length} rows up to ${after}, ${formatMiB(freed)} freed`,
        );
      }
    } while (rows.length === batchRows);
  }
  return { rewrittenRows, bytesFreed };
});

export const formatMiB = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
