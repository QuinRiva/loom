import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { runMigrations } from "../Migrations.ts";
import { ServerConfig } from "../../config.ts";

type RuntimeSqliteLayerConfig = {
  readonly filename: string;
  readonly spanAttributes?: Record<string, unknown>;
};

type Loader = {
  layer: (config: RuntimeSqliteLayerConfig) => Layer.Layer<SqlClient.SqlClient, SqlError>;
};
const defaultSqliteClientLoaders = {
  bun: () => import("@effect/sql-sqlite-bun/SqliteClient"),
  // File-backed node databases run in a dedicated worker thread so long
  // statements cannot stall the main event loop; :memory: databases (tests)
  // stay on the fast in-process synchronous client.
  node: () => import("../NodeSqliteWorkerClient.ts"),
  nodeMemory: () => import("../NodeSqliteClient.ts"),
} satisfies Record<string, () => Promise<Loader>>;

const makeRuntimeSqliteLayer = Effect.fn("makeRuntimeSqliteLayer")(function* (
  config: RuntimeSqliteLayerConfig,
) {
  const runtime =
    process.versions.bun !== undefined
      ? "bun"
      : config.filename === ":memory:"
        ? "nodeMemory"
        : "node";
  const loader = defaultSqliteClientLoaders[runtime];
  const clientModule = yield* Effect.promise<Loader>(loader);
  return clientModule.layer(config);
}, Layer.unwrap);

const setup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA journal_mode = WAL;`;
    yield* sql`PRAGMA synchronous = NORMAL;`;
    // Live `t3 goal`/`t3 project` runs route over HTTP and never open this
    // file; cross-process access remains only for dead-server offline CLI mode
    // (plus the rare, human-initiated `t3 auth`/`t3 connect` residual — see
    // docs/plans/db-lane-reader-writer-split.md). SQLite permits one writer at
    // a time across processes, so the busy timeout is belt-and-braces for the
    // offline-CLI → server-startup overlap window: wait for the lock instead
    // of failing on contention.
    yield* sql`PRAGMA busy_timeout = 5000;`;
    yield* sql`PRAGMA foreign_keys = ON;`;
    // synchronous=NORMAL is durable-enough under WAL (only a crash mid-checkpoint
    // risks the last commits) and stops an fsync on every commit on the main loop.
    yield* sql`PRAGMA synchronous = NORMAL;`;
    // 128MB page cache (negative = KiB). The DB grew past 2GB; a real cache keeps
    // hot pages resident so synchronous reads on the event loop avoid disk.
    yield* sql`PRAGMA cache_size = -131072;`;
    // Wait rather than throw SQLITE_BUSY when the WAL writer briefly holds a lock.
    yield* sql`PRAGMA busy_timeout = 5000;`;
    yield* runMigrations();
  }),
);

export const makeSqlitePersistenceLive = Effect.fn("makeSqlitePersistenceLive")(function* (
  dbPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

  return Layer.provideMerge(
    setup,
    makeRuntimeSqliteLayer({
      filename: dbPath,
      spanAttributes: {
        "db.name": path.basename(dbPath),
        "service.name": "t3-server",
      },
    }),
  );
}, Layer.unwrap);

export const SqlitePersistenceMemory = Layer.provideMerge(
  setup,
  makeRuntimeSqliteLayer({ filename: ":memory:" }),
);

export const layerConfig = Layer.unwrap(
  Effect.map(Effect.service(ServerConfig), ({ dbPath }) => makeSqlitePersistenceLive(dbPath)),
);
