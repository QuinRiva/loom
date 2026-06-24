import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  GetProjectionGoalInput,
  ListProjectionGoalTasksInput,
  ProjectionGoal,
  ProjectionGoalRepository,
  ProjectionGoalTask,
  type ProjectionGoalRepositoryShape,
} from "../Services/ProjectionGoals.ts";

const makeProjectionGoalRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertGoalRow = SqlSchema.void({
    Request: ProjectionGoal,
    execute: (row) =>
      sql`
        INSERT INTO projection_goals (
          goal_id,
          project_id,
          slug,
          title,
          description,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          ${row.goalId},
          ${row.projectId},
          ${row.slug},
          ${row.title},
          ${row.description},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.archivedAt},
          ${row.deletedAt}
        )
        ON CONFLICT (goal_id)
        DO UPDATE SET
          project_id = excluded.project_id,
          slug = excluded.slug,
          title = excluded.title,
          description = excluded.description,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          archived_at = excluded.archived_at,
          deleted_at = excluded.deleted_at
      `,
  });

  const getGoalRow = SqlSchema.findOneOption({
    Request: GetProjectionGoalInput,
    Result: ProjectionGoal,
    execute: ({ goalId }) =>
      sql`
        SELECT
          goal_id AS "goalId",
          project_id AS "projectId",
          slug,
          title,
          description,
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          deleted_at AS "deletedAt"
        FROM projection_goals
        WHERE goal_id = ${goalId}
      `,
  });

  const listGoalRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionGoal,
    execute: () =>
      sql`
        SELECT
          goal_id AS "goalId",
          project_id AS "projectId",
          slug,
          title,
          description,
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          deleted_at AS "deletedAt"
        FROM projection_goals
        ORDER BY created_at ASC, goal_id ASC
      `,
  });

  const upsertTaskRow = SqlSchema.void({
    Request: ProjectionGoalTask,
    execute: (row) =>
      sql`
        INSERT INTO projection_goal_tasks (
          task_id,
          goal_id,
          parent_task_id,
          position,
          text,
          done,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          ${row.taskId},
          ${row.goalId},
          ${row.parentTaskId},
          ${row.position},
          ${row.text},
          ${row.done},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.deletedAt}
        )
        ON CONFLICT (task_id)
        DO UPDATE SET
          goal_id = excluded.goal_id,
          parent_task_id = excluded.parent_task_id,
          position = excluded.position,
          text = excluded.text,
          done = excluded.done,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at
      `,
  });

  const listTasksByGoalRows = SqlSchema.findAll({
    Request: ListProjectionGoalTasksInput,
    Result: ProjectionGoalTask,
    execute: ({ goalId }) =>
      sql`
        SELECT
          task_id AS "taskId",
          goal_id AS "goalId",
          parent_task_id AS "parentTaskId",
          position,
          text,
          done,
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_goal_tasks
        WHERE goal_id = ${goalId}
        ORDER BY position ASC, created_at ASC, task_id ASC
      `,
  });

  const listAllTaskRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionGoalTask,
    execute: () =>
      sql`
        SELECT
          task_id AS "taskId",
          goal_id AS "goalId",
          parent_task_id AS "parentTaskId",
          position,
          text,
          done,
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_goal_tasks
        ORDER BY position ASC, created_at ASC, task_id ASC
      `,
  });

  const upsertGoal: ProjectionGoalRepositoryShape["upsertGoal"] = (row) =>
    upsertGoalRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionGoalRepository.upsertGoal:query")),
    );

  const getGoalById: ProjectionGoalRepositoryShape["getGoalById"] = (input) =>
    getGoalRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionGoalRepository.getGoalById:query")),
    );

  const listGoals: ProjectionGoalRepositoryShape["listGoals"] = () =>
    listGoalRows().pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionGoalRepository.listGoals:query")),
    );

  const upsertTask: ProjectionGoalRepositoryShape["upsertTask"] = (row) =>
    upsertTaskRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionGoalRepository.upsertTask:query")),
    );

  const listTasksByGoalId: ProjectionGoalRepositoryShape["listTasksByGoalId"] = (input) =>
    listTasksByGoalRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionGoalRepository.listTasksByGoalId:query")),
    );

  const listTasks: ProjectionGoalRepositoryShape["listTasks"] = () =>
    listAllTaskRows().pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionGoalRepository.listTasks:query")),
    );

  return {
    upsertGoal,
    getGoalById,
    listGoals,
    upsertTask,
    listTasksByGoalId,
    listTasks,
  } satisfies ProjectionGoalRepositoryShape;
});

export const ProjectionGoalRepositoryLive = Layer.effect(
  ProjectionGoalRepository,
  makeProjectionGoalRepository,
);
