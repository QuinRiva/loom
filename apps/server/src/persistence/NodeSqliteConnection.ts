/**
 * Shared internals for the `node:sqlite` persistence clients: the synchronous
 * connection implementation (DatabaseSync + prepared-statement cache) and the
 * Rpc protocol used between the main-thread worker client and the sqlite
 * worker thread. Both `NodeSqliteClient` (in-process, used for `:memory:`
 * databases) and `SqliteWorker` (worker thread, used for file-backed
 * databases) execute statements through this module.
 *
 * @module NodeSqliteConnection
 */
import * as NodeSqlite from "node:sqlite";

import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { SqlError, classifySqliteError } from "effect/unstable/sql/SqlError";

export class UnsupportedNodeSqliteVersionError extends Schema.TaggedErrorClass<UnsupportedNodeSqliteVersionError>()(
  "UnsupportedNodeSqliteVersionError",
  {
    nodeVersion: Schema.String,
    requirement: Schema.String,
  },
) {
  override get message(): string {
    return `Node.js ${this.nodeVersion} is missing required node:sqlite APIs. Upgrade to ${this.requirement}.`;
  }
}

export class UnsupportedNodeSqliteOperationError extends Schema.TaggedErrorClass<UnsupportedNodeSqliteOperationError>()(
  "UnsupportedNodeSqliteOperationError",
  {},
) {
  override get message(): string {
    return "Node SQLite does not support executeStream.";
  }
}

/**
 * Verify that the current Node.js version includes the `node:sqlite` APIs
 * used by the sqlite clients — specifically `StatementSync.columns()` (added
 * in Node 22.16.0 / 23.11.0).
 *
 * @see https://github.com/nodejs/node/pull/57490
 */
export const checkNodeSqliteCompat = (): Effect.Effect<void> => {
  const parts = process.versions.node.split(".").map(Number);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const supported = (major === 22 && minor >= 16) || (major === 23 && minor >= 11) || major >= 24;

  if (!supported) {
    return Effect.die(
      new UnsupportedNodeSqliteVersionError({
        nodeVersion: process.versions.node,
        requirement: "Node.js >=22.16, >=23.11, or >=24",
      }),
    );
  }
  return Effect.void;
};

export interface NodeSqliteConnectionOptions {
  readonly prepareCacheSize?: number | undefined;
  readonly prepareCacheTTL?: Duration.Input | undefined;
}

export interface ExecuteOptions {
  /** Apply `setReadBigInts` so integer columns decode as bigints. */
  readonly safeIntegers: boolean;
  /** Return the raw `StatementResultingChanges` for non-row statements. */
  readonly raw: boolean;
  /** Prepare the statement fresh, bypassing the prepare cache. */
  readonly noCache: boolean;
}

/**
 * The synchronous statement executor shared by the in-process client and the
 * sqlite worker. Per-request behaviour (safe integers, raw results, value
 * arrays, cache bypass) is passed explicitly so callers on either side of the
 * worker boundary resolve it in their own context.
 */
export interface NodeSqliteRawConnection {
  readonly execute: (
    sql: string,
    params: ReadonlyArray<unknown>,
    options: ExecuteOptions,
  ) => Effect.Effect<ReadonlyArray<any>, SqlError>;
  readonly executeValues: (
    sql: string,
    params: ReadonlyArray<unknown>,
    options: { readonly safeIntegers: boolean },
  ) => Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, SqlError>;
}

export const makeRawConnection = Effect.fnUntraced(function* (
  openDatabase: () => NodeSqlite.DatabaseSync,
  options?: NodeSqliteConnectionOptions,
): Effect.fn.Return<NodeSqliteRawConnection, SqlError, Scope.Scope> {
  const scope = yield* Effect.scope;
  const db = yield* Effect.try({
    try: openDatabase,
    catch: (cause) =>
      new SqlError({
        reason: classifySqliteError(cause, {
          message: "Failed to open database",
          operation: "open",
        }),
      }),
  });
  yield* Scope.addFinalizer(
    scope,
    Effect.try({
      try: () => db.close(),
      catch: (cause) =>
        new SqlError({
          reason: classifySqliteError(cause, {
            message: "Failed to close database",
            operation: "close",
          }),
        }),
    }).pipe(Effect.orDie),
  );

  const statementReaderCache = new WeakMap<NodeSqlite.StatementSync, boolean>();
  const hasRows = (statement: NodeSqlite.StatementSync): boolean => {
    const cached = statementReaderCache.get(statement);
    if (cached !== undefined) {
      return cached;
    }
    const value = statement.columns().length > 0;
    statementReaderCache.set(statement, value);
    return value;
  };

  const prepare = (sql: string) =>
    Effect.try({
      try: () => db.prepare(sql),
      catch: (cause) =>
        new SqlError({
          reason: classifySqliteError(cause, {
            message: "Failed to prepare statement",
            operation: "prepare",
          }),
        }),
    });

  const prepareCache = yield* Cache.make({
    capacity: options?.prepareCacheSize ?? 200,
    timeToLive: options?.prepareCacheTTL ?? Duration.minutes(10),
    lookup: prepare,
  });

  const runStatement = (
    statement: NodeSqlite.StatementSync,
    params: ReadonlyArray<unknown>,
    options: { readonly safeIntegers: boolean; readonly raw?: boolean },
  ): Effect.Effect<ReadonlyArray<any>, SqlError> =>
    Effect.suspend(() => {
      try {
        statement.setReadBigInts(options.safeIntegers);
        if (hasRows(statement)) {
          return Effect.succeed(statement.all(...(params as any)));
        }
        const result = statement.run(...(params as any));
        return Effect.succeed(options.raw ? (result as unknown as ReadonlyArray<any>) : []);
      } catch (cause) {
        return Effect.fail(
          new SqlError({
            reason: classifySqliteError(cause, {
              message: "Failed to execute statement",
              operation: "execute",
            }),
          }),
        );
      }
    });

  return identity<NodeSqliteRawConnection>({
    execute: (sql, params, options) =>
      Effect.flatMap(options.noCache ? prepare(sql) : Cache.get(prepareCache, sql), (statement) =>
        runStatement(statement, params, options),
      ),
    executeValues: (sql, params, options) =>
      Effect.acquireUseRelease(
        Cache.get(prepareCache, sql),
        (statement) =>
          Effect.try({
            try: () => {
              statement.setReadBigInts(options.safeIntegers);
              if (hasRows(statement)) {
                statement.setReturnArrays(true);
                // Safe to cast to array after we've setReturnArrays(true)
                return statement.all(...(params as any)) as unknown as ReadonlyArray<
                  ReadonlyArray<unknown>
                >;
              }
              statement.run(...(params as any));
              return [];
            },
            catch: (cause) =>
              new SqlError({
                reason: classifySqliteError(cause, {
                  message: "Failed to execute statement",
                  operation: "execute",
                }),
              }),
          }),
        (statement) =>
          Effect.try({
            try: () => {
              if (hasRows(statement)) {
                statement.setReturnArrays(false);
              }
            },
            catch: (cause) =>
              new SqlError({
                reason: classifySqliteError(cause, {
                  message: "Failed to reset statement result mode",
                  operation: "resetResultMode",
                }),
              }),
          }).pipe(Effect.orDie),
      ),
  });
});

/**
 * Configuration handed to the sqlite worker via `workerData`. Durations are
 * flattened to milliseconds so the payload is structured-clone friendly.
 */
export interface SqliteWorkerData {
  readonly filename: string;
  readonly readonly: boolean;
  readonly queryOnly: boolean;
  readonly busyTimeoutMillis?: number | undefined;
  readonly allowExtension: boolean;
  readonly prepareCacheSize?: number | undefined;
  readonly prepareCacheTTLMillis?: number | undefined;
}

/**
 * Rpc protocol between the main-thread proxy `Connection` and the sqlite
 * worker. Payloads and results are passed through as-is — rows are
 * primitives / strings / Uint8Arrays / bigints, all of which structured
 * clone handles natively. `Schema.Any` (not `Schema.Unknown`) is load-
 * bearing: the Rpc pipeline encodes via `Schema.toCodecJson`, under which
 * `Unknown` maps to a JSON-value validator that rejects bigints and
 * Uint8Arrays, while `Any` passes values through untouched. `SqlError` is a
 * Schema tagged error, so it round-trips the boundary intact.
 */
export const SqliteWorkerRpcs = RpcGroup.make(
  Rpc.make("Execute", {
    payload: {
      sql: Schema.String,
      params: Schema.Array(Schema.Any),
      safeIntegers: Schema.Boolean,
      raw: Schema.Boolean,
      noCache: Schema.Boolean,
    },
    success: Schema.Any,
    error: SqlError,
  }),
  Rpc.make("ExecuteValues", {
    payload: {
      sql: Schema.String,
      params: Schema.Array(Schema.Any),
      safeIntegers: Schema.Boolean,
    },
    success: Schema.Any,
    error: SqlError,
  }),
);
