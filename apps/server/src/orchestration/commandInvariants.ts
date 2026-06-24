import type {
  GoalId,
  GoalTaskId,
  OrchestrationCommand,
  OrchestrationGoal,
  OrchestrationGoalTask,
  OrchestrationProject,
  OrchestrationReadModel,
  OrchestrationThread,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { flattenGoalTasks } from "./goalTaskTree.ts";

function invariantError(commandType: string, detail: string): OrchestrationCommandInvariantError {
  return new OrchestrationCommandInvariantError({
    commandType,
    detail,
  });
}

export function findThreadById(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationThread | undefined {
  return readModel.threads.find((thread) => thread.id === threadId);
}

export function findProjectById(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): OrchestrationProject | undefined {
  return readModel.projects.find((project) => project.id === projectId);
}

export function listThreadsByProjectId(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): ReadonlyArray<OrchestrationThread> {
  return readModel.threads.filter((thread) => thread.projectId === projectId);
}

export function requireProject(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<OrchestrationProject, OrchestrationCommandInvariantError> {
  const project = findProjectById(input.readModel, input.projectId);
  if (project) {
    return Effect.succeed(project);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireProjectAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findProjectById(input.readModel, input.projectId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireThread(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  const thread = findThreadById(input.readModel, input.threadId);
  if (thread) {
    return Effect.succeed(thread);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireThreadArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt !== null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is not archived for command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadNotArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt === null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is already archived and cannot handle command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findThreadById(input.readModel, input.threadId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' already exists and cannot be created twice.`,
    ),
  );
}

export function findGoalById(
  readModel: OrchestrationReadModel,
  goalId: GoalId,
): OrchestrationGoal | undefined {
  return readModel.goals.find((goal) => goal.id === goalId);
}

export function listGoalsByProjectId(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): ReadonlyArray<OrchestrationGoal> {
  return readModel.goals.filter((goal) => goal.projectId === projectId);
}

export function requireGoal(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly goalId: GoalId;
}): Effect.Effect<OrchestrationGoal, OrchestrationCommandInvariantError> {
  const goal = findGoalById(input.readModel, input.goalId);
  if (goal) {
    return Effect.succeed(goal);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Goal '${input.goalId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireGoalAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly goalId: GoalId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findGoalById(input.readModel, input.goalId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Goal '${input.goalId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireGoalNotDeleted(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly goalId: GoalId;
}): Effect.Effect<OrchestrationGoal, OrchestrationCommandInvariantError> {
  return requireGoal(input).pipe(
    Effect.flatMap((goal) =>
      goal.deletedAt === null
        ? Effect.succeed(goal)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Goal '${input.goalId}' is deleted and cannot handle command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireGoalActive(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly goalId: GoalId;
}): Effect.Effect<OrchestrationGoal, OrchestrationCommandInvariantError> {
  return requireGoalNotDeleted(input).pipe(
    Effect.flatMap((goal) =>
      goal.archivedAt === null
        ? Effect.succeed(goal)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Goal '${input.goalId}' is archived and cannot handle command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

/**
 * Goal assignment to a thread is project-scoped: a thread may only attach to an
 * active (non-archived, non-deleted) goal that belongs to the same project.
 */
export function requireActiveGoalInProject(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly goalId: GoalId;
  readonly projectId: ProjectId;
}): Effect.Effect<OrchestrationGoal, OrchestrationCommandInvariantError> {
  return requireGoalActive(input).pipe(
    Effect.flatMap((goal) =>
      goal.projectId === input.projectId
        ? Effect.succeed(goal)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Goal '${input.goalId}' belongs to project '${goal.projectId}' and cannot be attached to a thread in project '${input.projectId}'.`,
            ),
          ),
    ),
  );
}

export function requireUniqueGoalSlug(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
  readonly slug: string;
  readonly exceptGoalId?: GoalId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  // Slug uniqueness matches the DB `UNIQUE (project_id, slug)` constraint: a
  // deleted goal still reserves its slug, so clashes include deleted goals.
  const clash = input.readModel.goals.find(
    (goal) =>
      goal.projectId === input.projectId &&
      goal.slug === input.slug &&
      goal.id !== input.exceptGoalId,
  );
  if (!clash) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Goal slug '${input.slug}' already exists in project '${input.projectId}'.`,
    ),
  );
}

function findGoalTask(
  goal: OrchestrationGoal,
  taskId: GoalTaskId,
): OrchestrationGoalTask | undefined {
  return flattenGoalTasks(goal.tasks).find((task) => task.id === taskId) as
    | OrchestrationGoalTask
    | undefined;
}

export function requireGoalTask(input: {
  readonly command: OrchestrationCommand;
  readonly goal: OrchestrationGoal;
  readonly taskId: GoalTaskId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (findGoalTask(input.goal, input.taskId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Task '${input.taskId}' does not exist in goal '${input.goal.id}'.`,
    ),
  );
}

export function requireGoalTaskAbsent(input: {
  readonly command: OrchestrationCommand;
  readonly goal: OrchestrationGoal;
  readonly taskId: GoalTaskId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findGoalTask(input.goal, input.taskId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Task '${input.taskId}' already exists in goal '${input.goal.id}'.`,
    ),
  );
}

export function requireGoalParentTask(input: {
  readonly command: OrchestrationCommand;
  readonly goal: OrchestrationGoal;
  readonly parentTaskId: GoalTaskId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (findGoalTask(input.goal, input.parentTaskId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Parent task '${input.parentTaskId}' does not exist in goal '${input.goal.id}'.`,
    ),
  );
}

export function requireNonNegativeInteger(input: {
  readonly commandType: OrchestrationCommand["type"];
  readonly field: string;
  readonly value: number;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (Number.isInteger(input.value) && input.value >= 0) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.commandType,
      `${input.field} must be an integer greater than or equal to 0.`,
    ),
  );
}
