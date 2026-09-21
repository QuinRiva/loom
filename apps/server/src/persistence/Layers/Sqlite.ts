import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

// loom: two-lane migration ledger (upstream + loom 1001+).
import { runAllMigrations } from "../LoomMigrations.ts";
import { ServerConfig } from "../../config.ts";

const setup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA journal_mode = WAL;`;
    // loom: live `t3 goal`/`t3 project` runs route over HTTP and never open this
    // file; cross-process access remains only for dead-server offline CLI mode
    // (plus the rare, human-initiated `t3 auth`/`t3 connect` residual — see
    // docs/plans/db-lane-reader-writer-split.md). SQLite permits one writer at
    // a time across processes, so the busy timeout is belt-and-braces for the
    // offline-CLI → server-startup overlap window: wait for the lock instead
    // of failing on contention.
    yield* sql`PRAGMA busy_timeout = 5000;`;
    yield* sql`PRAGMA foreign_keys = ON;`;
    // loom: synchronous=NORMAL is durable-enough under WAL (only a crash mid-checkpoint
    // risks the last commits) and stops an fsync on every commit on the main loop.
    yield* sql`PRAGMA synchronous = NORMAL;`;
    // 128MB page cache (negative = KiB). The DB grew past 2GB; a real cache keeps
    // hot pages resident so synchronous reads on the event loop avoid disk.
    yield* sql`PRAGMA cache_size = -131072;`;
    yield* runAllMigrations();
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
    NodeSqliteClient.layer({
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
  NodeSqliteClient.layer({ filename: ":memory:" }),
);

export const layerConfig = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig;
    return makeSqlitePersistenceLive(dbPath);
  }),
);
