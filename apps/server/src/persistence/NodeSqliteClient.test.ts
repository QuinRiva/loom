import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

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

      // A transaction that holds the connection open for a while, then rolls
      // back. Guards the semaphore contract on the worker client: plain
      // statements must queue behind the transaction's permit (else the
      // interleaved plain write would be erased by the rollback) and
      // transaction statements must not re-acquire it (else this deadlocks).
      const rolledBack = sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO entries(name) VALUES (${"txn"})`;
            yield* Effect.sleep(150);
            return yield* Effect.fail("rollback" as const);
          }),
        )
        .pipe(Effect.flip);

      const plain = sql`INSERT INTO entries(name) VALUES (${"plain"})`.pipe(Effect.delay(30));

      yield* Effect.all([rolledBack, plain], { concurrency: "unbounded" });

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
