/**
 * In-process port of `@effect/sql-sqlite-node` that uses the native
 * `node:sqlite` bindings instead of `better-sqlite3`.
 *
 * Used for `:memory:` databases (tests). File-backed databases route through
 * `NodeSqliteWorkerClient`, which hosts the same shared connection
 * (`NodeSqliteConnection.ts`) in a dedicated worker thread.
 *
 * @module SqliteClient
 */
import * as NodeSqlite from "node:sqlite";

import * as Config from "effect/Config";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Context from "effect/Context";
import * as Stream from "effect/Stream";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as Client from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as Statement from "effect/unstable/sql/Statement";

import {
  checkNodeSqliteCompat,
  makeRawConnection,
  UnsupportedNodeSqliteOperationError,
} from "./NodeSqliteConnection.ts";

const ATTR_DB_SYSTEM_NAME = "db.system.name";

export const TypeId: TypeId = "~local/sqlite-node/SqliteClient";

export type TypeId = "~local/sqlite-node/SqliteClient";

export interface SqliteClientConfig {
  readonly filename: string;
  readonly readonly?: boolean | undefined;
  readonly queryOnly?: boolean | undefined;
  readonly busyTimeout?: Duration.Input | undefined;
  readonly allowExtension?: boolean | undefined;
  readonly prepareCacheSize?: number | undefined;
  readonly prepareCacheTTL?: Duration.Input | undefined;
  readonly spanAttributes?: Record<string, unknown> | undefined;
  readonly transformResultNames?: ((str: string) => string) | undefined;
  readonly transformQueryNames?: ((str: string) => string) | undefined;
}

export interface SqliteMemoryClientConfig extends Omit<
  SqliteClientConfig,
  "filename" | "readonly"
> {}

const makeWithDatabase = Effect.fn("makeWithDatabase")(function* (
  options: SqliteClientConfig,
  openDatabase: () => NodeSqlite.DatabaseSync,
): Effect.fn.Return<Client.SqlClient, SqlError, Scope.Scope | Reactivity.Reactivity> {
  yield* checkNodeSqliteCompat();

  const compiler = Statement.makeCompilerSqlite(options.transformQueryNames);
  const transformRows = options.transformResultNames
    ? Statement.defaultTransforms(options.transformResultNames).array
    : undefined;

  const raw = yield* makeRawConnection(openDatabase, options);

  const safeIntegers = Effect.withFiber<boolean>((fiber) =>
    Effect.succeed(Boolean(Context.get(fiber.context, Client.SafeIntegers))),
  );

  const connection = identity<Connection>({
    execute(sql, params, rowTransform) {
      const effect = Effect.flatMap(safeIntegers, (safeIntegers) =>
        raw.execute(sql, params, { safeIntegers, raw: false, noCache: false }),
      );
      return rowTransform ? Effect.map(effect, rowTransform) : effect;
    },
    executeRaw(sql, params) {
      return Effect.flatMap(safeIntegers, (safeIntegers) =>
        raw.execute(sql, params, { safeIntegers, raw: true, noCache: false }),
      );
    },
    executeValues(sql, params) {
      return Effect.flatMap(safeIntegers, (safeIntegers) =>
        raw.executeValues(sql, params, { safeIntegers }),
      );
    },
    executeUnprepared(sql, params, rowTransform) {
      const effect = Effect.flatMap(safeIntegers, (safeIntegers) =>
        raw.execute(sql, params ?? [], { safeIntegers, raw: false, noCache: true }),
      );
      return rowTransform ? Effect.map(effect, rowTransform) : effect;
    },
    executeStream(_sql, _params) {
      return Stream.die(new UnsupportedNodeSqliteOperationError());
    },
  });

  const semaphore = yield* Semaphore.make(1);

  const acquirer = semaphore.withPermits(1)(Effect.succeed(connection));
  const transactionAcquirer = Effect.uninterruptibleMask((restore) => {
    const fiber = Fiber.getCurrent()!;
    const scope = Context.getUnsafe(fiber.context, Scope.Scope);
    return Effect.as(
      Effect.tap(restore(semaphore.take(1)), () => Scope.addFinalizer(scope, semaphore.release(1))),
      connection,
    );
  });

  return yield* Client.make({
    acquirer,
    compiler,
    transactionAcquirer,
    spanAttributes: [
      ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
      [ATTR_DB_SYSTEM_NAME, "sqlite"],
    ],
    transformRows,
  });
});

const make = (
  options: SqliteClientConfig,
): Effect.Effect<Client.SqlClient, SqlError, Scope.Scope | Reactivity.Reactivity> =>
  makeWithDatabase(
    options,
    () =>
      new NodeSqlite.DatabaseSync(options.filename, {
        readOnly: options.readonly ?? false,
        allowExtension: options.allowExtension ?? false,
      }),
  );

const makeMemory = (
  config: SqliteMemoryClientConfig = {},
): Effect.Effect<Client.SqlClient, SqlError, Scope.Scope | Reactivity.Reactivity> =>
  makeWithDatabase(
    {
      ...config,
      filename: ":memory:",
      readonly: false,
    },
    () => {
      const database = new NodeSqlite.DatabaseSync(":memory:", {
        allowExtension: config.allowExtension ?? false,
      });
      return database;
    },
  );

export const layerConfig = (
  config: Config.Wrap<SqliteClientConfig>,
): Layer.Layer<Client.SqlClient, Config.ConfigError | SqlError> =>
  Layer.effect(Client.SqlClient, Config.unwrap(config).pipe(Effect.flatMap(make))).pipe(
    Layer.provide(Reactivity.layer),
  );

export const layer = (config: SqliteClientConfig): Layer.Layer<Client.SqlClient, SqlError> =>
  Layer.effect(Client.SqlClient, make(config)).pipe(Layer.provide(Reactivity.layer));

export const layerMemory = (
  config: SqliteMemoryClientConfig = {},
): Layer.Layer<Client.SqlClient, SqlError> =>
  Layer.effect(Client.SqlClient, makeMemory(config)).pipe(Layer.provide(Reactivity.layer));
