#!/usr/bin/env node

/**
 * Inverse of the migration-lane-split reconciliation: folds loom `1001..1032` back to `33..64` and
 * upstream `33`/`34` up to `65`/`66`. Run it BEFORE reverting to old code, which would re-run `35..66`.
 * Refuses once either lane has advanced past the post-reconciliation state; restore from backup then.
 * Usage: `node apps/server/scripts/loom-ledger-rollback.ts --base-dir <path> [--dry-run]`
 */

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { Command, Flag } from "effect/cli";

import { loomMigrationsTable } from "../src/persistence/LoomMigrations.ts";
import * as NodeSqliteClient from "../src/persistence/NodeSqliteClient.ts";

export class LedgerRollbackRefusedError extends Schema.TaggedError<LedgerRollbackRefusedError>()(
  "LedgerRollbackRefusedError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

const expectedUpstream = Array.from({ length: 34 }, (_, i) => i + 1);
const expectedLoom = Array.from({ length: 32 }, (_, i) => 1001 + i);

const ledgerIds = Effect.fn("ledgerIds")(function* (table: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly migration_id: number;
  }>`SELECT migration_id FROM ${sql(table)} ORDER BY migration_id`.withoutTransform;
  return rows.map((row) => row.migration_id);
});

const dense = (actual: ReadonlyArray<number>, expected: ReadonlyArray<number>) =>
  actual.length === expected.length && actual.every((id, i) => id === expected[i]);

/**
 * Reverse the reconciliation, or fail with {@link LedgerRollbackRefusedError} if
 * the database is not in the exact state the inverse is defined for.
 */
export const rollbackLedgers = Effect.fn("rollbackLedgers")(function* (options: {
  readonly databasePath: string;
  readonly dryRun: boolean;
}) {
  const sql = yield* SqlClient.SqlClient;

  const marker = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${loomMigrationsTable}`
    .withoutTransform;
  if (marker.length === 0) {
    return yield* new LedgerRollbackRefusedError({
      reason:
        `${options.databasePath} has no ${loomMigrationsTable} table — it was never reconciled, ` +
        `so there is nothing to roll back.`,
    });
  }

  const upstream = yield* ledgerIds("effect_sql_migrations");
  const loom = yield* ledgerIds(loomMigrationsTable);
  if (!dense(upstream, expectedUpstream) || !dense(loom, expectedLoom)) {
    return yield* new LedgerRollbackRefusedError({
      reason:
        `${options.databasePath} has advanced past the rollback window.\n` +
        `  expected effect_sql_migrations 1..34 and ${loomMigrationsTable} 1001..1032\n` +
        `  found    effect_sql_migrations max ${upstream.at(-1) ?? "(empty)"} (${upstream.length} rows), ` +
        `${loomMigrationsTable} max ${loom.at(-1) ?? "(empty)"} (${loom.length} rows)\n` +
        `Once either lane has run a new migration the historical single-ledger order cannot be ` +
        `reconstructed. Restore this database from backup instead.`,
    });
  }

  if (options.dryRun) {
    return `would roll back ${options.databasePath} to the single-ledger layout (1..66)`;
  }

  yield* sql.withTransaction(
    Effect.gen(function* () {
      // Vacate 33/34 upwards before folding the fork rows back down onto them.
      yield* sql`UPDATE effect_sql_migrations SET migration_id = migration_id + 32
                 WHERE migration_id IN (33, 34)`;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, created_at, name)
                 SELECT migration_id - 968, created_at, name FROM ${sql(loomMigrationsTable)}`;
      yield* sql`DROP TABLE ${sql(loomMigrationsTable)}`;
    }),
  );

  const restored = yield* ledgerIds("effect_sql_migrations");
  if (
    !dense(
      restored,
      Array.from({ length: 66 }, (_, i) => i + 1),
    )
  ) {
    return yield* new LedgerRollbackRefusedError({
      reason: `rollback produced a non-dense ledger: ${restored.join(", ")}`,
    });
  }
  return `rolled back ${options.databasePath} to the single-ledger layout (1..66) — now revert the code`;
});

const runLedgerRollback = Effect.fn("runLedgerRollback")(function* (options: {
  readonly baseDir: string;
  readonly dryRun: boolean;
}) {
  const path = yield* Path.Path;
  const databasePath = path.join(options.baseDir, "userdata", "state.sqlite");
  return yield* rollbackLedgers({ databasePath, dryRun: options.dryRun }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: databasePath })),
  );
});

const loomLedgerRollbackCommand = Command.make(
  "loom-ledger-rollback",
  {
    baseDir: Flag.String("base-dir").pipe(
      Flag.withDescription("T3 base directory containing userdata/state.sqlite."),
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Report what would change without writing."),
    ),
  },
  (options) => Effect.flatMap(runLedgerRollback(options), Console.log),
).pipe(
  Command.withDescription(
    "Reverse the migration-lane-split ledger reconciliation. Run BEFORE reverting to pre-lane-split code.",
  ),
);

if (import.meta.main) {
  Command.run(loomLedgerRollbackCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
