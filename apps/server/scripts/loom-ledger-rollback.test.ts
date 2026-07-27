import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { loomMigrationsTable } from "../src/persistence/LoomMigrations.ts";
import * as NodeSqliteClient from "../src/persistence/NodeSqliteClient.ts";
import { rollbackLedgers } from "./loom-ledger-rollback.ts";

/** Post-reconciliation state: upstream dense 1..34, fork dense 1001..1032. */
const seedReconciled = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of ["effect_sql_migrations", loomMigrationsTable]) {
    yield* sql`CREATE TABLE ${sql(table)} (
  migration_id integer PRIMARY KEY NOT NULL,
  created_at datetime NOT NULL DEFAULT current_timestamp,
  name VARCHAR(255) NOT NULL
)`;
  }
  for (let id = 1; id <= 34; id++) {
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
               VALUES (${id}, ${`Upstream${id}`})`;
  }
  for (let id = 1001; id <= 1032; id++) {
    yield* sql`INSERT INTO ${sql(loomMigrationsTable)} (migration_id, name)
               VALUES (${id}, ${`Fork${id}`})`;
  }
});

const entries = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly migration_id: number;
      readonly name: string;
    }>`SELECT migration_id, name FROM ${sql(table)} ORDER BY migration_id`.withoutTransform;
    return rows.map((row) => `${row.migration_id}_${row.name}`);
  });

/**
 * The script targets a real file (it is an operator tool, not a library), so
 * these run against a temp file on the same in-process client the script uses.
 */
const onTempDb = <A, E>(body: (databasePath: string) => Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-loom-rollback-" });
    const databasePath = path.join(dir, "state.sqlite");
    return yield* Effect.gen(function* () {
      yield* seedReconciled;
      return yield* body(databasePath);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.live("restores the single-ledger layout from the exact post-reconciliation state", () =>
  onTempDb((databasePath) =>
    Effect.gen(function* () {
      yield* rollbackLedgers({ databasePath, dryRun: false });

      const restored = yield* entries("effect_sql_migrations");
      assert.strictEqual(restored.length, 66);
      // Fork rows fold back to 33..64; upstream's 33/34 move back up to 65/66.
      assert.strictEqual(restored[32], "33_Fork1001");
      assert.strictEqual(restored[63], "64_Fork1032");
      assert.strictEqual(restored[64], "65_Upstream33");
      assert.strictEqual(restored[65], "66_Upstream34");

      const sql = yield* SqlClient.SqlClient;
      const marker = yield* sql<{
        readonly name: string;
      }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${loomMigrationsTable}`
        .withoutTransform;
      assert.deepStrictEqual(marker, [], "fork ledger table should be dropped");
    }),
  ),
);

it.live("a dry run reports the plan and changes nothing", () =>
  onTempDb((databasePath) =>
    Effect.gen(function* () {
      const before = yield* entries("effect_sql_migrations");

      yield* rollbackLedgers({ databasePath, dryRun: true });

      assert.deepStrictEqual(yield* entries("effect_sql_migrations"), before);
      assert.strictEqual((yield* entries(loomMigrationsTable)).length, 32);
    }),
  ),
);

it.live("refuses once the upstream lane has advanced past 34", () =>
  onTempDb((databasePath) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
                 VALUES (35, 'UpstreamFuture')`;

      const failure = yield* Effect.flip(rollbackLedgers({ databasePath, dryRun: false }));

      assert.strictEqual(failure._tag, "LedgerRollbackRefusedError");
      // The refusal is total: nothing was moved before it gave up.
      assert.strictEqual((yield* entries(loomMigrationsTable)).length, 32);
    }),
  ),
);

it.live("refuses once the fork lane has advanced past 1032", () =>
  onTempDb((databasePath) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO ${sql(loomMigrationsTable)} (migration_id, name)
                 VALUES (1033, 'ForkFuture')`;

      const failure = yield* Effect.flip(rollbackLedgers({ databasePath, dryRun: false }));

      assert.strictEqual(failure._tag, "LedgerRollbackRefusedError");
    }),
  ),
);

it.live("refuses on a database that was never reconciled", () =>
  onTempDb((databasePath) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TABLE ${sql(loomMigrationsTable)}`;

      const failure = yield* Effect.flip(rollbackLedgers({ databasePath, dryRun: false }));

      assert.strictEqual(failure._tag, "LedgerRollbackRefusedError");
    }),
  ),
);

it.live("is not repeatable: a second rollback refuses", () =>
  onTempDb((databasePath) =>
    Effect.gen(function* () {
      yield* rollbackLedgers({ databasePath, dryRun: false });

      const failure = yield* Effect.flip(rollbackLedgers({ databasePath, dryRun: false }));

      assert.strictEqual(failure._tag, "LedgerRollbackRefusedError");
    }),
  ),
);
