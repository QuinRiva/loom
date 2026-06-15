import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionGoalInput,
  GetProjectionGoalInput,
  ListProjectionGoalsByProjectInput,
  ProjectionGoal,
  ProjectionGoalRepository,
  type ProjectionGoalRepositoryShape,
} from "../Services/ProjectionGoals.ts";

const makeProjectionGoalRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionGoalRow = SqlSchema.void({
    Request: ProjectionGoal,
    execute: (row) => sql`
      INSERT INTO projection_goals (
        goal_id, project_id, slug, title, worktree_path, branch, package_path,
        created_at, updated_at, deleted_at
      ) VALUES (
        ${row.goalId}, ${row.projectId}, ${row.slug}, ${row.title}, ${row.worktreePath},
        ${row.branch}, ${row.packagePath}, ${row.createdAt}, ${row.updatedAt}, ${row.deletedAt}
      )
      ON CONFLICT (goal_id)
      DO UPDATE SET
        project_id = excluded.project_id,
        slug = excluded.slug,
        title = excluded.title,
        worktree_path = excluded.worktree_path,
        branch = excluded.branch,
        package_path = excluded.package_path,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        deleted_at = excluded.deleted_at
    `,
  });

  const selectGoalFields = sql`goal_id AS "goalId", project_id AS "projectId", slug, title, worktree_path AS "worktreePath", branch, package_path AS "packagePath", created_at AS "createdAt", updated_at AS "updatedAt", deleted_at AS "deletedAt"`;

  const getProjectionGoalRow = SqlSchema.findOneOption({
    Request: GetProjectionGoalInput,
    Result: ProjectionGoal,
    execute: ({ goalId }) =>
      sql`SELECT ${selectGoalFields} FROM projection_goals WHERE goal_id = ${goalId}`,
  });

  const listProjectionGoalRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionGoal,
    execute: () =>
      sql`SELECT ${selectGoalFields} FROM projection_goals ORDER BY created_at ASC, goal_id ASC`,
  });

  const listProjectionGoalRowsByProject = SqlSchema.findAll({
    Request: ListProjectionGoalsByProjectInput,
    Result: ProjectionGoal,
    execute: ({ projectId }) =>
      sql`SELECT ${selectGoalFields} FROM projection_goals WHERE project_id = ${projectId} ORDER BY created_at ASC, goal_id ASC`,
  });

  const deleteProjectionGoalRow = SqlSchema.void({
    Request: DeleteProjectionGoalInput,
    execute: ({ goalId }) => sql`DELETE FROM projection_goals WHERE goal_id = ${goalId}`,
  });

  const upsert: ProjectionGoalRepositoryShape["upsert"] = (row) =>
    upsertProjectionGoalRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionGoalRepository.upsert:query")),
    );
  const getById: ProjectionGoalRepositoryShape["getById"] = (input) =>
    getProjectionGoalRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionGoalRepository.getById:query")),
    );
  const listAll: ProjectionGoalRepositoryShape["listAll"] = () =>
    listProjectionGoalRows().pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionGoalRepository.listAll:query")),
    );
  const listByProjectId: ProjectionGoalRepositoryShape["listByProjectId"] = (input) =>
    listProjectionGoalRowsByProject(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionGoalRepository.listByProjectId:query")),
    );
  const deleteById: ProjectionGoalRepositoryShape["deleteById"] = (input) =>
    deleteProjectionGoalRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionGoalRepository.deleteById:query")),
    );

  return {
    upsert,
    getById,
    listAll,
    listByProjectId,
    deleteById,
  } satisfies ProjectionGoalRepositoryShape;
});

export const ProjectionGoalRepositoryLive = Layer.effect(
  ProjectionGoalRepository,
  makeProjectionGoalRepository,
);
