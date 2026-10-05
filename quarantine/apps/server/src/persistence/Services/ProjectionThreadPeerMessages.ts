/**
 * ProjectionThreadPeerMessageRepository - Projection repository for recorded
 * notify_thread peer-message edges + their durable delivery queue.
 *
 * One row per `thread.peer-message-recorded` event, keyed by the handler's
 * stable `record_id`. The row is the delivery-queue entry (status lifecycle),
 * the observability edge (aggregated onto the sender shell at query time), and
 * the source the command read model rebuilds `notifySendLog` from on restart.
 * This repository owns the write path (insert + status transitions); reads for
 * the dispatcher rail and the shell aggregation live on ProjectionSnapshotQuery
 * (the read lane), mirroring the consult projection split.
 *
 * @module ProjectionThreadPeerMessageRepository
 */
import { IsoDateTime, NonNegativeInt, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadPeerMessage = Schema.Struct({
  recordId: Schema.String,
  senderThreadId: ThreadId,
  targetThreadId: ThreadId,
  targetTitle: Schema.String,
  message: Schema.String,
  framedMessage: Schema.String,
  messagePreview: Schema.String,
  // Monotonic append order (the orchestration event sequence) — the FIFO
  // tiebreaker for same-millisecond records.
  seq: NonNegativeInt,
  createdAt: IsoDateTime,
});
export type ProjectionThreadPeerMessage = typeof ProjectionThreadPeerMessage.Type;

export const PeerMessageStatusUpdate = Schema.Struct({
  recordId: Schema.String,
  updatedAt: IsoDateTime,
});
export type PeerMessageStatusUpdate = typeof PeerMessageStatusUpdate.Type;

/**
 * ProjectionThreadPeerMessageRepositoryShape - Service API for peer-message rows.
 */
export interface ProjectionThreadPeerMessageRepositoryShape {
  /**
   * Insert a recorded peer message at status `pending`. Idempotent by
   * `recordId` (re-projection is a no-op), so the aggregated per-sender->target
   * count and the delivery queue never double-count.
   */
  readonly insert: (
    row: ProjectionThreadPeerMessage,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  /** Flip a pending row to `delivered` (idempotent; only pending rows change). */
  readonly markDelivered: (
    update: PeerMessageStatusUpdate,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  /** Flip a pending row to `expired` (idempotent; only pending rows change). */
  readonly markExpired: (
    update: PeerMessageStatusUpdate,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionThreadPeerMessageRepository - Service tag for peer-message projection.
 */
export class ProjectionThreadPeerMessageRepository extends Context.Service<
  ProjectionThreadPeerMessageRepository,
  ProjectionThreadPeerMessageRepositoryShape
>()("t3/persistence/Services/ProjectionThreadPeerMessages/ProjectionThreadPeerMessageRepository") {}
