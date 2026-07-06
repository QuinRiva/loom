import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { ServerConfig } from "../../config.ts";
import * as NodeSqliteWorkerClient from "../NodeSqliteWorkerClient.ts";

export class SqlReadClient extends Context.Service<SqlReadClient, SqlClient.SqlClient>()(
  "t3/persistence/Layers/SqliteRead/SqlReadClient",
) {}

type SqliteReadLayerConfig = {
  readonly filename: string;
  readonly spanAttributes?: Record<string, unknown>;
};

export const layer = (config: SqliteReadLayerConfig): Layer.Layer<SqlReadClient, SqlError> =>
  Layer.effect(SqlReadClient, SqlClient.SqlClient).pipe(
    Layer.provide(
      NodeSqliteWorkerClient.layer({
        ...config,
        queryOnly: true,
        busyTimeout: Duration.millis(250),
      }),
    ),
  );

export const makeSqliteReadLive = Effect.fn("makeSqliteReadLive")(function* (dbPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

  return layer({
    filename: dbPath,
    spanAttributes: {
      "db.name": `${path.basename(dbPath)}:read`,
      "service.name": "t3-server",
    },
  });
}, Layer.unwrap);

export const layerConfig = Layer.unwrap(
  Effect.map(Effect.service(ServerConfig), ({ dbPath }) => makeSqliteReadLive(dbPath)),
);
