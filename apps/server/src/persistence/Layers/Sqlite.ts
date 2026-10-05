import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MigrationError } from "effect/unstable/sql/Migrator"; // loom: see runAllMigrations below
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

// loom: two-lane migration ledger (upstream + loom 1001+).
import { runAllMigrations } from "../LoomMigrations.ts";
import { initializeV2Database } from "../initializeV2Database.ts";
import * as ServerConfig from "../../config.ts";

// Size the -wal file is cut back to on the first commit after a WAL reset.
export const WAL_SIZE_LIMIT_BYTES = 32 * 1024 * 1024;

const setup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // CLI and server write from separate processes; wait rather than fail with SQLITE_BUSY.
    yield* sql`PRAGMA busy_timeout = 5000;`;
    yield* sql`PRAGMA foreign_keys = ON;`;
    yield* sql`PRAGMA journal_mode = WAL;`;
    // loom: synchronous=NORMAL is durable-enough under WAL (only a crash mid-checkpoint
    // risks the last commits) and stops an fsync on every commit on the main loop.
    yield* sql`PRAGMA synchronous = NORMAL;`;
    // loom: 128MB page cache (negative = KiB). The DB grew past 2GB; a real cache keeps
    // hot pages resident so synchronous reads on the event loop avoid disk.
    yield* sql`PRAGMA cache_size = -131072;`;
    // PASSIVE checkpoints never shrink the -wal file, so it otherwise keeps its
    // largest size until the last connection closes.
    yield* sql.unsafe(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES};`);
    // loom: both ledgers; the fork ledger's refusal surfaces as upstream's MigrationError so
    // this layer keeps upstream's error channel (pull 9, DL-148).
    yield* runAllMigrations().pipe(
      Effect.catchTag("LoomLedgerReconciliationError", (error) =>
        Effect.fail(new MigrationError({ kind: "BadState", message: error.message })),
      ),
    );
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
        "service.name": "t3code-server",
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
    const { dbPath } = yield* ServerConfig.ServerConfig;
    yield* initializeV2Database(dbPath);
    return makeSqlitePersistenceLive(dbPath);
  }),
);
