import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  PeerMessageStatusUpdate,
  ProjectionThreadPeerMessage,
  ProjectionThreadPeerMessageRepository,
  type ProjectionThreadPeerMessageRepositoryShape,
} from "../Services/ProjectionThreadPeerMessages.ts";

const makeProjectionThreadPeerMessageRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Idempotent by record id: re-projection (bootstrap replay) INSERTs the same
  // row and the ON CONFLICT keeps the projection (and its status lifecycle)
  // stable.
  const insertRow = SqlSchema.void({
    Request: ProjectionThreadPeerMessage,
    execute: (row) =>
      sql`
        INSERT INTO projection_thread_peer_messages (
          record_id,
          sender_thread_id,
          target_thread_id,
          target_title,
          message,
          framed_message,
          message_preview,
          status,
          seq,
          created_at,
          delivered_at
        )
        VALUES (
          ${row.recordId},
          ${row.senderThreadId},
          ${row.targetThreadId},
          ${row.targetTitle},
          ${row.message},
          ${row.framedMessage},
          ${row.messagePreview},
          'pending',
          ${row.seq},
          ${row.createdAt},
          NULL
        )
        ON CONFLICT (record_id) DO NOTHING
      `,
  });

  // Only a pending row transitions: a delivered row never reverts, and an
  // expired row stays expired (the WHERE guards make both mark ops idempotent
  // and order-independent under the crash-window reconciliation leg).
  const markDeliveredRow = SqlSchema.void({
    Request: PeerMessageStatusUpdate,
    execute: (update) =>
      sql`
        UPDATE projection_thread_peer_messages
        SET status = 'delivered', delivered_at = ${update.updatedAt}
        WHERE record_id = ${update.recordId} AND status = 'pending'
      `,
  });

  const markExpiredRow = SqlSchema.void({
    Request: PeerMessageStatusUpdate,
    execute: (update) =>
      sql`
        UPDATE projection_thread_peer_messages
        SET status = 'expired'
        WHERE record_id = ${update.recordId} AND status = 'pending'
      `,
  });

  const insert: ProjectionThreadPeerMessageRepositoryShape["insert"] = (row) =>
    insertRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadPeerMessageRepository.insert:query")),
    );

  const markDelivered: ProjectionThreadPeerMessageRepositoryShape["markDelivered"] = (update) =>
    markDeliveredRow(update).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadPeerMessageRepository.markDelivered:query"),
      ),
    );

  const markExpired: ProjectionThreadPeerMessageRepositoryShape["markExpired"] = (update) =>
    markExpiredRow(update).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadPeerMessageRepository.markExpired:query"),
      ),
    );

  return {
    insert,
    markDelivered,
    markExpired,
  } satisfies ProjectionThreadPeerMessageRepositoryShape;
});

export const ProjectionThreadPeerMessageRepositoryLive = Layer.effect(
  ProjectionThreadPeerMessageRepository,
  makeProjectionThreadPeerMessageRepository,
);
