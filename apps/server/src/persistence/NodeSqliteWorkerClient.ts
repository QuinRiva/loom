/**
 * Worker-backed `node:sqlite` client: the `SqlClient` wrapper stays on the main thread while the
 * `Connection` runs in a worker (`SqliteWorker.ts`), so long statements do not stall the event
 * loop. A worker crash fails in-flight requests as a fatal defect, like an in-process sqlite crash.
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
import * as Reactivity from "effect/reactivity/Reactivity";
import * as RpcClient from "effect/rpc/RpcClient";
import * as Client from "effect/sql/SqlClient";
import type { Connection } from "effect/sql/SqlConnection";
import { SqlError, ConnectionError } from "effect/sql/SqlError";
import * as Statement from "effect/sql/Statement";

import { timeIngestionWait } from "../diagnostics/ProviderRuntimeIngestionTelemetry.ts";
import type { SqliteClientConfig } from "./NodeSqliteClient.ts";
import {
  checkNodeSqliteCompat,
  SqliteWorkerRpcs,
  UnsupportedNodeSqliteOperationError,
} from "./NodeSqliteConnection.ts";
import type { SqliteWorkerData } from "./NodeSqliteConnection.ts";

const ATTR_DB_SYSTEM_NAME = "db.system.name";

/**
 * Dev runs from source, so the worker entry is the sibling `.ts`. In the packed build this module
 * is a chunk at the dist root while the worker keeps its source-relative path:
 * `dist/persistence/SqliteWorker.mjs`.
 */
const workerEntryUrl = (): URL =>
  import.meta.url.endsWith(".ts")
    ? new URL("./SqliteWorker.ts", import.meta.url)
    : new URL("./persistence/SqliteWorker.mjs", import.meta.url);

/**
 * Under `node --watch` the parent's `WATCH_REPORT_DEPENDENCIES` makes workers post `watch:import`
 * frames on the channel the Effect `RpcClient` reads, so it dies on `reading '_tag'` and the server
 * never listens. Delete the key: Node ignores an explicit `undefined` rather than unsetting it.
 */
const workerEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env.WATCH_REPORT_DEPENDENCIES;
  return env;
};

const make = Effect.fnUntraced(function* (options: SqliteClientConfig) {
  yield* checkNodeSqliteCompat();

  const compiler = Statement.makeCompilerSqlite(options.transformQueryNames);
  const transformRows = options.transformResultNames
    ? Statement.defaultTransforms(options.transformResultNames).array
    : undefined;

  const workerData: SqliteWorkerData = {
    filename: options.filename,
    readonly: options.readonly ?? false,
    queryOnly: options.queryOnly ?? false,
    busyTimeoutMillis:
      options.busyTimeout !== undefined ? Duration.toMillis(options.busyTimeout) : undefined,
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
      NodeWorker.layer(
        () => new NodeWorkerThreads.Worker(workerEntryUrl(), { workerData, env: workerEnv() }),
      ),
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
      Effect.catchTags(rpc.Execute({ ...request, safeIntegers }), { RpcClientError: Effect.die }),
    ) as Effect.Effect<ReadonlyArray<any>, SqlError>;

  const executeValuesWorker = (request: {
    readonly sql: string;
    readonly params: ReadonlyArray<unknown>;
    readonly noCache: boolean;
  }): Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, SqlError> =>
    Effect.flatMap(safeIntegers, (safeIntegers) =>
      Effect.catchTags(rpc.ExecuteValues({ ...request, safeIntegers }), {
        RpcClientError: Effect.die,
      }),
    ) as Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, SqlError>;

  const connection: Connection = {
    execute(sql, params, rowTransform) {
      const effect = executeWorker({ sql, params, raw: false, noCache: false });
      return rowTransform ? Effect.map(effect, rowTransform) : effect;
    },
    executeRaw(sql, params) {
      return executeWorker({ sql, params, raw: true, noCache: false });
    },
    executeValues(sql, params) {
      return executeValuesWorker({ sql, params, noCache: false });
    },
    executeValuesUnprepared(sql, params) {
      return executeValuesWorker({ sql, params: params ?? [], noCache: true });
    },
    executeUnprepared(sql, params, rowTransform) {
      const effect = executeWorker({ sql, params: params ?? [], raw: false, noCache: true });
      return rowTransform ? Effect.map(effect, rowTransform) : effect;
    },
    executeStream(_sql, _params) {
      return Stream.die(new UnsupportedNodeSqliteOperationError());
    },
  };

  const spanAttributes = [
    ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
    [ATTR_DB_SYSTEM_NAME, "sqlite"],
  ] as const;

  // The async round trip makes interleaving real (unlike the synchronous client, which releases the
  // permit before executing): plain statements hold the permit across the round trip so they cannot
  // land inside another fiber's transaction, which already holds the permit and uses the unlocked
  // connection.
  const semaphore = yield* Semaphore.make(1);
  // Lane wait + round trip is charged to a provider-runtime ingestion item when
  // one is running on this fibre (a no-op for everything else).
  const withPermit = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    timeIngestionWait("sqlReadMs", semaphore.withPermits(1)(effect));
  const lockedConnection: Connection = {
    execute: (sql, params, rowTransform) =>
      withPermit(connection.execute(sql, params, rowTransform)),
    executeRaw: (sql, params) => withPermit(connection.executeRaw(sql, params)),
    executeValues: (sql, params) => withPermit(connection.executeValues(sql, params)),
    executeValuesUnprepared: (sql, params) =>
      withPermit(connection.executeValuesUnprepared(sql, params)),
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
    spanAttributes,
    transformRows,
  });
});

export const layer = (config: SqliteClientConfig): Layer.Layer<Client.SqlClient, SqlError> =>
  Layer.effect(Client.SqlClient, make(config)).pipe(Layer.provide(Reactivity.layer));
