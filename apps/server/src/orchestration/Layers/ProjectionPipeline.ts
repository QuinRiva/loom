import {
  ApprovalRequestId,
  type ChatAttachment,
  inferLegacyTitleProvenance,
  IsoDateTime,
  NonNegativeInt,
  NonNegativeNumber,
  type OrchestrationEvent,
  type OrchestrationSessionStatus,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { remapLegacyStatus } from "../projector.loom.ts";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionPendingApprovalRepository } from "../../persistence/Services/ProjectionPendingApprovals.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionStateRepository } from "../../persistence/Services/ProjectionState.ts";
import { ProjectionThreadActivityRepository } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { type ProjectionThreadActivity } from "../../persistence/Services/ProjectionThreadActivities.ts";
import {
  type ProjectionThreadMessage,
  ProjectionThreadMessageRepository,
} from "../../persistence/Services/ProjectionThreadMessages.ts";
import {
  type ProjectionThreadProposedPlan,
  ProjectionThreadProposedPlanRepository,
} from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSessionRepository } from "../../persistence/Services/ProjectionThreadSessions.ts";
import {
  type ProjectionTurn,
  ProjectionTurnRepository,
} from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { ProjectionThreadConsultRepository } from "../../persistence/Services/ProjectionThreadConsults.ts";
import { ProjectionThreadConsultRepositoryLive } from "../../persistence/Layers/ProjectionThreadConsults.ts";
import { ProjectionThreadPeerMessageRepository } from "../../persistence/Services/ProjectionThreadPeerMessages.ts";
import { ProjectionThreadPeerMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadPeerMessages.ts";
import { ProjectionGoalRepository } from "../../persistence/Services/ProjectionGoals.ts";
import { ProjectionGoalRepositoryLive } from "../../persistence/Layers/ProjectionGoals.ts";
import { ProjectionPendingApprovalRepositoryLive } from "../../persistence/Layers/ProjectionPendingApprovals.ts";
import { ProjectionProjectRepositoryLive } from "../../persistence/Layers/ProjectionProjects.ts";
import { ProjectionStateRepositoryLive } from "../../persistence/Layers/ProjectionState.ts";
import { ProjectionThreadActivityRepositoryLive } from "../../persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlanRepositoryLive } from "../../persistence/Layers/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSessionRepositoryLive } from "../../persistence/Layers/ProjectionThreadSessions.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionThreadRepositoryLive } from "../../persistence/Layers/ProjectionThreads.ts";
import { ServerConfig } from "../../config.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";
import {
  attachmentRelativePath,
  parseAttachmentIdFromRelativePath,
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../../attachmentStore.ts";

// consult_thread observability: shell-level question preview length. The full
// question lives on the `thread.consult-recorded` event; only this bounded
// preview is aggregated onto the asker shell.
const CONSULT_QUESTION_PREVIEW_MAX_LENGTH = 140;
const PEER_MESSAGE_PREVIEW_MAX_LENGTH = 140;

const ThreadShellSummaryInput = Schema.Struct({
  threadId: ThreadId,
  latestTurnId: Schema.NullOr(Schema.String),
});

const ThreadShellSummaryQueryResult = Schema.Struct({
  latestUserMessageAt: Schema.NullOr(IsoDateTime),
  pendingApprovalCount: NonNegativeInt,
  pendingUserInputCount: NonNegativeInt,
  actionablePlanCandidates: Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        planId: Schema.String,
        implementedAt: Schema.NullOr(IsoDateTime),
      }),
    ),
  ),
  cumulativeCostUsd: NonNegativeNumber,
  toolUses: Schema.NullOr(NonNegativeInt),
  usedTokens: Schema.NullOr(NonNegativeInt),
  maxTokens: Schema.NullOr(NonNegativeInt),
  diffAdditions: Schema.NullOr(NonNegativeInt),
  diffDeletions: Schema.NullOr(NonNegativeInt),
});

export const ORCHESTRATION_PROJECTOR_NAMES = {
  projects: "projection.projects",
  goals: "projection.goals",
  threads: "projection.threads",
  threadMessages: "projection.thread-messages",
  threadProposedPlans: "projection.thread-proposed-plans",
  threadActivities: "projection.thread-activities",
  threadSessions: "projection.thread-sessions",
  threadTurns: "projection.thread-turns",
  checkpoints: "projection.checkpoints",
  pendingApprovals: "projection.pending-approvals",
} as const;

type ProjectorName =
  (typeof ORCHESTRATION_PROJECTOR_NAMES)[keyof typeof ORCHESTRATION_PROJECTOR_NAMES];

/**
 * Turn state to settle still-running turns with when their session leaves the
 * "running" status, or null while the session is (re)starting or running and
 * turns must stay unsettled.
 */
function settledTurnStateForSessionStatus(
  status: OrchestrationSessionStatus,
): "completed" | "interrupted" | "error" | null {
  switch (status) {
    case "idle":
    case "ready":
      return "completed";
    case "error":
      return "error";
    case "interrupted":
    case "stopped":
      return "interrupted";
    case "starting":
    case "running":
      return null;
  }
}

interface ProjectorDefinition {
  readonly name: ProjectorName;
  readonly apply: (
    event: OrchestrationEvent,
    attachmentSideEffects: AttachmentSideEffects,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

interface AttachmentSideEffects {
  readonly deletedThreadIds: Set<string>;
  readonly prunedThreadRelativePaths: Map<string, Set<string>>;
}

const materializeAttachmentsForProjection = Effect.fn("materializeAttachmentsForProjection")(
  (input: { readonly attachments: ReadonlyArray<ChatAttachment> }) =>
    Effect.succeed(input.attachments.length === 0 ? [] : input.attachments),
);

function extractActivityRequestId(payload: unknown): ApprovalRequestId | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const requestId = (payload as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? ApprovalRequestId.make(requestId) : null;
}

function isStalePendingApprovalFailureDetail(detail: string | null): boolean {
  if (detail === null) {
    return false;
  }
  return (
    detail.includes("stale pending approval request") ||
    detail.includes("unknown pending approval request") ||
    detail.includes("unknown pending permission request")
  );
}

function retainProjectionMessagesAfterRevert(
  messages: ReadonlyArray<ProjectionThreadMessage>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadMessage> {
  const retainedMessageIds = new Set<string>();
  const retainedTurnIds = new Set<string>();
  const keptTurns = turns.filter(
    (turn) =>
      turn.turnId !== null &&
      turn.checkpointTurnCount !== null &&
      turn.checkpointTurnCount <= turnCount,
  );
  for (const turn of keptTurns) {
    if (turn.turnId !== null) {
      retainedTurnIds.add(turn.turnId);
    }
    if (turn.pendingMessageId !== null) {
      retainedMessageIds.add(turn.pendingMessageId);
    }
    if (turn.assistantMessageId !== null) {
      retainedMessageIds.add(turn.assistantMessageId);
    }
  }

  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.messageId);
      continue;
    }
    if (message.turnId !== null && retainedTurnIds.has(message.turnId)) {
      retainedMessageIds.add(message.messageId);
    }
  }

  const retainedUserCount = messages.filter(
    (message) => message.role === "user" && retainedMessageIds.has(message.messageId),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.messageId) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.messageId.localeCompare(right.messageId),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.messageId);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === "assistant" && retainedMessageIds.has(message.messageId),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.messageId) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.messageId.localeCompare(right.messageId),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.messageId);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.messageId));
}

function retainProjectionActivitiesAfterRevert(
  activities: ReadonlyArray<ProjectionThreadActivity>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadActivity> {
  const retainedTurnIds = new Set<string>(
    turns
      .filter(
        (turn) =>
          turn.turnId !== null &&
          turn.checkpointTurnCount !== null &&
          turn.checkpointTurnCount <= turnCount,
      )
      .flatMap((turn) => (turn.turnId === null ? [] : [turn.turnId])),
  );
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

function retainProjectionProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<ProjectionThreadProposedPlan>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadProposedPlan> {
  const retainedTurnIds = new Set<string>(
    turns
      .filter(
        (turn) =>
          turn.turnId !== null &&
          turn.checkpointTurnCount !== null &&
          turn.checkpointTurnCount <= turnCount,
      )
      .flatMap((turn) => (turn.turnId === null ? [] : [turn.turnId])),
  );
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

function collectThreadAttachmentRelativePaths(
  threadId: string,
  messages: ReadonlyArray<ProjectionThreadMessage>,
): Set<string> {
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  if (!threadSegment) {
    return new Set();
  }
  const relativePaths = new Set<string>();
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      if (attachment.type !== "image") {
        continue;
      }
      const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachment.id);
      if (!attachmentThreadSegment || attachmentThreadSegment !== threadSegment) {
        continue;
      }
      relativePaths.add(attachmentRelativePath(attachment));
    }
  }
  return relativePaths;
}

const runAttachmentSideEffects = Effect.fn("runAttachmentSideEffects")(function* (
  sideEffects: AttachmentSideEffects,
) {
  const serverConfig = yield* Effect.service(ServerConfig);
  const fileSystem = yield* Effect.service(FileSystem.FileSystem);
  const path = yield* Effect.service(Path.Path);

  const attachmentsRootDir = serverConfig.attachmentsDir;
  const readAttachmentRootEntries = fileSystem
    .readDirectory(attachmentsRootDir, { recursive: false })
    .pipe(Effect.orElseSucceed(() => [] as Array<string>));

  const removeDeletedThreadAttachmentEntry = Effect.fn("removeDeletedThreadAttachmentEntry")(
    function* (threadSegment: string, entry: string) {
      const normalizedEntry = entry.replace(/^[/\\]+/, "").replace(/\\/g, "/");
      if (normalizedEntry.length === 0 || normalizedEntry.includes("/")) {
        return;
      }
      const attachmentId = parseAttachmentIdFromRelativePath(normalizedEntry);
      if (!attachmentId) {
        return;
      }
      const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
      if (!attachmentThreadSegment || attachmentThreadSegment !== threadSegment) {
        return;
      }
      yield* fileSystem.remove(path.join(attachmentsRootDir, normalizedEntry), {
        force: true,
      });
    },
  );

  const deleteThreadAttachments = Effect.fn("deleteThreadAttachments")(function* (
    threadId: string,
  ) {
    const threadSegment = toSafeThreadAttachmentSegment(threadId);
    if (!threadSegment) {
      yield* Effect.logWarning("skipping attachment cleanup for unsafe thread id", {
        threadId,
      });
      return;
    }

    const entries = yield* readAttachmentRootEntries;
    yield* Effect.forEach(
      entries,
      (entry) => removeDeletedThreadAttachmentEntry(threadSegment, entry),
      {
        concurrency: 1,
      },
    );
  });

  const pruneThreadAttachmentEntry = Effect.fn("pruneThreadAttachmentEntry")(function* (
    threadSegment: string,
    keptThreadRelativePaths: Set<string>,
    entry: string,
  ) {
    const relativePath = entry.replace(/^[/\\]+/, "").replace(/\\/g, "/");
    if (relativePath.length === 0 || relativePath.includes("/")) {
      return;
    }
    const attachmentId = parseAttachmentIdFromRelativePath(relativePath);
    if (!attachmentId) {
      return;
    }
    const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
    if (!attachmentThreadSegment || attachmentThreadSegment !== threadSegment) {
      return;
    }

    const absolutePath = path.join(attachmentsRootDir, relativePath);
    const fileInfo = yield* fileSystem.stat(absolutePath).pipe(Effect.orElseSucceed(() => null));
    if (!fileInfo || fileInfo.type !== "File") {
      return;
    }

    if (!keptThreadRelativePaths.has(relativePath)) {
      yield* fileSystem.remove(absolutePath, { force: true });
    }
  });

  const pruneThreadAttachments = Effect.fn("pruneThreadAttachments")(function* (
    threadId: string,
    keptThreadRelativePaths: Set<string>,
  ) {
    if (sideEffects.deletedThreadIds.has(threadId)) {
      return;
    }

    const threadSegment = toSafeThreadAttachmentSegment(threadId);
    if (!threadSegment) {
      yield* Effect.logWarning("skipping attachment prune for unsafe thread id", { threadId });
      return;
    }

    const entries = yield* readAttachmentRootEntries;
    yield* Effect.forEach(
      entries,
      (entry) => pruneThreadAttachmentEntry(threadSegment, keptThreadRelativePaths, entry),
      { concurrency: 1 },
    );
  });

  yield* Effect.forEach(sideEffects.deletedThreadIds, deleteThreadAttachments, {
    concurrency: 1,
  });

  yield* Effect.forEach(
    sideEffects.prunedThreadRelativePaths.entries(),
    ([threadId, keptThreadRelativePaths]) =>
      pruneThreadAttachments(threadId, keptThreadRelativePaths),
    { concurrency: 1 },
  );
});

const makeOrchestrationProjectionPipeline = Effect.fn("makeOrchestrationProjectionPipeline")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const eventStore = yield* OrchestrationEventStore;
    const projectionStateRepository = yield* ProjectionStateRepository;
    const projectionProjectRepository = yield* ProjectionProjectRepository;
    const projectionGoalRepository = yield* ProjectionGoalRepository;
    const projectionThreadRepository = yield* ProjectionThreadRepository;
    const projectionThreadConsultRepository = yield* ProjectionThreadConsultRepository;
    const projectionThreadPeerMessageRepository = yield* ProjectionThreadPeerMessageRepository;
    const projectionThreadMessageRepository = yield* ProjectionThreadMessageRepository;
    const projectionThreadProposedPlanRepository = yield* ProjectionThreadProposedPlanRepository;
    const projectionThreadActivityRepository = yield* ProjectionThreadActivityRepository;
    const projectionThreadSessionRepository = yield* ProjectionThreadSessionRepository;
    const projectionTurnRepository = yield* ProjectionTurnRepository;
    const projectionPendingApprovalRepository = yield* ProjectionPendingApprovalRepository;

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;

    // This stays a full history recompute (so replay and thread.reverted remain
    // exact), but SQLite now returns only the shell scalars instead of decoding
    // five unbounded row sets on the serialised command queue.
    const readThreadShellSummary = SqlSchema.findOne({
      Request: ThreadShellSummaryInput,
      Result: ThreadShellSummaryQueryResult,
      execute: ({ threadId, latestTurnId }) => sql`
        WITH
          activity_totals AS (
            SELECT
              COALESCE(
                SUM(
                  CASE
                    WHEN kind = 'context-window.updated'
                      AND json_type(payload_json, '$.costUsd') IN ('integer', 'real')
                      AND json_extract(payload_json, '$.costUsd') > 0
                      AND json_extract(payload_json, '$.costUsd') <= 1.7976931348623157e308
                    THEN json_extract(payload_json, '$.costUsd')
                    ELSE 0
                  END
                ),
                0
              ) AS cumulative_cost_usd,
              NULLIF(
                SUM(kind IN ('tool.started', 'tool.updated', 'tool.completed')),
                0
              ) AS tool_uses
            FROM projection_thread_activities AS activities
              INDEXED BY idx_projection_thread_activities_thread_sequence_created_id
            WHERE activities.thread_id = ${threadId}
          ),
          pending_user_inputs AS (
            SELECT COUNT(*) AS pending_count
            FROM (
              SELECT json_extract(payload_json, '$.requestId') AS request_id
              FROM projection_thread_activities
                INDEXED BY idx_projection_thread_activities_thread_kind_sequence_created_id
              WHERE thread_id = ${threadId}
                AND kind IN ('user-input.requested', 'user-input.resolved')
                AND json_type(payload_json, '$.requestId') = 'text'
                AND length(json_extract(payload_json, '$.requestId')) > 0
              GROUP BY request_id
              HAVING MAX(kind = 'user-input.requested') = 1
                AND MAX(kind = 'user-input.resolved') = 0
            )
          ),
          context_snapshot AS (
            SELECT MAX(used_tokens) AS used_tokens, MAX(max_tokens) AS max_tokens
            FROM (
              SELECT
                ROUND(json_extract(payload_json, '$.usedTokens')) AS used_tokens,
                CASE
                  WHEN json_type(payload_json, '$.maxTokens') IN ('integer', 'real')
                    AND json_extract(payload_json, '$.maxTokens') >= 0
                    AND json_extract(payload_json, '$.maxTokens') <= 1.7976931348623157e308
                  THEN ROUND(json_extract(payload_json, '$.maxTokens'))
                  ELSE NULL
                END AS max_tokens
              FROM projection_thread_activities
                INDEXED BY idx_projection_thread_activities_thread_kind_sequence_created_id
              WHERE thread_id = ${threadId}
                AND kind = 'context-window.updated'
                AND json_type(payload_json, '$.usedTokens') IN ('integer', 'real')
                AND json_extract(payload_json, '$.usedTokens') >= 0
                AND json_extract(payload_json, '$.usedTokens') <= 1.7976931348623157e308
              ORDER BY sequence DESC, created_at DESC, activity_id DESC
              LIMIT 1
            )
          ),
          checkpoint_totals AS (
            SELECT
              COUNT(DISTINCT turns.row_id) AS checkpoint_count,
              COALESCE(SUM(json_extract(files.value, '$.additions')), 0) AS additions,
              COALESCE(SUM(json_extract(files.value, '$.deletions')), 0) AS deletions
            FROM projection_turns AS turns
            LEFT JOIN json_each(turns.checkpoint_files_json) AS files
            WHERE turns.thread_id = ${threadId}
              AND turns.checkpoint_turn_count IS NOT NULL
          )
        SELECT
          (
            SELECT MAX(created_at)
            FROM projection_thread_messages
            WHERE thread_id = ${threadId} AND role = 'user'
          ) AS "latestUserMessageAt",
          (
            SELECT COUNT(*)
            FROM projection_pending_approvals
            WHERE thread_id = ${threadId} AND status = 'pending'
          ) AS "pendingApprovalCount",
          pending_user_inputs.pending_count AS "pendingUserInputCount",
          CASE
            WHEN ${latestTurnId} IS NOT NULL AND EXISTS (
              SELECT 1
              FROM projection_thread_proposed_plans
              WHERE thread_id = ${threadId} AND turn_id = ${latestTurnId}
            )
            THEN (
              SELECT json_group_array(
                json_object('planId', plan_id, 'implementedAt', implemented_at)
              )
              FROM projection_thread_proposed_plans
              WHERE thread_id = ${threadId}
                AND turn_id = ${latestTurnId}
                AND updated_at = (
                  SELECT MAX(updated_at)
                  FROM projection_thread_proposed_plans
                  WHERE thread_id = ${threadId} AND turn_id = ${latestTurnId}
                )
            )
            ELSE (
              SELECT json_group_array(
                json_object('planId', plan_id, 'implementedAt', implemented_at)
              )
              FROM projection_thread_proposed_plans
              WHERE thread_id = ${threadId}
                AND updated_at = (
                  SELECT MAX(updated_at)
                  FROM projection_thread_proposed_plans
                  WHERE thread_id = ${threadId}
                )
            )
          END AS "actionablePlanCandidates",
          activity_totals.cumulative_cost_usd AS "cumulativeCostUsd",
          activity_totals.tool_uses AS "toolUses",
          context_snapshot.used_tokens AS "usedTokens",
          context_snapshot.max_tokens AS "maxTokens",
          CASE
            WHEN checkpoint_totals.checkpoint_count > 0 THEN checkpoint_totals.additions
            ELSE NULL
          END AS "diffAdditions",
          CASE
            WHEN checkpoint_totals.checkpoint_count > 0 THEN checkpoint_totals.deletions
            ELSE NULL
          END AS "diffDeletions"
        FROM activity_totals
        CROSS JOIN pending_user_inputs
        CROSS JOIN context_snapshot
        CROSS JOIN checkpoint_totals
      `,
    });

    const applyProjectsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyProjectsProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "project.created":
          yield* projectionProjectRepository.upsert({
            projectId: event.payload.projectId,
            title: event.payload.title,
            workspaceRoot: event.payload.workspaceRoot,
            defaultModelSelection: event.payload.defaultModelSelection,
            defaultStartFromOrigin: event.payload.defaultStartFromOrigin,
            defaultThreadEnvMode: null,
            faviconPath: event.payload.faviconPath ?? null,
            scripts: event.payload.scripts,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
            deletedAt: null,
          });
          return;

        case "project.meta-updated": {
          const existingRow = yield* projectionProjectRepository.getById({
            projectId: event.payload.projectId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionProjectRepository.upsert({
            ...existingRow.value,
            ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
            ...(event.payload.workspaceRoot !== undefined
              ? { workspaceRoot: event.payload.workspaceRoot }
              : {}),
            ...(event.payload.defaultModelSelection !== undefined
              ? { defaultModelSelection: event.payload.defaultModelSelection }
              : {}),
            ...(event.payload.defaultStartFromOrigin !== undefined
              ? { defaultStartFromOrigin: event.payload.defaultStartFromOrigin }
              : {}),
            ...(event.payload.defaultThreadEnvMode !== undefined
              ? { defaultThreadEnvMode: event.payload.defaultThreadEnvMode }
              : {}),
            ...(event.payload.faviconPath !== undefined
              ? { faviconPath: event.payload.faviconPath }
              : {}),
            ...(event.payload.scripts !== undefined ? { scripts: event.payload.scripts } : {}),
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "project.deleted": {
          const existingRow = yield* projectionProjectRepository.getById({
            projectId: event.payload.projectId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionProjectRepository.upsert({
            ...existingRow.value,
            deletedAt: event.payload.deletedAt,
            updatedAt: event.payload.deletedAt,
          });
          return;
        }

        default:
          return;
      }
    });

    const applyGoalsProjection: ProjectorDefinition["apply"] = Effect.fn("applyGoalsProjection")(
      function* (event, _attachmentSideEffects) {
        switch (event.type) {
          case "goal.created":
            yield* projectionGoalRepository.upsertGoal({
              goalId: event.payload.goalId,
              projectId: event.payload.projectId,
              slug: event.payload.slug,
              title: event.payload.title,
              // loom: §4 title provenance (defensive fallback — the decider always
              // emits it on goal.created).
              titleProvenance: event.payload.titleProvenance ?? "curated",
              description: event.payload.description,
              createdAt: event.payload.createdAt,
              updatedAt: event.payload.updatedAt,
              archivedAt: null,
              deletedAt: null,
            });
            return;

          case "goal.meta-updated": {
            const existing = yield* projectionGoalRepository.getGoalById({
              goalId: event.payload.goalId,
            });
            if (Option.isNone(existing)) return;
            yield* projectionGoalRepository.upsertGoal({
              ...existing.value,
              ...(event.payload.slug !== undefined ? { slug: event.payload.slug } : {}),
              ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
              ...(event.payload.titleProvenance !== undefined
                ? { titleProvenance: event.payload.titleProvenance }
                : {}),
              ...(event.payload.description !== undefined
                ? { description: event.payload.description }
                : {}),
              updatedAt: event.payload.updatedAt,
            });
            return;
          }

          case "goal.archived": {
            const existing = yield* projectionGoalRepository.getGoalById({
              goalId: event.payload.goalId,
            });
            if (Option.isNone(existing)) return;
            yield* projectionGoalRepository.upsertGoal({
              ...existing.value,
              archivedAt: event.payload.archivedAt,
              updatedAt: event.payload.updatedAt,
            });
            return;
          }

          case "goal.unarchived": {
            const existing = yield* projectionGoalRepository.getGoalById({
              goalId: event.payload.goalId,
            });
            if (Option.isNone(existing)) return;
            yield* projectionGoalRepository.upsertGoal({
              ...existing.value,
              archivedAt: null,
              updatedAt: event.payload.updatedAt,
            });
            return;
          }

          case "goal.deleted": {
            const existing = yield* projectionGoalRepository.getGoalById({
              goalId: event.payload.goalId,
            });
            if (Option.isNone(existing)) return;
            yield* projectionGoalRepository.upsertGoal({
              ...existing.value,
              deletedAt: event.payload.deletedAt,
              updatedAt: event.payload.deletedAt,
            });
            return;
          }

          case "goal.task-created":
            yield* projectionGoalRepository.upsertTask({
              taskId: event.payload.taskId,
              goalId: event.payload.goalId,
              parentTaskId: event.payload.parentTaskId,
              position: event.payload.position,
              text: event.payload.text,
              done: 0,
              createdAt: event.payload.createdAt,
              updatedAt: event.payload.updatedAt,
              deletedAt: null,
            });
            return;

          case "goal.task-updated": {
            const tasks = yield* projectionGoalRepository.listTasksByGoalId({
              goalId: event.payload.goalId,
            });
            const existing = tasks.find((task) => task.taskId === event.payload.taskId);
            if (existing === undefined) return;
            yield* projectionGoalRepository.upsertTask({
              ...existing,
              ...(event.payload.text !== undefined ? { text: event.payload.text } : {}),
              ...(event.payload.done !== undefined ? { done: event.payload.done ? 1 : 0 } : {}),
              ...(event.payload.position !== undefined ? { position: event.payload.position } : {}),
              updatedAt: event.payload.updatedAt,
            });
            return;
          }

          // Wholesale replace: upsert every submitted task, then tombstone the
          // live tasks the submission dropped.
          case "goal.tasks-rewritten": {
            const submitted = new Set(event.payload.tasks.map((task) => task.taskId));
            const existing = yield* projectionGoalRepository.listTasksByGoalId({
              goalId: event.payload.goalId,
            });
            for (const task of event.payload.tasks) {
              yield* projectionGoalRepository.upsertTask({
                taskId: task.taskId,
                goalId: event.payload.goalId,
                parentTaskId: task.parentTaskId,
                position: task.position,
                text: task.text,
                done: task.done ? 1 : 0,
                createdAt: task.createdAt,
                updatedAt: event.payload.rewrittenAt,
                deletedAt: null,
              });
            }
            for (const task of existing) {
              if (task.deletedAt === null && !submitted.has(task.taskId)) {
                yield* projectionGoalRepository.upsertTask({
                  ...task,
                  deletedAt: event.payload.rewrittenAt,
                  updatedAt: event.payload.rewrittenAt,
                });
              }
            }
            return;
          }

          // Replay only (no producer since the rewrite command replaced it).
          case "goal.task-deleted": {
            const tasks = yield* projectionGoalRepository.listTasksByGoalId({
              goalId: event.payload.goalId,
            });
            const childIds = new Map<string, string[]>();
            for (const task of tasks) {
              const key = task.parentTaskId ?? "";
              (childIds.get(key) ?? childIds.set(key, []).get(key)!).push(task.taskId);
            }
            const removed = new Set<string>();
            const visit = (id: string) => {
              if (removed.has(id)) return;
              removed.add(id);
              for (const childId of childIds.get(id) ?? []) visit(childId);
            };
            visit(event.payload.taskId);
            for (const task of tasks) {
              if (removed.has(task.taskId)) {
                yield* projectionGoalRepository.upsertTask({
                  ...task,
                  deletedAt: event.payload.deletedAt,
                  updatedAt: event.payload.deletedAt,
                });
              }
            }
            return;
          }

          default:
            return;
        }
      },
    );

    const refreshThreadShellSummary = Effect.fn("refreshThreadShellSummary")(function* (
      threadId: ThreadId,
    ) {
      const existingRow = yield* projectionThreadRepository.getById({
        threadId,
      });
      if (Option.isNone(existingRow)) {
        return;
      }

      const { actionablePlanCandidates, ...summary } = yield* readThreadShellSummary({
        threadId,
        latestTurnId: existingRow.value.latestTurnId,
      }).pipe(Effect.mapError(toPersistenceSqlError("refreshThreadShellSummary:aggregateQuery")));
      const latestPlan = actionablePlanCandidates
        .toSorted((left, right) => left.planId.localeCompare(right.planId))
        .at(-1);

      yield* projectionThreadRepository.upsert({
        ...existingRow.value,
        ...summary,
        hasActionableProposedPlan: latestPlan?.implementedAt === null ? 1 : 0,
      });
    });

    const applyThreadsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadsProjection",
    )(function* (event, attachmentSideEffects) {
      switch (event.type) {
        case "thread.created":
          yield* projectionThreadRepository.upsert({
            threadId: event.payload.threadId,
            projectId: event.payload.projectId,
            goalId: event.payload.goalId ?? null,
            parentThreadId: event.payload.parentThreadId ?? null,
            role: event.payload.role ?? null,
            purpose: event.payload.purpose ?? null,
            brief: event.payload.brief ?? null,
            planLane: event.payload.planLane ?? "planned",
            attention: event.payload.attention ?? [],
            blockedBy: event.payload.blockedBy ?? [],
            spawnGeneration: event.payload.spawnGeneration ?? null,
            forkFromThreadId: event.payload.forkFromThreadId ?? null,
            continuesThreadId: event.payload.continuesThreadId ?? null,
            // Post-completion engagement (plan §8 item 3): stamped at fan-in/cancel.
            finalCommitSha: null,
            reportPath: null,
            // loom: scaffold-first graph authoring. graphKey is seeded from the
            // created payload; a scaffold node is born unbriefed.
            graphKey: event.payload.graphKey ?? null,
            kickoffBriefPath: event.payload.kickoffBriefPath ?? null,
            // Scaffold plan §3: the lane-transition clock starts at creation (the
            // node's initial lane assignment); every later plan-lane-set advances
            // it, so the brief-needed episode dates from the newest transition.
            planLaneSince: event.payload.createdAt,
            // Scaffold plan §3: the dependency-set clock is null until the first
            // `thread.dependencies-set` (the initial blockedBy is carried by
            // thread.created; a bare creation is not a dependency-change episode).
            dependenciesSince: null,
            // Scaffold plan §3: the fan-in-settlement clock is null until the
            // first `thread.fanin-set` (a fresh node has not settled a branch).
            faninSince: null,
            routes: event.payload.routes ?? [],
            isolation: event.payload.isolation ?? "shared",
            fanInState: "none",
            gateRounds: 0,
            pendingRework: 0,
            lastOutcome: null,
            title: event.payload.title,
            // loom: §4 replay-safe: a historical thread.created lacking provenance
            // infers it from the title (identical to migration 057 + the
            // in-memory projector), so a durable rebuild agrees with the backfill.
            titleProvenance:
              event.payload.titleProvenance ?? inferLegacyTitleProvenance(event.payload.title),
            modelSelection: event.payload.modelSelection,
            runtimeMode: event.payload.runtimeMode,
            interactionMode: event.payload.interactionMode,
            branch: event.payload.branch,
            worktreePath: event.payload.worktreePath,
            latestTurnId: null,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            pinnedAt: null,
            pinOrderKey: null,
            titleRegenerationRequestId: null,
            titleRegenerationStartedAt: null,
            latestUserMessageAt: null,
            pendingApprovalCount: 0,
            pendingUserInputCount: 0,
            hasActionableProposedPlan: 0,
            cumulativeCostUsd: 0,
            toolUses: null,
            usedTokens: null,
            maxTokens: null,
            diffAdditions: null,
            diffDeletions: null,
            // `/handoff` fork-drafter (plan D5): every thread starts with no
            // recorded handoffs; the drafter's `thread.handoff-recorded` events
            // append to it.
            handoffDestinations: [],
            deletedAt: null,
          });
          return;

        case "thread.archived": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            archivedAt: event.payload.archivedAt,
            titleRegenerationRequestId: null,
            titleRegenerationStartedAt: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.unarchived": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            archivedAt: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.settled": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            settledOverride: "settled",
            settledAt: event.payload.settledAt,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.unsettled": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            settledOverride: event.payload.reason === "user" ? "active" : null,
            settledAt: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.snoozed": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            snoozedUntil: event.payload.snoozedUntil,
            snoozedAt: event.payload.snoozedAt,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.unsnoozed": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            snoozedUntil: null,
            snoozedAt: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.pinned": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            pinnedAt: event.payload.pinnedAt,
            ...(event.payload.pinOrderKey !== undefined
              ? { pinOrderKey: event.payload.pinOrderKey }
              : {}),
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.unpinned": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            pinnedAt: null,
            pinOrderKey: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.pin-reordered": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            pinOrderKey: event.payload.orderKey,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.meta-updated": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
            ...(event.payload.titleProvenance !== undefined
              ? { titleProvenance: event.payload.titleProvenance }
              : {}),
            ...(event.payload.titleRegeneration !== undefined
              ? {
                  titleRegenerationRequestId: event.payload.titleRegeneration?.requestId ?? null,
                  titleRegenerationStartedAt: event.payload.titleRegeneration?.startedAt ?? null,
                }
              : {}),
            ...(event.payload.modelSelection !== undefined
              ? { modelSelection: event.payload.modelSelection }
              : {}),
            ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
            ...(event.payload.worktreePath !== undefined
              ? { worktreePath: event.payload.worktreePath }
              : {}),
            ...(event.payload.finalCommitSha !== undefined
              ? { finalCommitSha: event.payload.finalCommitSha }
              : {}),
            ...(event.payload.goalId !== undefined ? { goalId: event.payload.goalId } : {}),
            ...(event.payload.role !== undefined ? { role: event.payload.role } : {}),
            ...(event.payload.purpose !== undefined ? { purpose: event.payload.purpose } : {}),
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.runtime-mode-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            runtimeMode: event.payload.runtimeMode,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.interaction-mode-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            interactionMode: event.payload.interactionMode,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.plan-lane-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            planLane: event.payload.planLane,
            // Scaffold plan §3: stamp the transition-derived episode clock. Only
            // real lane transitions bump it (activity/receipt appends do not),
            // so it is the stable source the brief-needed rung ladder and the
            // derived parent attention read instead of the re-arm-prone
            // `updatedAt`.
            planLaneSince: event.payload.updatedAt,
            // Re-engagement epoch: a terminal→ready/planned reopen carries a
            // fresh spawnGeneration so the re-run's completion joins a new
            // generation (and fires a new parent wake) instead of being deduped
            // by the first completion's receipt. Mirrors the in-memory projector.
            ...(event.payload.spawnGeneration !== undefined
              ? { spawnGeneration: event.payload.spawnGeneration }
              : {}),
            // Worktree isolation (design §3 step 5): fan-in settlement only
            // applies while `done`; leaving `done` (a gate reopen, or an
            // orchestrator re-opening a `conflicted` child to resolve+resubmit)
            // clears it so the resubmit's `done` re-arms the fan-in sweep.
            ...(event.payload.planLane !== "done" && event.payload.planLane !== "cancelled"
              ? { fanInState: "none" as const }
              : {}),
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.attention-raised": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          const attention = existingRow.value.attention.includes(event.payload.reason)
            ? existingRow.value.attention
            : [...existingRow.value.attention, event.payload.reason];
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            attention,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.attention-cleared": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          // Omitted reason clears all stored attention; a present reason clears
          // just that flag.
          const attention =
            event.payload.reason === undefined
              ? []
              : existingRow.value.attention.filter((reason) => reason !== event.payload.reason);
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            attention,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        // Migration-only (design §9): a historical status-set replayed into the
        // SQL projection. Best-effort remap with no sibling lookup — a non-empty
        // `blockedBy` is treated as board-blocked (deps unmet); an empty one as a
        // human-pause. The migration handles the already-projected rows.
        case "thread.status-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          const remapped = remapLegacyStatus({
            planLane: existingRow.value.planLane,
            attention: existingRow.value.attention,
            status: event.payload.status,
            depsSatisfied: existingRow.value.blockedBy.length === 0,
          });
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            planLane: remapped.planLane,
            attention: remapped.attention,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.dependencies-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            blockedBy: event.payload.blockedBy,
            // Scaffold plan §3: stamp the dependency-change episode clock. A
            // set_dependencies that removes/replaces a dep can RE-ENTER the
            // brief-needed state; this stable, transition-derived timestamp
            // advances the episode so a fresh rung ladder starts from rung 0.
            // Only real dependency-set events bump it (activity/receipt appends
            // do not), so it is immune to the `updatedAt` re-arm loop.
            dependenciesSince: event.payload.updatedAt,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.report-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            reportPath: event.payload.reportPath,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        // loom: scaffold-first graph authoring — attach the on-disk kickoff-brief
        // pointer. Pre-launch overwrites are ordinary re-emits (last write wins).
        case "thread.kickoff-brief-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            kickoffBriefPath: event.payload.kickoffBriefPath,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        // Review gates (design §3.2): record the submitted outcome + routing
        // verdict; any recorded outcome closes an open rework round.
        case "thread.outcome-recorded": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            lastOutcome: {
              outcome: event.payload.outcome,
              decision: event.payload.decision,
              round: event.payload.round,
              ...(event.payload.contested !== undefined
                ? { contested: event.payload.contested }
                : {}),
              ...(event.payload.counts !== undefined ? { counts: event.payload.counts } : {}),
              recordedByEventId: event.eventId,
              at: event.payload.updatedAt,
            },
            pendingRework: 0,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        // Review gates (design §4.3/§4.4): a loop-EDGE traversal (the source
        // carries a loop route naming `to`) opens a rework round on the target
        // and advances the source's round counter; a re-verify traversal
        // advances neither. Mirrors the in-memory projector.
        case "thread.route-taken": {
          const fromRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(fromRow)) {
            return;
          }
          const isLoopTraversal = fromRow.value.routes.some(
            (route) => route.kind === "loop" && route.to === event.payload.to,
          );
          if (!isLoopTraversal) {
            return;
          }
          const toRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.to,
          });
          if (Option.isSome(toRow)) {
            yield* projectionThreadRepository.upsert({
              ...toRow.value,
              pendingRework: 1,
              updatedAt: event.payload.updatedAt,
            });
          }
          yield* projectionThreadRepository.upsert({
            ...fromRow.value,
            gateRounds: event.payload.round,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        // `/handoff` fork-drafter (plan D5): each recorded handoff durably appends
        // its destination. Read-modify-write off the current row; a missing
        // thread is a no-op (mirrors the in-memory projector).
        case "thread.handoff-recorded": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            handoffDestinations: [
              ...existingRow.value.handoffDestinations,
              {
                goalId: event.payload.destinationGoalId,
                threadId: event.payload.destinationThreadId,
              },
            ],
            updatedAt: event.payload.createdAt,
          });
          return;
        }

        // Worktree isolation (design §3): an isolated child's fan-in settlement.
        case "thread.fanin-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            fanInState: event.payload.fanInState,
            // Scaffold plan §3: stamp the fan-in-settlement episode clock. When an
            // isolated dep's fan-in reaches `completed` (or that of an isolated
            // coder behind an attached reviewer), THIS is the transition that
            // makes a waiting unbriefed dependent truly eligible — later than the
            // dep's `done`. Only real fanin-set events bump it (activity/receipt
            // appends do not), keeping it immune to the `updatedAt` re-arm loop.
            faninSince: event.payload.updatedAt,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.deleted": {
          attachmentSideEffects.deletedThreadIds.add(event.payload.threadId);
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            deletedAt: event.payload.deletedAt,
            updatedAt: event.payload.deletedAt,
          });
          return;
        }

        // NOTE: `thread.message-reasoning` is deliberately NOT in this group.
        // refreshThreadShellSummary recomputes counts/latest-user-message that a
        // reasoning event cannot change; under v2 reasoning fires once per
        // segment, but even so it has no business triggering the full shell
        // re-read. Its row write is handled by applyThreadMessagesProjection.
        case "thread.message-sent":
        case "thread.proposed-plan-upserted":
        case "thread.activity-appended":
        case "thread.approval-response-requested":
        case "thread.user-input-response-requested": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            updatedAt: event.occurredAt,
          });
          yield* refreshThreadShellSummary(event.payload.threadId);
          return;
        }

        case "thread.session-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            // Only update latestTurnId when activeTurnId is non-null (session running).
            // When the session goes idle, preserve the last-known turn so the fan-in
            // predicate and other consumers can still see the completed turn (§B2).
            latestTurnId: event.payload.session.activeTurnId ?? existingRow.value.latestTurnId,
            updatedAt: event.occurredAt,
          });
          yield* refreshThreadShellSummary(event.payload.threadId);
          return;
        }

        case "thread.turn-diff-completed": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            latestTurnId: event.payload.turnId,
            updatedAt: event.occurredAt,
          });
          // Also refolds the thread's lines-of-diff totals: the turns projector
          // (which runs before this one) has already written the new checkpoint's
          // per-file summary, so the recompute reflects it on the card metric.
          yield* refreshThreadShellSummary(event.payload.threadId);
          return;
        }

        case "thread.reverted": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }

          const retainedTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          let latestTurnId: ProjectionTurn["turnId"] = null;
          let latestCheckpointTurnCount = -1;
          for (let index = 0; index < retainedTurns.length; index += 1) {
            const turn = retainedTurns[index];
            if (
              !turn ||
              turn.turnId === null ||
              turn.checkpointTurnCount === null ||
              turn.checkpointTurnCount > event.payload.turnCount
            ) {
              continue;
            }
            if (turn.checkpointTurnCount > latestCheckpointTurnCount) {
              latestCheckpointTurnCount = turn.checkpointTurnCount;
              latestTurnId = turn.turnId;
            }
          }

          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            latestTurnId,
            updatedAt: event.occurredAt,
          });
          yield* refreshThreadShellSummary(event.payload.threadId);
          return;
        }

        // consult_thread observability: record the consult edge on the asker
        // thread. Idempotent by event id so replay never double-counts. The
        // shell aggregates count / latest preview per asker→target at query
        // time; the full question + answer stay on the event.
        case "thread.consult-recorded": {
          const question = event.payload.question.replace(/\s+/g, " ").trim();
          yield* projectionThreadConsultRepository.insert({
            eventId: event.eventId,
            askerThreadId: event.payload.askerThreadId,
            targetThreadId: event.payload.targetThreadId,
            targetTitle: event.payload.targetTitle,
            questionPreview:
              question.length > CONSULT_QUESTION_PREVIEW_MAX_LENGTH
                ? `${question.slice(0, CONSULT_QUESTION_PREVIEW_MAX_LENGTH - 1).trimEnd()}\u2026`
                : question,
            createdAt: event.payload.createdAt,
          });
          yield* refreshThreadShellSummary(event.payload.askerThreadId);
          return;
        }

        // notify_thread (cross-thread push): record the peer-message edge + queue
        // row on the SENDER thread. Idempotent by record id so replay never
        // double-counts. The shell aggregates count / pendingCount / latest
        // preview per sender->target at query time; the full raw + framed text
        // stay on the event.
        case "thread.peer-message-recorded": {
          const message = event.payload.message.replace(/\s+/g, " ").trim();
          yield* projectionThreadPeerMessageRepository.insert({
            recordId: event.payload.recordId,
            senderThreadId: event.payload.senderThreadId,
            targetThreadId: event.payload.targetThreadId,
            targetTitle: event.payload.targetTitle,
            message: event.payload.message,
            framedMessage: event.payload.framedMessage,
            messagePreview:
              message.length > PEER_MESSAGE_PREVIEW_MAX_LENGTH
                ? `${message.slice(0, PEER_MESSAGE_PREVIEW_MAX_LENGTH - 1).trimEnd()}\u2026`
                : message,
            seq: event.sequence,
            createdAt: event.payload.createdAt,
          });
          yield* refreshThreadShellSummary(event.payload.senderThreadId);
          return;
        }

        // notify_thread delivery lifecycle: flip the queue row's status. Both are
        // idempotent (the SQL WHERE guards only transition a pending row), so the
        // crash-window reconciliation leg and a re-projection are safe.
        case "thread.peer-message-delivered": {
          yield* projectionThreadPeerMessageRepository.markDelivered({
            recordId: event.payload.recordId,
            updatedAt: event.payload.updatedAt,
          });
          yield* refreshThreadShellSummary(event.payload.senderThreadId);
          return;
        }
        case "thread.peer-message-expired": {
          yield* projectionThreadPeerMessageRepository.markExpired({
            recordId: event.payload.recordId,
            updatedAt: event.payload.updatedAt,
          });
          yield* refreshThreadShellSummary(event.payload.senderThreadId);
          return;
        }

        default:
          return;
      }
    });

    const applyThreadMessagesProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadMessagesProjection",
    )(function* (event, attachmentSideEffects) {
      switch (event.type) {
        case "thread.message-sent": {
          const existingMessage = yield* projectionThreadMessageRepository.getByMessageId({
            messageId: event.payload.messageId,
          });
          const previousMessage = Option.getOrUndefined(existingMessage);
          const nextText = Option.match(existingMessage, {
            onNone: () => event.payload.text,
            onSome: (message) => {
              if (event.payload.streaming) {
                return `${message.text}${event.payload.text}`;
              }
              if (event.payload.text.length === 0) {
                return message.text;
              }
              return event.payload.text;
            },
          });
          const nextAttachments =
            event.payload.attachments !== undefined
              ? yield* materializeAttachmentsForProjection({
                  attachments: event.payload.attachments,
                })
              : previousMessage?.attachments;
          yield* projectionThreadMessageRepository.upsert({
            messageId: event.payload.messageId,
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
            role: event.payload.role,
            ...(event.payload.origin !== undefined ? { origin: event.payload.origin } : {}),
            ...(event.payload.controlPayload !== undefined
              ? { controlPayload: event.payload.controlPayload }
              : {}),
            text: nextText,
            ...(nextAttachments !== undefined ? { attachments: [...nextAttachments] } : {}),
            isStreaming: event.payload.streaming,
            createdAt: previousMessage?.createdAt ?? event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.message-reasoning": {
          const existingMessage = yield* projectionThreadMessageRepository.getByMessageId({
            messageId: event.payload.messageId,
          });
          const previousMessage = Option.getOrUndefined(existingMessage);
          yield* projectionThreadMessageRepository.upsert({
            messageId: event.payload.messageId,
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
            // Reasoning may precede the answer; default a stub assistant message.
            role: previousMessage?.role ?? "assistant",
            text: previousMessage?.text ?? "",
            ...(previousMessage?.attachments !== undefined
              ? { attachments: [...previousMessage.attachments] }
              : {}),
            isStreaming: previousMessage?.isStreaming ?? true,
            // v2 REPLACE: the event carries the full accumulated text.
            reasoningText: event.payload.reasoningText,
            reasoningStreaming: event.payload.reasoningStreaming,
            ...(event.payload.reasoningMs !== undefined
              ? { reasoningMs: event.payload.reasoningMs }
              : {}),
            createdAt: previousMessage?.createdAt ?? event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.reverted": {
          const existingRows = yield* projectionThreadMessageRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }

          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptRows = retainProjectionMessagesAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          );
          if (keptRows.length === existingRows.length) {
            return;
          }

          yield* projectionThreadMessageRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptRows, projectionThreadMessageRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          attachmentSideEffects.prunedThreadRelativePaths.set(
            event.payload.threadId,
            collectThreadAttachmentRelativePaths(event.payload.threadId, keptRows),
          );
          return;
        }

        default:
          return;
      }
    });

    const applyThreadProposedPlansProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadProposedPlansProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "thread.proposed-plan-upserted":
          yield* projectionThreadProposedPlanRepository.upsert({
            planId: event.payload.proposedPlan.id,
            threadId: event.payload.threadId,
            turnId: event.payload.proposedPlan.turnId,
            planMarkdown: event.payload.proposedPlan.planMarkdown,
            implementedAt: event.payload.proposedPlan.implementedAt,
            implementationThreadId: event.payload.proposedPlan.implementationThreadId,
            createdAt: event.payload.proposedPlan.createdAt,
            updatedAt: event.payload.proposedPlan.updatedAt,
          });
          return;

        case "thread.reverted": {
          const existingRows = yield* projectionThreadProposedPlanRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }

          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptRows = retainProjectionProposedPlansAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          );
          if (keptRows.length === existingRows.length) {
            return;
          }

          yield* projectionThreadProposedPlanRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptRows, projectionThreadProposedPlanRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          return;
        }

        default:
          return;
      }
    });

    const applyThreadActivitiesProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadActivitiesProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "thread.activity-appended":
          yield* projectionThreadActivityRepository.upsert({
            activityId: event.payload.activity.id,
            threadId: event.payload.threadId,
            turnId: event.payload.activity.turnId,
            tone: event.payload.activity.tone,
            kind: event.payload.activity.kind,
            summary: event.payload.activity.summary,
            payload: event.payload.activity.payload,
            ...(event.payload.activity.sequence !== undefined
              ? { sequence: event.payload.activity.sequence }
              : {}),
            createdAt: event.payload.activity.createdAt,
          });
          return;

        case "thread.reverted": {
          const existingRows = yield* projectionThreadActivityRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }
          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptRows = retainProjectionActivitiesAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          );
          if (keptRows.length === existingRows.length) {
            return;
          }
          yield* projectionThreadActivityRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptRows, projectionThreadActivityRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          return;
        }

        default:
          return;
      }
    });

    const applyThreadSessionsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadSessionsProjection",
    )(function* (event, _attachmentSideEffects) {
      if (event.type !== "thread.session-set") {
        return;
      }
      const explicitLastErrorClass = event.payload.session.lastErrorClass;
      const previousSession =
        explicitLastErrorClass === undefined
          ? Option.getOrNull(
              yield* projectionThreadSessionRepository.getByThreadId({
                threadId: event.payload.threadId,
              }),
            )
          : null;
      yield* projectionThreadSessionRepository.upsert({
        threadId: event.payload.threadId,
        status: event.payload.session.status,
        providerName: event.payload.session.providerName,
        providerInstanceId: event.payload.session.providerInstanceId ?? null,
        runtimeMode: event.payload.session.runtimeMode,
        activeTurnId: event.payload.session.activeTurnId,
        lastError: event.payload.session.lastError,
        lastErrorClass:
          explicitLastErrorClass ??
          (previousSession?.lastError === event.payload.session.lastError
            ? previousSession.lastErrorClass
            : null),
        updatedAt: event.payload.session.updatedAt,
      });
    });

    const applyThreadTurnsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadTurnsProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "thread.turn-start-requested": {
          yield* projectionTurnRepository.replacePendingTurnStart({
            threadId: event.payload.threadId,
            messageId: event.payload.messageId,
            sourceProposedPlanThreadId: event.payload.sourceProposedPlan?.threadId ?? null,
            sourceProposedPlanId: event.payload.sourceProposedPlan?.planId ?? null,
            requestedAt: event.payload.createdAt,
          });
          return;
        }

        case "thread.turn-start-failed": {
          // Fix A: the turn-start failed before `turn.started`, so the
          // running+activeTurnId `thread.session-set` that normally clears the
          // pending turn-start row will never arrive. Clear it here so the idle
          // gate (`isThreadIdle` / `getPendingTurnStartThreadIds`) stops
          // treating the parent as busy — otherwise a deferred dispatcher wake
          // is stranded forever.
          yield* projectionTurnRepository.deletePendingTurnStartByThreadId({
            threadId: event.payload.threadId,
          });
          return;
        }

        case "thread.session-set": {
          const turnId = event.payload.session.activeTurnId;
          if (turnId === null || event.payload.session.status !== "running") {
            if (
              event.payload.session.status === "error" ||
              event.payload.session.status === "stopped" ||
              event.payload.session.status === "interrupted"
            ) {
              yield* projectionTurnRepository.deletePendingTurnStartByThreadId({
                threadId: event.payload.threadId,
              });
            }
            // Leaving the "running" session status is the turn-end signal:
            // settle still-running turns so their duration reflects the whole
            // turn rather than the last assistant message.
            const settledTurnState = settledTurnStateForSessionStatus(event.payload.session.status);
            if (settledTurnState === null) {
              return;
            }
            const existingTurns = yield* projectionTurnRepository.listRunningByThreadId({
              threadId: event.payload.threadId,
            });
            yield* Effect.forEach(
              existingTurns.filter((turn) => turn.turnId !== null),
              (turn) =>
                turn.turnId === null
                  ? Effect.void
                  : projectionTurnRepository.upsertByTurnId({
                      ...turn,
                      turnId: turn.turnId,
                      state: settledTurnState,
                      // A running turn's completedAt can only hold a mid-turn
                      // placeholder checkpoint timestamp — the session leaving
                      // "running" is the authoritative turn end.
                      completedAt: event.payload.session.updatedAt,
                    }),
              { concurrency: 1 },
            );
            return;
          }

          // A new active turn supersedes any still-running turn on the same
          // thread — steering can open a new turn without the provider ever
          // completing the previous one.
          const otherRunningTurns = yield* projectionTurnRepository.listRunningByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(
            otherRunningTurns.filter((turn) => turn.turnId !== null && turn.turnId !== turnId),
            (turn) =>
              turn.turnId === null
                ? Effect.void
                : projectionTurnRepository.upsertByTurnId({
                    ...turn,
                    turnId: turn.turnId,
                    state: "completed",
                    completedAt: event.payload.session.updatedAt,
                  }),
            { concurrency: 1 },
          );

          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId,
          });
          const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
            threadId: event.payload.threadId,
          });
          if (Option.isSome(existingTurn)) {
            const nextState =
              existingTurn.value.state === "completed" || existingTurn.value.state === "error"
                ? existingTurn.value.state
                : "running";
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              state: nextState,
              pendingMessageId:
                existingTurn.value.pendingMessageId ??
                (Option.isSome(pendingTurnStart) ? pendingTurnStart.value.messageId : null),
              sourceProposedPlanThreadId:
                existingTurn.value.sourceProposedPlanThreadId ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.sourceProposedPlanThreadId
                  : null),
              sourceProposedPlanId:
                existingTurn.value.sourceProposedPlanId ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.sourceProposedPlanId
                  : null),
              startedAt:
                existingTurn.value.startedAt ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.requestedAt
                  : event.occurredAt),
              requestedAt:
                existingTurn.value.requestedAt ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.requestedAt
                  : event.occurredAt),
            });
          } else {
            yield* projectionTurnRepository.upsertByTurnId({
              turnId,
              threadId: event.payload.threadId,
              pendingMessageId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.messageId
                : null,
              sourceProposedPlanThreadId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.sourceProposedPlanThreadId
                : null,
              sourceProposedPlanId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.sourceProposedPlanId
                : null,
              assistantMessageId: null,
              state: "running",
              requestedAt: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.requestedAt
                : event.occurredAt,
              startedAt: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.requestedAt
                : event.occurredAt,
              completedAt: null,
              checkpointTurnCount: null,
              checkpointRef: null,
              checkpointStatus: null,
              checkpointFiles: [],
            });
          }

          yield* projectionTurnRepository.deletePendingTurnStartByThreadId({
            threadId: event.payload.threadId,
          });
          return;
        }

        case "thread.message-sent": {
          if (event.payload.turnId === null || event.payload.role !== "assistant") {
            return;
          }
          // A completed assistant message only settles the turn once the
          // session is no longer running it — providers may emit several
          // assistant messages per turn (commentary between tool calls), and
          // the turn must stay unsettled until the provider reports turn end
          // (projected as thread.session-set leaving the "running" status).
          const session = yield* projectionThreadSessionRepository.getByThreadId({
            threadId: event.payload.threadId,
          });
          const turnStillRunning =
            Option.isSome(session) &&
            session.value.status === "running" &&
            session.value.activeTurnId === event.payload.turnId;
          const settlesTurn = !event.payload.streaming && !turnStillRunning;
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          if (Option.isSome(existingTurn)) {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              assistantMessageId: event.payload.messageId,
              state: settlesTurn
                ? existingTurn.value.state === "interrupted"
                  ? "interrupted"
                  : existingTurn.value.state === "error"
                    ? "error"
                    : "completed"
                : existingTurn.value.state,
              completedAt: settlesTurn
                ? (existingTurn.value.completedAt ?? event.payload.updatedAt)
                : existingTurn.value.completedAt,
              startedAt: existingTurn.value.startedAt ?? event.payload.createdAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.createdAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: event.payload.messageId,
            state: settlesTurn ? "completed" : "running",
            requestedAt: event.payload.createdAt,
            startedAt: event.payload.createdAt,
            completedAt: settlesTurn ? event.payload.updatedAt : null,
            checkpointTurnCount: null,
            checkpointRef: null,
            checkpointStatus: null,
            checkpointFiles: [],
          });
          return;
        }

        case "thread.turn-interrupt-requested": {
          if (event.payload.turnId === undefined) {
            return;
          }
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          if (Option.isSome(existingTurn)) {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              state: "interrupted",
              completedAt: existingTurn.value.completedAt ?? event.payload.createdAt,
              startedAt: existingTurn.value.startedAt ?? event.payload.createdAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.createdAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: null,
            state: "interrupted",
            requestedAt: event.payload.createdAt,
            startedAt: event.payload.createdAt,
            completedAt: event.payload.createdAt,
            checkpointTurnCount: null,
            checkpointRef: null,
            checkpointStatus: null,
            checkpointFiles: [],
          });
          return;
        }

        case "thread.turn-diff-completed": {
          // Mid-turn diff updates produce placeholder checkpoints; record the
          // checkpoint, but don't settle a turn its session is still running.
          const session = yield* projectionThreadSessionRepository.getByThreadId({
            threadId: event.payload.threadId,
          });
          const turnStillRunning =
            Option.isSome(session) &&
            session.value.status === "running" &&
            session.value.activeTurnId === event.payload.turnId;
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          const nextState = event.payload.status === "error" ? "error" : "completed";
          yield* projectionTurnRepository.clearCheckpointTurnConflict({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
            checkpointTurnCount: event.payload.checkpointTurnCount,
          });

          if (Option.isSome(existingTurn)) {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              assistantMessageId: event.payload.assistantMessageId,
              state: turnStillRunning ? existingTurn.value.state : nextState,
              checkpointTurnCount: event.payload.checkpointTurnCount,
              checkpointRef: event.payload.checkpointRef,
              checkpointStatus: event.payload.status,
              checkpointFiles: event.payload.files,
              startedAt: existingTurn.value.startedAt ?? event.payload.completedAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.completedAt,
              completedAt: event.payload.completedAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: event.payload.assistantMessageId,
            state: turnStillRunning ? "running" : nextState,
            requestedAt: event.payload.completedAt,
            startedAt: event.payload.completedAt,
            completedAt: event.payload.completedAt,
            checkpointTurnCount: event.payload.checkpointTurnCount,
            checkpointRef: event.payload.checkpointRef,
            checkpointStatus: event.payload.status,
            checkpointFiles: event.payload.files,
          });
          return;
        }

        case "thread.reverted": {
          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptTurns = existingTurns.filter(
            (turn) =>
              turn.turnId !== null &&
              turn.checkpointTurnCount !== null &&
              turn.checkpointTurnCount <= event.payload.turnCount,
          );
          yield* projectionTurnRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(
            keptTurns,
            (turn) =>
              turn.turnId === null
                ? Effect.void
                : projectionTurnRepository.upsertByTurnId({
                    ...turn,
                    turnId: turn.turnId,
                  }),
            { concurrency: 1 },
          ).pipe(Effect.asVoid);
          return;
        }

        default:
          return;
      }
    });

    const applyCheckpointsProjection: ProjectorDefinition["apply"] = () => Effect.void;

    const applyPendingApprovalsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyPendingApprovalsProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "thread.activity-appended": {
          const requestId =
            extractActivityRequestId(event.payload.activity.payload) ??
            event.metadata.requestId ??
            null;
          if (requestId === null) {
            return;
          }
          const existingRow = yield* projectionPendingApprovalRepository.getByRequestId({
            requestId,
          });
          if (event.payload.activity.kind === "approval.resolved") {
            const resolvedDecisionRaw =
              typeof event.payload.activity.payload === "object" &&
              event.payload.activity.payload !== null &&
              "decision" in event.payload.activity.payload
                ? (event.payload.activity.payload as { decision?: unknown }).decision
                : null;
            const resolvedDecision =
              resolvedDecisionRaw === "accept" ||
              resolvedDecisionRaw === "acceptForSession" ||
              resolvedDecisionRaw === "decline" ||
              resolvedDecisionRaw === "cancel"
                ? resolvedDecisionRaw
                : null;
            yield* projectionPendingApprovalRepository.upsert({
              requestId,
              threadId: Option.isSome(existingRow)
                ? existingRow.value.threadId
                : event.payload.threadId,
              turnId: Option.isSome(existingRow)
                ? existingRow.value.turnId
                : event.payload.activity.turnId,
              status: "resolved",
              decision: resolvedDecision,
              createdAt: Option.isSome(existingRow)
                ? existingRow.value.createdAt
                : event.payload.activity.createdAt,
              resolvedAt: event.payload.activity.createdAt,
            });
            return;
          }
          if (event.payload.activity.kind === "provider.approval.respond.failed") {
            const payload =
              typeof event.payload.activity.payload === "object" &&
              event.payload.activity.payload !== null
                ? (event.payload.activity.payload as Record<string, unknown>)
                : null;
            const detail =
              typeof payload?.detail === "string" ? payload.detail.toLowerCase() : null;
            if (isStalePendingApprovalFailureDetail(detail)) {
              if (Option.isNone(existingRow)) {
                return;
              }
              if (existingRow.value.status === "resolved") {
                return;
              }
              yield* projectionPendingApprovalRepository.upsert({
                requestId,
                threadId: existingRow.value.threadId,
                turnId: existingRow.value.turnId,
                status: "resolved",
                decision: null,
                createdAt: existingRow.value.createdAt,
                resolvedAt: event.payload.activity.createdAt,
              });
              return;
            }
            return;
          }
          // Only approval-requested activities should create pending-approval
          // rows.  Other activity kinds that happen to carry a requestId
          // (e.g. user-input.requested / user-input.resolved) must not
          // pollute this projection — the shell aggregate accounts for them
          // directly from the activity log.
          if (event.payload.activity.kind !== "approval.requested") {
            return;
          }
          if (Option.isSome(existingRow) && existingRow.value.status === "resolved") {
            return;
          }
          yield* projectionPendingApprovalRepository.upsert({
            requestId,
            threadId: event.payload.threadId,
            turnId: event.payload.activity.turnId,
            status: "pending",
            decision: null,
            createdAt: Option.isSome(existingRow)
              ? existingRow.value.createdAt
              : event.payload.activity.createdAt,
            resolvedAt: null,
          });
          return;
        }

        case "thread.approval-response-requested": {
          const existingRow = yield* projectionPendingApprovalRepository.getByRequestId({
            requestId: event.payload.requestId,
          });
          yield* projectionPendingApprovalRepository.upsert({
            requestId: event.payload.requestId,
            threadId: Option.isSome(existingRow)
              ? existingRow.value.threadId
              : event.payload.threadId,
            turnId: Option.isSome(existingRow) ? existingRow.value.turnId : null,
            status: "resolved",
            decision: event.payload.decision,
            createdAt: Option.isSome(existingRow)
              ? existingRow.value.createdAt
              : event.payload.createdAt,
            resolvedAt: event.payload.createdAt,
          });
          return;
        }

        default:
          return;
      }
    });

    const projectors: ReadonlyArray<ProjectorDefinition> = [
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.projects,
        apply: applyProjectsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.goals,
        apply: applyGoalsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadMessages,
        apply: applyThreadMessagesProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans,
        apply: applyThreadProposedPlansProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
        apply: applyThreadActivitiesProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
        apply: applyThreadSessionsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadTurns,
        apply: applyThreadTurnsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.checkpoints,
        apply: applyCheckpointsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.pendingApprovals,
        apply: applyPendingApprovalsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threads,
        apply: applyThreadsProjection,
      },
    ];

    const runProjectorForEvent = Effect.fn("runProjectorForEvent")(function* (
      projector: ProjectorDefinition,
      event: OrchestrationEvent,
    ) {
      const attachmentSideEffects: AttachmentSideEffects = {
        deletedThreadIds: new Set<string>(),
        prunedThreadRelativePaths: new Map<string, Set<string>>(),
      };

      yield* sql.withTransaction(
        projector.apply(event, attachmentSideEffects).pipe(
          Effect.flatMap(() =>
            projectionStateRepository.upsert({
              projector: projector.name,
              lastAppliedSequence: event.sequence,
              updatedAt: event.occurredAt,
            }),
          ),
        ),
      );

      yield* runAttachmentSideEffects(attachmentSideEffects).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("failed to apply projected attachment side-effects", {
            projector: projector.name,
            sequence: event.sequence,
            eventType: event.type,
            cause,
          }),
        ),
      );
    });

    const bootstrapProjector = (projector: ProjectorDefinition) =>
      projectionStateRepository
        .getByProjector({
          projector: projector.name,
        })
        .pipe(
          Effect.flatMap((stateRow) =>
            Stream.runForEach(
              // loom: bootstrap must apply EVERY event after the projector's
              // cursor. Without an explicit bound the store's page-bounded
              // default (1,000) silently truncates, and the projector then
              // records the truncated cursor as if it were caught up.
              eventStore.readFromSequence(
                Option.isSome(stateRow) ? stateRow.value.lastAppliedSequence : 0,
                Number.MAX_SAFE_INTEGER,
              ),
              (event) => runProjectorForEvent(projector, event),
            ),
          ),
        );

    const projectEvent: OrchestrationProjectionPipelineShape["projectEvent"] = (event) =>
      Effect.forEach(projectors, (projector) => runProjectorForEvent(projector, event), {
        concurrency: 1,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ServerConfig, serverConfig),
        Effect.asVoid,
        Effect.catchTag("SqlError", (sqlError) =>
          Effect.fail(toPersistenceSqlError("ProjectionPipeline.projectEvent:query")(sqlError)),
        ),
      );

    const bootstrap: OrchestrationProjectionPipelineShape["bootstrap"] = Effect.forEach(
      projectors,
      bootstrapProjector,
      { concurrency: 1 },
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig, serverConfig),
      Effect.asVoid,
      Effect.tap(() =>
        Effect.logDebug("orchestration projection pipeline bootstrapped").pipe(
          Effect.annotateLogs({ projectors: projectors.length }),
        ),
      ),
      Effect.catchTag("SqlError", (sqlError) =>
        Effect.fail(toPersistenceSqlError("ProjectionPipeline.bootstrap:query")(sqlError)),
      ),
    );

    return {
      bootstrap,
      projectEvent,
    } satisfies OrchestrationProjectionPipelineShape;
  },
);

export const OrchestrationProjectionPipelineLive = Layer.effect(
  OrchestrationProjectionPipeline,
  makeOrchestrationProjectionPipeline(),
).pipe(
  Layer.provideMerge(ProjectionProjectRepositoryLive),
  Layer.provideMerge(ProjectionGoalRepositoryLive),
  Layer.provideMerge(ProjectionThreadRepositoryLive),
  Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
  Layer.provideMerge(ProjectionThreadProposedPlanRepositoryLive),
  Layer.provideMerge(ProjectionThreadActivityRepositoryLive),
  Layer.provideMerge(ProjectionThreadConsultRepositoryLive),
  Layer.provideMerge(ProjectionThreadPeerMessageRepositoryLive),
  Layer.provideMerge(ProjectionThreadSessionRepositoryLive),
  Layer.provideMerge(ProjectionTurnRepositoryLive),
  Layer.provideMerge(ProjectionPendingApprovalRepositoryLive),
  Layer.provideMerge(ProjectionStateRepositoryLive),
);
