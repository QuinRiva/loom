/**
 * Builders for the goal/task mutation commands shared by the human-facing
 * `t3 goal …` CLI (`cli/goal.ts`) and the agent-facing goal-task HTTP tools
 * (`mcp/GoalTaskHttp.ts`). Both surfaces dispatch the SAME decider commands —
 * these builders are the single place their shape is assembled. Callers supply
 * the already-branded ids / generated `commandId` / `createdAt`; the builders
 * only assemble the struct (and drop absent optionals).
 */
import type {
  ClientOrchestrationCommand,
  CommandId,
  GoalId,
  GoalTaskId,
  GoalTaskRewriteEntry,
  ProjectId,
} from "@t3tools/contracts";

type GoalCommand<T extends string> = Extract<ClientOrchestrationCommand, { readonly type: T }>;

export const buildGoalCreateCommand = (input: {
  readonly commandId: CommandId;
  readonly goalId: GoalId;
  readonly projectId: ProjectId;
  readonly slug: string;
  readonly title: string;
  readonly description?: string;
  readonly createdAt: string;
}): GoalCommand<"goal.create"> => ({
  type: "goal.create",
  commandId: input.commandId,
  goalId: input.goalId,
  projectId: input.projectId,
  slug: input.slug,
  title: input.title,
  ...(input.description !== undefined ? { description: input.description } : {}),
  createdAt: input.createdAt,
});

export const buildGoalTaskCreateCommand = (input: {
  readonly commandId: CommandId;
  readonly goalId: GoalId;
  readonly taskId: GoalTaskId;
  readonly parentTaskId: GoalTaskId | null;
  readonly text: string;
  readonly position?: number;
  readonly createdAt: string;
}): GoalCommand<"goal.task.create"> => ({
  type: "goal.task.create",
  commandId: input.commandId,
  goalId: input.goalId,
  taskId: input.taskId,
  parentTaskId: input.parentTaskId,
  text: input.text,
  ...(input.position !== undefined ? { position: input.position } : {}),
  createdAt: input.createdAt,
});

export const buildGoalTaskUpdateCommand = (input: {
  readonly commandId: CommandId;
  readonly goalId: GoalId;
  readonly taskId: GoalTaskId;
  readonly text?: string;
  readonly done?: boolean;
}): GoalCommand<"goal.task.update"> => ({
  type: "goal.task.update",
  commandId: input.commandId,
  goalId: input.goalId,
  taskId: input.taskId,
  ...(input.text !== undefined ? { text: input.text } : {}),
  ...(input.done !== undefined ? { done: input.done } : {}),
});

/**
 * Declarative whole-tree replace. `tasks` is already fully resolved by the
 * caller (the edge mints ids for new lines, copies `createdAt` from retained
 * tasks, and assigns positions from document order); parents must precede their
 * children, which the decider re-checks.
 */
export const buildGoalTasksRewriteCommand = (input: {
  readonly commandId: CommandId;
  readonly goalId: GoalId;
  readonly tasks: ReadonlyArray<GoalTaskRewriteEntry>;
  readonly createdAt: string;
}): GoalCommand<"goal.tasks.rewrite"> => ({
  type: "goal.tasks.rewrite",
  commandId: input.commandId,
  goalId: input.goalId,
  tasks: input.tasks,
  createdAt: input.createdAt,
});

export const buildGoalMetaUpdateCommand = (input: {
  readonly commandId: CommandId;
  readonly goalId: GoalId;
  readonly slug?: string;
  readonly title?: string;
  readonly description?: string;
}): GoalCommand<"goal.meta.update"> => ({
  type: "goal.meta.update",
  commandId: input.commandId,
  goalId: input.goalId,
  ...(input.slug !== undefined ? { slug: input.slug } : {}),
  ...(input.title !== undefined ? { title: input.title } : {}),
  ...(input.description !== undefined ? { description: input.description } : {}),
});
