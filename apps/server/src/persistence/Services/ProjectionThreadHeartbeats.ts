/**
 * ProjectionThreadHeartbeatRepository - Repository for the per-thread liveness
 * heartbeat.
 *
 * Owns the debounced "last runtime activity at" timestamp the liveness sweep
 * reads to tell a silently-reasoning child apart from a genuinely stalled one.
 * Written only by ProviderRuntimeIngestion (a side channel, not the projector).
 *
 * @module ProjectionThreadHeartbeatRepository
 */
import { IsoDateTime, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadHeartbeat = Schema.Struct({
  threadId: ThreadId,
  lastActivityAt: IsoDateTime,
});
export type ProjectionThreadHeartbeat = typeof ProjectionThreadHeartbeat.Type;

export interface ProjectionThreadHeartbeatRepositoryShape {
  /** Insert or advance a thread's heartbeat to `lastActivityAt`. */
  readonly touch: (
    row: ProjectionThreadHeartbeat,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadHeartbeatRepository extends Context.Service<
  ProjectionThreadHeartbeatRepository,
  ProjectionThreadHeartbeatRepositoryShape
>()("t3/persistence/Services/ProjectionThreadHeartbeats/ProjectionThreadHeartbeatRepository") {}
