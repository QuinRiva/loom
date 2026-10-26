import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqliteClient from "./NodeSqliteClient.ts";
import * as SqliteWorkerClient from "./NodeSqliteWorkerClient.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("NodeSqliteClient", (it) => {
  it.effect("runs prepared queries and returns positional values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries(name) VALUES (${"alpha"}), (${"beta"})`;

      const rows = yield* sql<{ readonly id: number; readonly name: string }>`
      SELECT id, name FROM entries ORDER BY id
    `;
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.name, "alpha");
      assert.equal(rows[1]?.name, "beta");

      const values = yield* sql`SELECT id, name FROM entries ORDER BY id`.values;
      assert.equal(values.length, 2);
      assert.equal(values[0]?.[1], "alpha");
      assert.equal(values[1]?.[1], "beta");

      const unpreparedValues = yield* sql`SELECT id, name FROM entries ORDER BY id`
        .valuesUnprepared;
      assert.deepEqual(unpreparedValues, values);
    }),
  );

  it.effect("returns a typed failure when an unprepared statement cannot be prepared", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const error = yield* Effect.flip(sql.unsafe("SELECT FROM").unprepared);

      assert.equal(error._tag, "SqlError");
      assert.equal(error.reason.operation, "prepare");
    }),
  );
});

it.live("plain statements queue behind an open transaction on the worker client", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-sqlite-worker-" });
    const dbPath = path.join(dir, "test.sqlite");
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;

      // Holds the connection in a transaction, then rolls back: plain statements must queue behind
      // its permit (else the rollback erases the interleaved write) and transaction statements
      // must not re-acquire it (else this deadlocks).
      const inTransaction = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const rolledBack = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO entries(name) VALUES (${"txn"})`;
            yield* Deferred.succeed(inTransaction, undefined);
            yield* Deferred.await(release);
            return yield* Effect.fail("rollback" as const);
          }),
        )
        .pipe(Effect.flip, Effect.forkChild);

      yield* Deferred.await(inTransaction);
      const plain = yield* sql`INSERT INTO entries(name) VALUES (${"plain"})`.pipe(
        Effect.forkChild,
      );
      // Let the plain write reach the client while the transaction still holds it.
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(rolledBack);
      yield* Fiber.join(plain);

      const rows = yield* sql<{ readonly name: string }>`SELECT name FROM entries`;
      assert.deepEqual(
        rows.map((row) => row.name),
        ["plain"],
      );
    }).pipe(Effect.provide(SqliteWorkerClient.layer({ filename: dbPath })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("query-only worker clients read but reject writes", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-sqlite-reader-" });
    const dbPath = path.join(dir, "test.sqlite");

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries(name) VALUES (${"alpha"})`;
    }).pipe(Effect.provide(SqliteWorkerClient.layer({ filename: dbPath })));

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql.withTransaction(
        sql<{ readonly name: string }>`SELECT name FROM entries`,
      );
      assert.deepEqual(
        rows.map((row) => row.name),
        ["alpha"],
      );

      const error = yield* Effect.flip(sql`INSERT INTO entries(name) VALUES (${"beta"})`);
      assert.equal(error._tag, "SqlError");
      const transactionError = yield* Effect.flip(
        sql.withTransaction(sql`INSERT INTO entries(name) VALUES (${"gamma"})`),
      );
      assert.equal(transactionError._tag, "SqlError");
    }).pipe(
      Effect.provide(
        SqliteWorkerClient.layer({
          filename: dbPath,
          queryOnly: true,
          busyTimeout: Duration.millis(100),
        }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("returns a typed failure when the database cannot be opened", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      Layer.build(SqliteClient.layer({ filename: "\0" })).pipe(Effect.scoped),
    );

    assert.equal(error._tag, "SqlError");
    assert.equal(error.reason.operation, "open");
  }),
);
