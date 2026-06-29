import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { toPersistenceSqlError } from "../Errors.ts";

import {
  ProjectionThreadHeartbeat,
  ProjectionThreadHeartbeatRepository,
  type ProjectionThreadHeartbeatRepositoryShape,
} from "../Services/ProjectionThreadHeartbeats.ts";

const makeProjectionThreadHeartbeatRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const touchRow = SqlSchema.void({
    Request: ProjectionThreadHeartbeat,
    execute: (row) =>
      sql`
        INSERT INTO projection_thread_heartbeats (thread_id, last_activity_at)
        VALUES (${row.threadId}, ${row.lastActivityAt})
        ON CONFLICT (thread_id)
        DO UPDATE SET last_activity_at = excluded.last_activity_at
      `,
  });

  const touch: ProjectionThreadHeartbeatRepositoryShape["touch"] = (row) =>
    touchRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadHeartbeatRepository.touch:query")),
    );

  return { touch } satisfies ProjectionThreadHeartbeatRepositoryShape;
});

export const ProjectionThreadHeartbeatRepositoryLive = Layer.effect(
  ProjectionThreadHeartbeatRepository,
  makeProjectionThreadHeartbeatRepository,
);
