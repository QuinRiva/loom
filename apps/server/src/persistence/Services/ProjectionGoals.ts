/**
 * ProjectionGoalRepository - Projection repository for DB-authoritative goals
 * and their task trees. Tasks are stored flat (parent id + position); the
 * nested read-model tree is assembled by the snapshot query.
 *
 * @module ProjectionGoalRepository
 */
import { GoalId, GoalTaskId, IsoDateTime, NonNegativeInt, ProjectId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionGoal = Schema.Struct({
  goalId: GoalId,
  projectId: ProjectId,
  slug: Schema.String,
  title: Schema.String,
  description: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionGoal = typeof ProjectionGoal.Type;

export const ProjectionGoalTask = Schema.Struct({
  taskId: GoalTaskId,
  goalId: GoalId,
  parentTaskId: Schema.NullOr(GoalTaskId),
  position: NonNegativeInt,
  text: Schema.String,
  done: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionGoalTask = typeof ProjectionGoalTask.Type;

export const GetProjectionGoalInput = Schema.Struct({ goalId: GoalId });
export type GetProjectionGoalInput = typeof GetProjectionGoalInput.Type;

export const ListProjectionGoalTasksInput = Schema.Struct({ goalId: GoalId });
export type ListProjectionGoalTasksInput = typeof ListProjectionGoalTasksInput.Type;

export interface ProjectionGoalRepositoryShape {
  readonly upsertGoal: (row: ProjectionGoal) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getGoalById: (
    input: GetProjectionGoalInput,
  ) => Effect.Effect<Option.Option<ProjectionGoal>, ProjectionRepositoryError>;
  readonly listGoals: () => Effect.Effect<ReadonlyArray<ProjectionGoal>, ProjectionRepositoryError>;
  readonly upsertTask: (row: ProjectionGoalTask) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listTasksByGoalId: (
    input: ListProjectionGoalTasksInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionGoalTask>, ProjectionRepositoryError>;
  readonly listTasks: () => Effect.Effect<
    ReadonlyArray<ProjectionGoalTask>,
    ProjectionRepositoryError
  >;
}

export class ProjectionGoalRepository extends Context.Service<
  ProjectionGoalRepository,
  ProjectionGoalRepositoryShape
>()("t3/persistence/Services/ProjectionGoals/ProjectionGoalRepository") {}
