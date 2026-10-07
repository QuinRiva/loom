import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ProjectionThreadConsult,
  ProjectionThreadConsultRepository,
  type ProjectionThreadConsultRepositoryShape,
} from "../Services/ProjectionThreadConsults.ts";

const makeProjectionThreadConsultRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Idempotent by event id: re-projection (bootstrap replay) INSERTs the same
  // row and the ON CONFLICT keeps the projection stable.
  const insertProjectionThreadConsultRow = SqlSchema.void({
    Request: ProjectionThreadConsult,
    execute: (row) =>
      sql`
        INSERT INTO projection_thread_consults (
          event_id,
          asker_thread_id,
          target_thread_id,
          target_title,
          question_preview,
          created_at
        )
        VALUES (
          ${row.eventId},
          ${row.askerThreadId},
          ${row.targetThreadId},
          ${row.targetTitle},
          ${row.questionPreview},
          ${row.createdAt}
        )
        ON CONFLICT (event_id) DO NOTHING
      `,
  });

  const insert: ProjectionThreadConsultRepositoryShape["insert"] = (row) =>
    insertProjectionThreadConsultRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadConsultRepository.insert:query")),
    );

  return { insert } satisfies ProjectionThreadConsultRepositoryShape;
});

export const ProjectionThreadConsultRepositoryLive = Layer.effect(
  ProjectionThreadConsultRepository,
  makeProjectionThreadConsultRepository,
);
