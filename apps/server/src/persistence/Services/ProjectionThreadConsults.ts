/**
 * ProjectionThreadConsultRepository - Projection repository for recorded
 * consult_thread edges.
 *
 * One row per `thread.consult-recorded` event (keyed by event id, so
 * re-projection is idempotent). The asker shell's aggregated `consults` edge
 * summary is derived from these rows at query time; this repository only owns
 * the write path.
 *
 * @module ProjectionThreadConsultRepository
 */
import { IsoDateTime, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadConsult = Schema.Struct({
  eventId: Schema.String,
  askerThreadId: ThreadId,
  targetThreadId: ThreadId,
  targetTitle: Schema.String,
  questionPreview: Schema.String,
  createdAt: IsoDateTime,
});
export type ProjectionThreadConsult = typeof ProjectionThreadConsult.Type;

/**
 * ProjectionThreadConsultRepositoryShape - Service API for consult edge rows.
 */
export interface ProjectionThreadConsultRepositoryShape {
  /**
   * Insert a recorded consult. Idempotent by `eventId` (re-projection is a
   * no-op), so the aggregated per-asker→target count never double-counts.
   */
  readonly insert: (
    consult: ProjectionThreadConsult,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionThreadConsultRepository - Service tag for consult projection.
 */
export class ProjectionThreadConsultRepository extends Context.Service<
  ProjectionThreadConsultRepository,
  ProjectionThreadConsultRepositoryShape
>()("t3/persistence/Services/ProjectionThreadConsults/ProjectionThreadConsultRepository") {}
