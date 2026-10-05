/**
 * The Loom projector (plans/upstream-pull9-phase2-substrate/plan.mdx §1 event
 * table, §4): folds Loom events — and four upstream thread events for threads
 * that have a sidecar row — into `loom_thread_workstream`, `loom_goals`,
 * `loom_thread_consults` and `loom_thread_peer_messages`. Called from the top of
 * `ProjectionStore.apply`, so it runs in V2's commit transaction beside
 * upstream's projection writes and the receipt.
 *
 * Replay-safe: `ProjectionMaintenance.rebuild` re-applies the whole log over
 * these tables (it clears only upstream's), so every row effect is a set, a
 * first-write-wins or an idempotent append — never an increment. The goal
 * cascades read other rows and the goal, so they are judged at the event's
 * time and never overwrite a goal written after the event (`updated_at`).
 *
 * @module loom/projection/loomProjection
 */
import {
  isLoomDomainEvent,
  type GoalId,
  type IsoDateTime,
  type LoomDomainEvent,
  type LoomThreadWorkstream,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { emptyWorkstream, readWorkstream, writeWorkstream } from "./LoomStore.ts";

// Shell-level previews, as V1's projection pipeline bounded them.
const PREVIEW_MAX_LENGTH = 140;
// notify_thread's ordered-pair cap window (V1 `NOTIFY_PAIR_WINDOW_MS`; the
// quarantined `@t3tools/shared/notify` returns with Phase 3a's handler).
const NOTIFY_PAIR_WINDOW_MS = 60 * 60 * 1000;

const preview = (text: string) => {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > PREVIEW_MAX_LENGTH
    ? `${normalized.slice(0, PREVIEW_MAX_LENGTH - 1).trimEnd()}\u2026`
    : normalized;
};

/**
 * The record change one Loom event makes to its own row, or `undefined` when it
 * touches no row field. `row` is the current record (null when none exists).
 */
const foldWorkstream = (
  row: LoomThreadWorkstream | null,
  event: LoomDomainEvent,
  at: IsoDateTime,
): LoomThreadWorkstream | undefined => {
  if (event.type === "thread.workstream-created") {
    if (row !== null) return undefined; // replay-safe create
    const { payload } = event;
    return {
      ...emptyWorkstream({
        threadId: event.threadId,
        projectId: payload.projectId,
        parentThreadId: payload.parentThreadId,
        rootThreadId: payload.rootThreadId,
        at,
      }),
      ...payload,
      heldSince: payload.held ? at : null,
      dependenciesSince: payload.blockedBy.length > 0 ? at : null,
    };
  }
  if (row === null) return undefined;
  const next = (patch: Partial<LoomThreadWorkstream>) => ({ ...row, ...patch, updatedAt: at });
  switch (event.type) {
    case "thread.goal-set": {
      const { goalId, anchorTaskId } = event.payload;
      // An absent anchor keeps the current one while the goal is unchanged.
      return next({
        goalId,
        anchorTaskId:
          anchorTaskId !== undefined
            ? anchorTaskId
            : goalId === row.goalId
              ? row.anchorTaskId
              : null,
      });
    }
    case "thread.held-set":
      return next({
        held: event.payload.held,
        heldSince: event.payload.held ? (row.held ? row.heldSince : at) : null,
      });
    case "thread.outcome-set":
      return next({ outcome: event.payload.outcome, outcomeAt: at, outcomeEventId: event.id });
    case "thread.kickoff-recorded":
      return row.kickoffAt === null ? next({ kickoffAt: event.payload.kickoffAt }) : undefined;
    case "thread.attention-raised": {
      const { reason } = event.payload;
      if (row.attention.includes(reason)) return undefined; // the first raise is the episode
      return next({
        attention: [...row.attention, reason],
        attentionEpisodes: { ...row.attentionEpisodes, [reason]: event.id },
      });
    }
    case "thread.attention-cleared": {
      const { reason } = event.payload;
      if (reason === undefined) return next({ attention: [], attentionEpisodes: {} });
      const { [reason]: _, ...attentionEpisodes } = row.attentionEpisodes;
      return next({
        attention: row.attention.filter((entry) => entry !== reason),
        attentionEpisodes,
      });
    }
    case "thread.dependencies-set":
      return next({
        blockedBy: event.payload.blockedBy,
        dependenciesSince: event.payload.blockedBy.length > 0 ? at : null,
      });
    case "thread.kickoff-brief-set":
      return next({ kickoffBriefPath: event.payload.kickoffBriefPath });
    case "thread.report-set":
      return next({ reportPath: event.payload.reportPath });
    case "thread.outcome-recorded":
      return next({ lastOutcome: { ...event.payload, eventId: event.id, at } });
    case "thread.route-taken": {
      const { to, round, kind } = event.payload;
      return next({
        lastRoute: { to, round, kind, eventId: event.id },
        // A loop's round is the source's gateRounds + 1: assigning it is the increment, replay-safe.
        ...(kind === "loop" ? { gateRounds: round } : {}),
        ...(kind === "loop-back" ? { pendingRework: false } : {}),
      });
    }
    case "thread.gate-rework-accepted":
      return next({ pendingRework: true });
    case "thread.peer-message-recorded": {
      const { targetThreadId, createdAt } = event.payload;
      if (
        row.notifySendLog.some(
          (entry) => entry.targetThreadId === targetThreadId && entry.at === createdAt,
        )
      ) {
        return undefined;
      }
      const cutoff = Date.parse(createdAt) - NOTIFY_PAIR_WINDOW_MS;
      return next({
        notifySendLog: [
          ...row.notifySendLog.filter((entry) => Date.parse(entry.at) >= cutoff),
          { targetThreadId, at: createdAt },
        ],
      });
    }
    case "thread.handoff-recorded": {
      const { payload } = event;
      if (
        row.handoffDestinations.some(
          (entry) =>
            entry.goalId === payload.destinationGoalId &&
            entry.threadId === payload.destinationThreadId,
        )
      ) {
        return undefined;
      }
      return next({
        handoffDestinations: [
          ...row.handoffDestinations,
          {
            goalId: payload.destinationGoalId,
            threadId: payload.destinationThreadId,
            drafterThreadId: payload.drafterThreadId ?? payload.threadId,
            createdAt: payload.createdAt,
          },
        ],
      });
    }
    // Edge tables only, or (gate-warning) nothing: Phase 3b surfaces it.
    case "thread.gate-warning":
    case "thread.consult-recorded":
    case "thread.peer-message-delivered":
    case "thread.peer-message-expired":
      return undefined;
  }
};

/** Writes to the edge tables; replay-safe by event / record id. */
const applyEdgeTables = (sql: SqlClient.SqlClient, event: LoomDomainEvent) => {
  switch (event.type) {
    case "thread.consult-recorded": {
      const { payload } = event;
      return sql`INSERT INTO loom_thread_consults ${sql.insert({
        event_id: event.id,
        asker_thread_id: payload.askerThreadId,
        target_thread_id: payload.targetThreadId,
        target_title: payload.targetTitle,
        question_preview: preview(payload.question),
        created_at: payload.createdAt,
      })} ON CONFLICT (event_id) DO NOTHING`;
    }
    case "thread.peer-message-recorded": {
      const { payload } = event;
      // `seq` is commit order (the FIFO tiebreaker for same-millisecond sends).
      return sql`INSERT INTO loom_thread_peer_messages (
          record_id, sender_thread_id, target_thread_id, target_title, message,
          framed_message, message_preview, status, seq, created_at, delivered_at)
        VALUES (${payload.recordId}, ${payload.senderThreadId}, ${payload.targetThreadId},
          ${payload.targetTitle}, ${payload.message}, ${payload.framedMessage},
          ${preview(payload.message)}, 'pending',
          (SELECT COALESCE(MAX(seq), 0) + 1 FROM loom_thread_peer_messages),
          ${payload.createdAt}, NULL)
        ON CONFLICT (record_id) DO NOTHING`;
    }
    // Only a pending row transitions, so both marks are idempotent and order-independent.
    case "thread.peer-message-delivered":
      return sql`UPDATE loom_thread_peer_messages
        SET status = 'delivered', delivered_at = ${event.payload.updatedAt}
        WHERE record_id = ${event.payload.recordId} AND status = 'pending'`;
    case "thread.peer-message-expired":
      return sql`UPDATE loom_thread_peer_messages SET status = 'expired'
        WHERE record_id = ${event.payload.recordId} AND status = 'pending'`;
    default:
      return Effect.void;
  }
};

/** A goal-less root's first `thread.goal-set` creates its row from the V2 thread. */
const rowForGoalSet = (sql: SqlClient.SqlClient, threadId: ThreadId, at: IsoDateTime) =>
  sql<{
    readonly projectId: string;
    readonly parentThreadId: string | null;
    readonly rootThreadId: string | null;
  }>`
    SELECT project_id AS "projectId",
      json_extract(payload_json, '$.lineage.parentThreadId') AS "parentThreadId",
      json_extract(payload_json, '$.lineage.rootThreadId') AS "rootThreadId"
    FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
  `.pipe(
    Effect.map(([thread]) =>
      thread === undefined
        ? null
        : emptyWorkstream({
            threadId,
            projectId: ProjectId.make(thread.projectId),
            parentThreadId:
              thread.parentThreadId === null ? null : ThreadId.make(thread.parentThreadId),
            rootThreadId: ThreadId.make(thread.rootThreadId ?? threadId),
            at,
          }),
    ),
  );

/**
 * No other sidecar row naming the goal was live at `at` (the archive / rename
 * cascades' trigger). Judged at the event's time rather than now, so a rebuild
 * replaying an old rename does not see threads archived or deleted since.
 */
const isSoleLiveThreadOfGoal = (
  sql: SqlClient.SqlClient,
  goalId: GoalId,
  threadId: ThreadId,
  at: IsoDateTime,
) =>
  sql<{ readonly n: number }>`
    SELECT COUNT(*) AS n FROM loom_thread_workstream
    WHERE goal_id = ${goalId} AND thread_id <> ${threadId} AND created_at <= ${at}
      AND (archived_at IS NULL OR archived_at > ${at})
      AND (deleted_at IS NULL OR deleted_at > ${at})
  `.pipe(Effect.map(([row]) => (row?.n ?? 0) === 0));

/**
 * The four mirrored upstream thread events, for threads with a sidecar row,
 * plus the goal cascades they drive. A thread without a row is untouched.
 */
const applyMirroredThreadEvent = (
  sql: SqlClient.SqlClient,
  event: OrchestrationV2DomainEvent,
  at: IsoDateTime,
) =>
  Effect.gen(function* () {
    const row = yield* readWorkstream(sql, event.threadId);
    if (row === null) return;
    switch (event.type) {
      case "thread.archived":
        yield* writeWorkstream(sql, { ...row, archivedAt: at, updatedAt: at });
        // Archiving the last live thread of a goal archives the goal.
        if (
          row.goalId !== null &&
          (yield* isSoleLiveThreadOfGoal(sql, row.goalId, row.threadId, at))
        ) {
          yield* sql`UPDATE loom_goals SET archived_at = ${at}, updated_at = ${at}
            WHERE goal_id = ${row.goalId} AND archived_at IS NULL AND deleted_at IS NULL
              AND updated_at <= ${at}`;
        }
        return;
      case "thread.unarchived":
        yield* writeWorkstream(sql, {
          ...row,
          archivedAt: null,
          unarchivedAt: at,
          unarchivedEventId: event.id,
          updatedAt: at,
        });
        // Resurfacing a thread of an archived goal unarchives the goal.
        if (row.goalId !== null) {
          yield* sql`UPDATE loom_goals SET archived_at = NULL, updated_at = ${at}
            WHERE goal_id = ${row.goalId} AND archived_at IS NOT NULL AND deleted_at IS NULL
              AND updated_at <= ${at}`;
        }
        return;
      case "thread.deleted":
        yield* writeWorkstream(sql, { ...row, deletedAt: at, updatedAt: at });
        return;
      case "thread.metadata-updated": {
        // Runs before upstream's upsert, so the projection still holds the old title.
        const [previous] = yield* sql<{ readonly title: string }>`
          SELECT title FROM orchestration_v2_projection_threads WHERE thread_id = ${event.threadId}`;
        const title = event.payload.title;
        // Renaming the sole live thread of a goal renames the goal.
        if (
          row.goalId !== null &&
          previous !== undefined &&
          previous.title !== title &&
          (yield* isSoleLiveThreadOfGoal(sql, row.goalId, row.threadId, at))
        ) {
          yield* sql`UPDATE loom_goals SET title = ${title}, updated_at = ${at}
            WHERE goal_id = ${row.goalId} AND title <> ${title}
              AND archived_at IS NULL AND deleted_at IS NULL AND updated_at <= ${at}`;
        }
        return;
      }
    }
  });

const MIRRORED_THREAD_EVENTS: ReadonlySet<string> = new Set([
  "thread.archived",
  "thread.unarchived",
  "thread.deleted",
  "thread.metadata-updated",
]);

/**
 * Fold one V2 domain event into Loom's tables. Every upstream event other than
 * the four mirrored ones returns at once.
 */
export const applyLoomProjectionEvent = (
  sql: SqlClient.SqlClient,
  event: OrchestrationV2DomainEvent,
) =>
  Effect.gen(function* () {
    const at = DateTime.formatIso(event.occurredAt);
    if (MIRRORED_THREAD_EVENTS.has(event.type))
      return yield* applyMirroredThreadEvent(sql, event, at);
    if (!isLoomDomainEvent(event)) return;
    yield* applyEdgeTables(sql, event);
    const current = yield* readWorkstream(sql, event.threadId);
    const row =
      current === null && event.type === "thread.goal-set"
        ? yield* rowForGoalSet(sql, event.threadId, at)
        : current;
    const next = foldWorkstream(row, event, at);
    if (next !== undefined) yield* writeWorkstream(sql, next);
  });
