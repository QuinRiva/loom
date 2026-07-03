/**
 * Worker-backed `node:sqlite` client: the `SqlClient` wrapper (compiler,
 * span attributes, transaction machinery) stays on the main thread while the
 * `Connection` internals execute in a dedicated worker thread
 * (`SqliteWorker.ts`), so long-running statements no longer stall the
 * server's event loop.
 *
 * The worker is spawned once per layer and torn down with the layer scope.
 * A worker crash fails in-flight requests as a defect and is fatal, matching
 * the blast radius of an in-process sqlite crash.
 *
 * @module NodeSqliteWorkerClient
 */
import * as NodeWorkerThreads from "node:worker_threads";

import * as NodeWorker from "@effect/platform-node/NodeWorker";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as Client from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import { SqlError, ConnectionError } from "effect/unstable/sql/SqlError";
import * as Statement from "effect/unstable/sql/Statement";

import type { SqliteClientConfig } from "./NodeSqliteClient.ts";
import {
  checkNodeSqliteCompat,
  SqliteWorkerRpcs,
  UnsupportedNodeSqliteOperationError,
} from "./NodeSqliteConnection.ts";
import type { SqliteWorkerData } from "./NodeSqliteConnection.ts";

const ATTR_DB_SYSTEM_NAME = "db.system.name";

/**
 * In development the server runs directly from source (`node src/bin.ts`
 * with type stripping), so the worker entry is the sibling `.ts` file. In
 * the packed build (`vp pack`) this module becomes a chunk at the dist root
 * while the worker entry preserves its source-relative path, emitted at
 * `dist/persistence/SqliteWorker.mjs`.
 */
const workerEntryUrl = (): URL =>
  import.meta.url.endsWith(".ts")
    ? new URL("./SqliteWorker.ts", import.meta.url)
    : new URL("./persistence/SqliteWorker.mjs", import.meta.url);

const make = Effect.fnUntraced(function* (options: SqliteClientConfig) {
  yield* checkNodeSqliteCompat();

  const compiler = Statement.makeCompilerSqlite(options.transformQueryNames);
  const transformRows = options.transformResultNames
    ? Statement.defaultTransforms(options.transformResultNames).array
    : undefined;

  const workerData: SqliteWorkerData = {
    filename: options.filename,
    readonly: options.readonly ?? false,
    allowExtension: options.allowExtension ?? false,
    prepareCacheSize: options.prepareCacheSize,
    prepareCacheTTLMillis:
      options.prepareCacheTTL !== undefined
        ? Duration.toMillis(options.prepareCacheTTL)
        : undefined,
  };

  // The protocol (and the worker it spawns) is acquired in the layer scope,
  // so the worker lives exactly as long as the SqlClient layer.
  const protocol = yield* RpcClient.makeProtocolWorker({ size: 1, concurrency: 1 }).pipe(
    Effect.provide(
      NodeWorker.layer(() => new NodeWorkerThreads.Worker(workerEntryUrl(), { workerData })),
    ),
    Effect.mapError(
      (workerError) =>
        new SqlError({
          reason: new ConnectionError({
            message: "Failed to start sqlite worker",
            operation: "open",
            cause: workerError,
          }),
        }),
    ),
  );
  const rpc = yield* RpcClient.make(SqliteWorkerRpcs).pipe(
    Effect.provideService(RpcClient.Protocol, protocol),
  );

  const safeIntegers = Effect.withFiber<boolean>((fiber) =>
    Effect.succeed(Boolean(Context.get(fiber.context, Client.SafeIntegers))),
  );

  // A worker crash (or any other protocol failure) is fatal in v1, matching
  // today's in-process crash behaviour. Results come back as `unknown` over
  // the wire; the worker executes the same shared connection code the
  // in-process client uses, so the row-array shape is guaranteed.
  const executeWorker = (request: {
    readonly sql: string;
    readonly params: ReadonlyArray<unknown>;
    readonly raw: boolean;
    readonly noCache: boolean;
  }): Effect.Effect<ReadonlyArray<any>, SqlError> =>
    Effect.flatMap(safeIntegers, (safeIntegers) =>
      Effect.catchTag(rpc.Execute({ ...request, safeIntegers }), "RpcClientError", Effect.die),
    ) as Effect.Effect<ReadonlyArray<any>, SqlError>;

  const connection: Connection = {
    execute(sql, params, rowTransform) {
      const effect = executeWorker({ sql, params, raw: false, noCache: false });
      return rowTransform ? Effect.map(effect, rowTransform) : effect;
    },
    executeRaw(sql, params) {
      return executeWorker({ sql, params, raw: true, noCache: false });
    },
    executeValues(sql, params) {
      return Effect.flatMap(safeIntegers, (safeIntegers) =>
        Effect.catchTag(
          rpc.ExecuteValues({ sql, params, safeIntegers }),
          "RpcClientError",
          Effect.die,
        ),
      ) as Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, SqlError>;
    },
    executeUnprepared(sql, params, rowTransform) {
      const effect = executeWorker({ sql, params: params ?? [], raw: false, noCache: true });
      return rowTransform ? Effect.map(effect, rowTransform) : effect;
    },
    executeStream(_sql, _params) {
      return Stream.die(new UnsupportedNodeSqliteOperationError());
    },
  };

  // Unlike the synchronous in-process client — where the permit can be
  // released before execution because a synchronous statement cannot be
  // interleaved — the async worker round trip makes the race window real: a
  // plain statement could otherwise land inside another fiber's open
  // transaction. Plain statements therefore hold the permit across the whole
  // round trip, while transaction statements use the unlocked connection
  // (the transaction scope already holds the permit, so plain statements
  // queue behind the open transaction exactly as before).
  const semaphore = yield* Semaphore.make(1);
  const withPermit = semaphore.withPermits(1);
  const lockedConnection: Connection = {
    execute: (sql, params, rowTransform) =>
      withPermit(connection.execute(sql, params, rowTransform)),
    executeRaw: (sql, params) => withPermit(connection.executeRaw(sql, params)),
    executeValues: (sql, params) => withPermit(connection.executeValues(sql, params)),
    executeUnprepared: (sql, params, rowTransform) =>
      withPermit(connection.executeUnprepared(sql, params, rowTransform)),
    executeStream: connection.executeStream,
  };

  const acquirer = Effect.succeed(lockedConnection);
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

export const layer = (config: SqliteClientConfig): Layer.Layer<Client.SqlClient, SqlError> =>
  Layer.effect(Client.SqlClient, make(config)).pipe(Layer.provide(Reactivity.layer));
