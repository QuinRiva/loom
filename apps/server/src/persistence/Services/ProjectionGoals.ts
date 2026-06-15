/** ProjectionGoalRepository - Projection repository interface for goals. */
import { GoalId, IsoDateTime, ProjectId } from "@t3tools/contracts";
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
  worktreePath: Schema.String,
  branch: Schema.String,
  packagePath: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionGoal = typeof ProjectionGoal.Type;

export const GetProjectionGoalInput = Schema.Struct({ goalId: GoalId });
export type GetProjectionGoalInput = typeof GetProjectionGoalInput.Type;

export const DeleteProjectionGoalInput = Schema.Struct({ goalId: GoalId });
export type DeleteProjectionGoalInput = typeof DeleteProjectionGoalInput.Type;

export const ListProjectionGoalsByProjectInput = Schema.Struct({ projectId: ProjectId });
export type ListProjectionGoalsByProjectInput = typeof ListProjectionGoalsByProjectInput.Type;

export interface ProjectionGoalRepositoryShape {
  readonly upsert: (goal: ProjectionGoal) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (
    input: GetProjectionGoalInput,
  ) => Effect.Effect<Option.Option<ProjectionGoal>, ProjectionRepositoryError>;
  readonly listAll: () => Effect.Effect<ReadonlyArray<ProjectionGoal>, ProjectionRepositoryError>;
  readonly listByProjectId: (
    input: ListProjectionGoalsByProjectInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionGoal>, ProjectionRepositoryError>;
  readonly deleteById: (
    input: DeleteProjectionGoalInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionGoalRepository extends Context.Service<
  ProjectionGoalRepository,
  ProjectionGoalRepositoryShape
>()("t3/persistence/Services/ProjectionGoals/ProjectionGoalRepository") {}
