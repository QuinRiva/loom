/**
 * Worker-thread entrypoint hosting the synchronous `node:sqlite` connection.
 *
 * Spawned by `NodeSqliteWorkerClient` with a `SqliteWorkerData` payload in
 * `workerData`. Serves the `SqliteWorkerRpcs` protocol over the Effect worker
 * runner, so every statement executes off the server's main event loop.
 * Shutdown is parent-driven: the Rpc scope teardown sends the close signal
 * and the database close finalizer runs before the worker exits.
 *
 * @module SqliteWorker
 */
import * as NodeSqlite from "node:sqlite";
import * as NodeWorkerThreads from "node:worker_threads";

import * as NodeWorkerRunner from "@effect/platform-node/NodeWorkerRunner";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcServer from "effect/unstable/rpc/RpcServer";

import { makeRawConnection, SqliteWorkerRpcs } from "./NodeSqliteConnection.ts";
import type { SqliteWorkerData } from "./NodeSqliteConnection.ts";

const config = NodeWorkerThreads.workerData as SqliteWorkerData;

const HandlersLive = SqliteWorkerRpcs.toLayer(
  Effect.gen(function* () {
    const connection = yield* makeRawConnection(
      () =>
        new NodeSqlite.DatabaseSync(config.filename, {
          readOnly: config.readonly,
          allowExtension: config.allowExtension,
        }),
      {
        prepareCacheSize: config.prepareCacheSize,
        prepareCacheTTL:
          config.prepareCacheTTLMillis !== undefined
            ? Duration.millis(config.prepareCacheTTLMillis)
            : undefined,
      },
    );
    return SqliteWorkerRpcs.of({
      Execute: (request) => connection.execute(request.sql, request.params, request),
      ExecuteValues: (request) => connection.executeValues(request.sql, request.params, request),
    });
  }),
);

const MainLive = RpcServer.layer(SqliteWorkerRpcs).pipe(
  Layer.provide(HandlersLive),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(NodeWorkerRunner.layer),
);

Effect.runFork(Layer.launch(MainLive));
