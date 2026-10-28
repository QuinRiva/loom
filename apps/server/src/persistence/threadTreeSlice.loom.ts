/**
 * Copying thread trees between databases: the parts `migrate-dev-db` (a dev slice of the live home)
 * and `t3 loom-migrate` (moving trees to another instance) share. Thread families are selected by
 * `lineage.rootThreadId`, rows by "every table with a `thread_id` column", per-instance tables are
 * cleared down their foreign keys, and FTS5 shadow tables are never copied (the index is rebuilt).
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

export class ThreadTreeServerRunningError extends Schema.TaggedError<ThreadTreeServerRunningError>()(
  "ThreadTreeServerRunningError",
  {
    databasePath: Schema.String,
    pid: Schema.Number,
  },
) {
  override get message(): string {
    return `Database at '${this.databasePath}' is open by a running server (pid ${this.pid} per server-runtime.json). Stop that server first; if that pid is not actually a T3 server (stale descriptor, reused pid), delete the server-runtime.json next to the database and retry.`;
  }
}

export class ThreadTreeDatabaseBusyError extends Schema.TaggedError<ThreadTreeDatabaseBusyError>()(
  "ThreadTreeDatabaseBusyError",
  {
    databasePath: Schema.String,
    reason: Schema.Literals(["write-locked", "wal-held"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const detail =
      this.reason === "write-locked"
        ? "the database is write-locked"
        : "another connection is holding its WAL";
    return `Database at '${this.databasePath}' looks in use (${detail}). Stop its server first; if none is running, delete the -wal/-shm files next to it.`;
  }
}

const ServerRuntimeState = Schema.fromJsonString(Schema.Struct({ pid: Schema.Number }));
const decodeServerRuntimeState = Schema.decodeEffect(ServerRuntimeState);

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Refuses a database a server holds: the runtime pid catches idle servers, `BEGIN IMMEDIATE` and a WAL truncate busy ones. */
export const ensureNotInUse = Effect.fn("threadTreeSlice.ensureNotInUse")(function* (
  databasePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const runtimeStatePath = path.join(path.dirname(databasePath), "server-runtime.json");
  const runtimeState = yield* fs
    .readFileString(runtimeStatePath)
    .pipe(Effect.flatMap(decodeServerRuntimeState), Effect.option);
  if (Option.isSome(runtimeState) && isProcessAlive(runtimeState.value.pid)) {
    return yield* new ThreadTreeServerRunningError({
      databasePath,
      pid: runtimeState.value.pid,
    });
  }

  if (!(yield* fs.exists(databasePath))) {
    return;
  }
  const checkpoint = yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe("PRAGMA busy_timeout = 0").unprepared;
    yield* sql.unsafe("BEGIN IMMEDIATE").unprepared;
    yield* sql.unsafe("ROLLBACK").unprepared;
    return yield* sql.unsafe<{ busy: number }>("PRAGMA wal_checkpoint(TRUNCATE)").unprepared;
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: databasePath })),
    Effect.mapError(
      (cause) => new ThreadTreeDatabaseBusyError({ databasePath, reason: "write-locked", cause }),
    ),
  );
  if (checkpoint[0] !== undefined && Number(checkpoint[0].busy) !== 0) {
    return yield* new ThreadTreeDatabaseBusyError({ databasePath, reason: "wal-held" });
  }
});

/** Per-instance state: never leaves the home it belongs to. */
export const PER_INSTANCE_TABLES: ReadonlyArray<string> = [
  "scheduled_tasks",
  "orchestration_v2_effect_outbox",
  "orchestration_v2_thread_launch_workflows",
  "provider_session_runtime",
  "auth_sessions",
  "auth_pairing_links",
];

/** Shared by several threads, so selected by session binding rather than by its nullable `thread_id`. */
export const PROVIDER_SESSIONS_TABLE = "orchestration_v2_projection_provider_sessions";
const FTS5_SHADOW_SUFFIXES = ["_data", "_idx", "_content", "_docsize", "_config"];

/** The root a thread's family is keyed by. */
export const familyRootSql = (alias: string) =>
  `COALESCE(json_extract(${alias}.payload_json, '$.lineage.rootThreadId'), ${alias}.thread_id)`;

export interface SliceSchema {
  readonly entries: ReadonlyArray<{ type: string; name: string; sql: string }>;
  /** Real tables only: an FTS5 virtual table makes its own shadow tables and contentless rows cannot be copied. */
  readonly tables: ReadonlyArray<{ type: string; name: string; sql: string }>;
  readonly virtualTables: ReadonlyArray<string>;
  /** Tables with a `thread_id` column, and whether it is nullable. */
  readonly threadIdNullable: ReadonlyMap<string, boolean>;
  /** The given tables plus every table whose foreign keys reach one of them. */
  readonly cleared: ReadonlySet<string>;
}

/** Reads a database's schema (`schemaName` is `main` or an attached alias). */
export const readSliceSchema = Effect.fn("threadTreeSlice.readSchema")(function* (
  schemaName: string,
  clearedTables: ReadonlyArray<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  const entries = yield* sql.unsafe<{ type: string; name: string; sql: string }>(
    `SELECT type, name, sql FROM "${schemaName}".sqlite_master
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'`,
  ).unprepared;
  const threadColumns = yield* sql<{ name: string; notnull: number }>`
    SELECT m.name, c."notnull" FROM ${sql(schemaName)}.sqlite_master m, pragma_table_info(m.name, ${schemaName}) c
    WHERE m.type = 'table' AND c.name = 'thread_id'`;
  const virtualTables = entries
    .filter((entry) => entry.type === "table" && /^CREATE VIRTUAL TABLE/i.test(entry.sql))
    .map((entry) => entry.name);
  const isShadowTable = (name: string) =>
    virtualTables.some((virtual) =>
      FTS5_SHADOW_SUFFIXES.some((suffix) => name === `${virtual}${suffix}`),
    );
  // A row that points into a cleared table cannot be copied, so whatever references one is
  // cleared with it, however far down the chain a newer migration added it.
  const references = yield* sql<{ name: string; parent: string }>`
    SELECT m.name, f."table" AS parent FROM ${sql(schemaName)}.sqlite_master m, pragma_foreign_key_list(m.name, ${schemaName}) f
    WHERE m.type = 'table'`;
  const cleared = new Set(clearedTables);
  for (let grew = true; grew;) {
    grew = false;
    for (const { name, parent } of references) {
      if (cleared.has(parent) && !cleared.has(name)) {
        cleared.add(name);
        grew = true;
      }
    }
  }
  return {
    entries,
    tables: entries.filter((entry) => entry.type === "table" && !isShadowTable(entry.name)),
    virtualTables,
    threadIdNullable: new Map(threadColumns.map((row) => [row.name, row.notnull === 0])),
    cleared,
  } satisfies SliceSchema;
});

/**
 * `INSERT INTO main.<t> SELECT * FROM <from>.<t> <filter>` for every real table neither cleared
 * nor virtual; `filter` returns the WHERE clause for a table (empty copies it whole, `null` skips it).
 */
export const copyTables = Effect.fn("threadTreeSlice.copyTables")(function* (
  schema: SliceSchema,
  from: string,
  filter: (table: string, threadIdNullable: boolean | undefined) => string | null,
) {
  const sql = yield* SqlClient.SqlClient;
  for (const { name } of schema.tables) {
    if (schema.cleared.has(name) || schema.virtualTables.includes(name)) continue;
    const where = filter(name, schema.threadIdNullable.get(name));
    if (where === null) continue;
    yield* sql.unsafe(`INSERT INTO main."${name}" SELECT * FROM "${from}"."${name}" ${where}`)
      .unprepared;
  }
});
