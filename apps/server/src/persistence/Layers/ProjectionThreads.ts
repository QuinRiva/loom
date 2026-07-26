import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadInput,
  GetProjectionThreadInput,
  ListProjectionThreadsByProjectInput,
  ProjectionThread,
  ProjectionThreadRepository,
  type ProjectionThreadRepositoryShape,
} from "../Services/ProjectionThreads.ts";
import {
  ModelSelection,
  ThreadAttention,
  ThreadId,
  WorkOutcomeRecord,
  WorkstreamRoute,
} from "@t3tools/contracts";

const ProjectionThreadDbRow = ProjectionThread.mapFields(
  Struct.assign({
    modelSelection: Schema.fromJsonString(ModelSelection),
    attention: Schema.fromJsonString(ThreadAttention),
    blockedBy: Schema.fromJsonString(Schema.Array(ThreadId)),
    routes: Schema.fromJsonString(Schema.Array(WorkstreamRoute)),
    lastOutcome: Schema.NullOr(Schema.fromJsonString(WorkOutcomeRecord)),
  }),
);
type ProjectionThreadDbRow = typeof ProjectionThreadDbRow.Type;

const makeProjectionThreadRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadRow = SqlSchema.void({
    Request: ProjectionThread,
    execute: (row) =>
      sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          goal_id,
          parent_thread_id,
          role,
          purpose,
          brief,
          plan_lane,
          attention,
          blocked_by,
          spawn_generation,
          fork_from_thread_id,
          report_path,
          graph_key,
          kickoff_brief_path,
          plan_lane_since,
          dependencies_since,
          fanin_since,
          routes,
          gate_rounds,
          pending_rework,
          last_outcome,
          isolation,
          fan_in_state,
          title,
          title_provenance,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          settled_override,
          settled_at,
          snoozed_until,
          snoozed_at,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          cumulative_cost_usd,
          tool_uses,
          used_tokens,
          max_tokens,
          diff_additions,
          diff_deletions,
          handoff_count,
          deleted_at
        )
        VALUES (
          ${row.threadId},
          ${row.projectId},
          ${row.goalId ?? null},
          ${row.parentThreadId ?? null},
          ${row.role},
          ${row.purpose},
          ${row.brief},
          ${row.planLane},
          ${JSON.stringify(row.attention)},
          ${JSON.stringify(row.blockedBy)},
          ${row.spawnGeneration},
          ${row.forkFromThreadId ?? null},
          ${row.reportPath},
          ${row.graphKey},
          ${row.kickoffBriefPath},
          ${row.planLaneSince},
          ${row.dependenciesSince},
          ${row.faninSince},
          ${JSON.stringify(row.routes)},
          ${row.gateRounds},
          ${row.pendingRework},
          ${row.lastOutcome === null ? null : JSON.stringify(row.lastOutcome)},
          ${row.isolation},
          ${row.fanInState},
          ${row.title},
          ${row.titleProvenance},
          ${JSON.stringify(row.modelSelection)},
          ${row.runtimeMode},
          ${row.interactionMode},
          ${row.branch},
          ${row.worktreePath},
          ${row.latestTurnId},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.archivedAt},
          ${row.settledOverride},
          ${row.settledAt},
          ${row.snoozedUntil},
          ${row.snoozedAt},
          ${row.latestUserMessageAt},
          ${row.pendingApprovalCount},
          ${row.pendingUserInputCount},
          ${row.hasActionableProposedPlan},
          ${row.cumulativeCostUsd},
          ${row.toolUses},
          ${row.usedTokens},
          ${row.maxTokens},
          ${row.diffAdditions},
          ${row.diffDeletions},
          ${row.handoffCount},
          ${row.deletedAt}
        )
        ON CONFLICT (thread_id)
        DO UPDATE SET
          project_id = excluded.project_id,
          goal_id = excluded.goal_id,
          parent_thread_id = excluded.parent_thread_id,
          role = excluded.role,
          purpose = excluded.purpose,
          brief = excluded.brief,
          plan_lane = excluded.plan_lane,
          attention = excluded.attention,
          blocked_by = excluded.blocked_by,
          spawn_generation = excluded.spawn_generation,
          fork_from_thread_id = excluded.fork_from_thread_id,
          report_path = excluded.report_path,
          graph_key = excluded.graph_key,
          kickoff_brief_path = excluded.kickoff_brief_path,
          plan_lane_since = excluded.plan_lane_since,
          dependencies_since = excluded.dependencies_since,
          fanin_since = excluded.fanin_since,
          routes = excluded.routes,
          gate_rounds = excluded.gate_rounds,
          pending_rework = excluded.pending_rework,
          last_outcome = excluded.last_outcome,
          isolation = excluded.isolation,
          fan_in_state = excluded.fan_in_state,
          title = excluded.title,
          title_provenance = excluded.title_provenance,
          model_selection_json = excluded.model_selection_json,
          runtime_mode = excluded.runtime_mode,
          interaction_mode = excluded.interaction_mode,
          branch = excluded.branch,
          worktree_path = excluded.worktree_path,
          latest_turn_id = excluded.latest_turn_id,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          archived_at = excluded.archived_at,
          settled_override = excluded.settled_override,
          settled_at = excluded.settled_at,
          snoozed_until = excluded.snoozed_until,
          snoozed_at = excluded.snoozed_at,
          latest_user_message_at = excluded.latest_user_message_at,
          pending_approval_count = excluded.pending_approval_count,
          pending_user_input_count = excluded.pending_user_input_count,
          has_actionable_proposed_plan = excluded.has_actionable_proposed_plan,
          cumulative_cost_usd = excluded.cumulative_cost_usd,
          tool_uses = excluded.tool_uses,
          used_tokens = excluded.used_tokens,
          max_tokens = excluded.max_tokens,
          diff_additions = excluded.diff_additions,
          diff_deletions = excluded.diff_deletions,
          handoff_count = excluded.handoff_count,
          deleted_at = excluded.deleted_at
      `,
  });

  const getProjectionThreadRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadInput,
    Result: ProjectionThreadDbRow,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          goal_id AS "goalId",
          parent_thread_id AS "parentThreadId",
          role,
          purpose,
          brief,
          plan_lane AS "planLane",
          attention,
          blocked_by AS "blockedBy",
          spawn_generation AS "spawnGeneration",
          fork_from_thread_id AS "forkFromThreadId",
          report_path AS "reportPath",
          graph_key AS "graphKey",
          kickoff_brief_path AS "kickoffBriefPath",
          plan_lane_since AS "planLaneSince",
          dependencies_since AS "dependenciesSince",
          fanin_since AS "faninSince",
          routes,
          gate_rounds AS "gateRounds",
          pending_rework AS "pendingRework",
          last_outcome AS "lastOutcome",
          isolation,
          fan_in_state AS "fanInState",
          title,
          title_provenance AS "titleProvenance",
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          snoozed_until AS "snoozedUntil",
          snoozed_at AS "snoozedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          cumulative_cost_usd AS "cumulativeCostUsd",
          tool_uses AS "toolUses",
          used_tokens AS "usedTokens",
          max_tokens AS "maxTokens",
          diff_additions AS "diffAdditions",
          diff_deletions AS "diffDeletions",
          handoff_count AS "handoffCount",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `,
  });

  const listProjectionThreadRows = SqlSchema.findAll({
    Request: ListProjectionThreadsByProjectInput,
    Result: ProjectionThreadDbRow,
    execute: ({ projectId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          goal_id AS "goalId",
          parent_thread_id AS "parentThreadId",
          role,
          purpose,
          brief,
          plan_lane AS "planLane",
          attention,
          blocked_by AS "blockedBy",
          spawn_generation AS "spawnGeneration",
          fork_from_thread_id AS "forkFromThreadId",
          report_path AS "reportPath",
          graph_key AS "graphKey",
          kickoff_brief_path AS "kickoffBriefPath",
          plan_lane_since AS "planLaneSince",
          dependencies_since AS "dependenciesSince",
          fanin_since AS "faninSince",
          routes,
          gate_rounds AS "gateRounds",
          pending_rework AS "pendingRework",
          last_outcome AS "lastOutcome",
          isolation,
          fan_in_state AS "fanInState",
          title,
          title_provenance AS "titleProvenance",
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          snoozed_until AS "snoozedUntil",
          snoozed_at AS "snoozedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          cumulative_cost_usd AS "cumulativeCostUsd",
          tool_uses AS "toolUses",
          used_tokens AS "usedTokens",
          max_tokens AS "maxTokens",
          diff_additions AS "diffAdditions",
          diff_deletions AS "diffDeletions",
          handoff_count AS "handoffCount",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE project_id = ${projectId}
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  const deleteProjectionThreadRow = SqlSchema.void({
    Request: DeleteProjectionThreadInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_threads
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionThreadRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.upsert:query")),
    );

  const getById: ProjectionThreadRepositoryShape["getById"] = (input) =>
    getProjectionThreadRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.getById:query")),
    );

  const listByProjectId: ProjectionThreadRepositoryShape["listByProjectId"] = (input) =>
    listProjectionThreadRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.listByProjectId:query")),
    );

  const deleteById: ProjectionThreadRepositoryShape["deleteById"] = (input) =>
    deleteProjectionThreadRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.deleteById:query")),
    );

  return {
    upsert,
    getById,
    listByProjectId,
    deleteById,
  } satisfies ProjectionThreadRepositoryShape;
});

export const ProjectionThreadRepositoryLive = Layer.effect(
  ProjectionThreadRepository,
  makeProjectionThreadRepository,
);
