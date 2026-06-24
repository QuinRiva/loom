import {
  CommandId,
  GoalId,
  GoalTaskId,
  type ClientOrchestrationCommand,
  type OrchestrationGoal,
  type OrchestrationGoalTask,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import type * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import { Argument, Command, Flag } from "effect/unstable/cli";
import type { HttpClient } from "effect/unstable/http";

import { WorkspacePaths } from "../workspace/Services/WorkspacePaths.ts";
import { type CliAuthLocationFlags, projectLocationFlags } from "./config.ts";
import {
  OrchestrationCliError,
  type OrchestrationMutationInput,
  orchestrationCliUuid,
  runOrchestrationMutation,
} from "./orchestrationMutation.ts";

type GoalCliDispatchCommand = Extract<
  ClientOrchestrationCommand,
  {
    type:
      | "goal.create"
      | "goal.meta.update"
      | "goal.archive"
      | "goal.unarchive"
      | "goal.delete"
      | "goal.task.create"
      | "goal.task.update"
      | "goal.task.delete";
  }
>;

const runGoalMutation = (
  flags: CliAuthLocationFlags,
  run: (
    input: OrchestrationMutationInput<GoalCliDispatchCommand>,
  ) => Effect.Effect<
    string,
    Error,
    Crypto.Crypto | FileSystem.FileSystem | HttpClient.HttpClient | Path.Path | WorkspacePaths
  >,
) => runOrchestrationMutation<GoalCliDispatchCommand>(flags, run);

const activeGoals = (snapshot: OrchestrationReadModel): ReadonlyArray<OrchestrationGoal> =>
  snapshot.goals.filter((goal) => goal.deletedAt === null);

const resolveProjectId = Effect.fn("resolveGoalProjectId")(function* (
  snapshot: OrchestrationReadModel,
  identifier: string,
) {
  const trimmed = identifier.trim();
  const activeProjects = snapshot.projects.filter((project) => project.deletedAt === null);
  const byId = activeProjects.find((project) => project.id === trimmed);
  if (byId) return byId.id;
  const workspacePaths = yield* WorkspacePaths;
  const normalized = yield* workspacePaths
    .normalizeWorkspaceRoot(trimmed)
    .pipe(Effect.orElseSucceed(() => trimmed));
  const byWorkspace = activeProjects.find((project) => project.workspaceRoot === normalized);
  if (byWorkspace) return byWorkspace.id;
  return yield* new OrchestrationCliError({
    message: `No active project found for '${identifier}'.`,
  });
});

const resolveGoal = Effect.fn("resolveGoal")(function* (
  snapshot: OrchestrationReadModel,
  identifier: string,
) {
  const trimmed = identifier.trim();
  const goals = activeGoals(snapshot);
  const byId = goals.find((goal) => goal.id === trimmed);
  if (byId) return byId;
  const bySlug = goals.filter((goal) => goal.slug === trimmed);
  if (bySlug.length === 1) return bySlug[0]!;
  if (bySlug.length > 1) {
    return yield* new OrchestrationCliError({
      message: `Goal slug '${identifier}' is ambiguous; pass the goal id instead.`,
    });
  }
  return yield* new OrchestrationCliError({ message: `No active goal found for '${identifier}'.` });
});

const findTask = (goal: OrchestrationGoal, taskId: string): OrchestrationGoalTask | undefined => {
  const stack: OrchestrationGoalTask[] = [...goal.tasks];
  while (stack.length > 0) {
    const task = stack.pop()!;
    if (task.id === taskId) return task;
    stack.push(...task.children);
  }
  return undefined;
};

const requireTask = Effect.fn("requireGoalCliTask")(function* (
  goal: OrchestrationGoal,
  taskId: string,
) {
  const task = findTask(goal, taskId);
  if (task) return task;
  return yield* new OrchestrationCliError({
    message: `No task '${taskId}' found in goal '${goal.id}'.`,
  });
});

const renderTasks = (tasks: ReadonlyArray<OrchestrationGoalTask>, depth: number): string =>
  tasks
    .map(
      (task) =>
        `${"  ".repeat(depth)}- [${task.done ? "x" : " "}] ${task.text} (${task.id})\n` +
        renderTasks(task.children, depth + 1),
    )
    .join("");

const countTasks = (tasks: ReadonlyArray<OrchestrationGoalTask>): { done: number; total: number } =>
  tasks.reduce(
    (acc, task) => {
      const child = countTasks(task.children);
      return {
        done: acc.done + (task.done ? 1 : 0) + child.done,
        total: acc.total + 1 + child.total,
      };
    },
    { done: 0, total: 0 },
  );

const goalListCommand = Command.make("list", {
  ...projectLocationFlags,
  project: Flag.string("project").pipe(
    Flag.withDescription("Filter by project id or workspace root."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("List goals."),
  Command.withHandler((flags) =>
    runGoalMutation(flags, ({ snapshot }) =>
      Effect.gen(function* () {
        const projectFilter = Option.getOrUndefined(flags.project);
        const projectId =
          projectFilter !== undefined ? yield* resolveProjectId(snapshot, projectFilter) : null;
        const goals = activeGoals(snapshot).filter(
          (goal) => projectId === null || goal.projectId === projectId,
        );
        if (goals.length === 0) return "No goals.";
        return goals
          .map((goal) => {
            const { done, total } = countTasks(goal.tasks);
            return `${goal.id}  ${goal.slug}  ${goal.title}  [${done}/${total}]`;
          })
          .join("\n");
      }),
    ),
  ),
);

const goalShowCommand = Command.make("show", {
  ...projectLocationFlags,
  goal: Argument.string("goal").pipe(Argument.withDescription("Goal id or slug.")),
}).pipe(
  Command.withDescription("Show a goal and its task tree."),
  Command.withHandler((flags) =>
    runGoalMutation(flags, ({ snapshot }) =>
      Effect.gen(function* () {
        const goal = yield* resolveGoal(snapshot, flags.goal);
        const { done, total } = countTasks(goal.tasks);
        const header = `# ${goal.title} (${goal.id})\nslug: ${goal.slug}  tasks: ${done}/${total}\n\n${goal.description}`;
        const tasks =
          goal.tasks.length === 0 ? "\n\n(no tasks)" : `\n\n${renderTasks(goal.tasks, 0)}`;
        return `${header}${tasks}`;
      }),
    ),
  ),
);

const goalCreateCommand = Command.make("create", {
  ...projectLocationFlags,
  project: Flag.string("project").pipe(
    Flag.withDescription("Project id or workspace root that owns the goal."),
  ),
  slug: Flag.string("slug").pipe(Flag.withDescription("Stable goal slug.")),
  title: Flag.string("title").pipe(Flag.withDescription("Goal title.")),
  description: Flag.string("description").pipe(
    Flag.withDescription("Goal objective paragraph."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Create a goal."),
  Command.withHandler((flags) =>
    runGoalMutation(flags, ({ snapshot, dispatch }) =>
      Effect.gen(function* () {
        const projectId = yield* resolveProjectId(snapshot, flags.project);
        const goalId = GoalId.make(yield* orchestrationCliUuid);
        yield* dispatch({
          type: "goal.create",
          commandId: CommandId.make(yield* orchestrationCliUuid),
          goalId,
          projectId,
          slug: flags.slug,
          title: flags.title,
          ...(Option.isSome(flags.description) ? { description: flags.description.value } : {}),
          createdAt: DateTime.formatIso(yield* DateTime.now),
        });
        return `Created goal ${goalId} (${flags.slug}).`;
      }),
    ),
  ),
);

const goalUpdateCommand = Command.make("update", {
  ...projectLocationFlags,
  goal: Argument.string("goal").pipe(Argument.withDescription("Goal id or slug.")),
  title: Flag.string("title").pipe(Flag.withDescription("New goal title."), Flag.optional),
  description: Flag.string("description").pipe(
    Flag.withDescription("New goal objective paragraph."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Update a goal's title/description."),
  Command.withHandler((flags) =>
    runGoalMutation(flags, ({ snapshot, dispatch }) =>
      Effect.gen(function* () {
        const goal = yield* resolveGoal(snapshot, flags.goal);
        yield* dispatch({
          type: "goal.meta.update",
          commandId: CommandId.make(yield* orchestrationCliUuid),
          goalId: goal.id,
          ...(Option.isSome(flags.title) ? { title: flags.title.value } : {}),
          ...(Option.isSome(flags.description) ? { description: flags.description.value } : {}),
        });
        return `Updated goal ${goal.id}.`;
      }),
    ),
  ),
);

const goalTaskAddCommand = Command.make("add", {
  ...projectLocationFlags,
  goal: Argument.string("goal").pipe(Argument.withDescription("Goal id or slug.")),
  text: Argument.string("text").pipe(Argument.withDescription("Task text.")),
  parent: Flag.string("parent").pipe(Flag.withDescription("Parent task id."), Flag.optional),
}).pipe(
  Command.withDescription("Add a task to a goal."),
  Command.withHandler((flags) =>
    runGoalMutation(flags, ({ snapshot, dispatch }) =>
      Effect.gen(function* () {
        const goal = yield* resolveGoal(snapshot, flags.goal);
        const parentTaskId = Option.isSome(flags.parent)
          ? (yield* requireTask(goal, flags.parent.value)).id
          : null;
        const taskId = GoalTaskId.make(yield* orchestrationCliUuid);
        yield* dispatch({
          type: "goal.task.create",
          commandId: CommandId.make(yield* orchestrationCliUuid),
          goalId: goal.id,
          taskId,
          parentTaskId,
          text: flags.text,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        });
        return `Added task ${taskId} to goal ${goal.id}.`;
      }),
    ),
  ),
);

const setTaskDoneCommand = (name: "done" | "open", done: boolean) =>
  Command.make(name, {
    ...projectLocationFlags,
    goal: Argument.string("goal").pipe(Argument.withDescription("Goal id or slug.")),
    task: Argument.string("task").pipe(Argument.withDescription("Task id.")),
  }).pipe(
    Command.withDescription(done ? "Mark a task done." : "Mark a task open."),
    Command.withHandler((flags) =>
      runGoalMutation(flags, ({ snapshot, dispatch }) =>
        Effect.gen(function* () {
          const goal = yield* resolveGoal(snapshot, flags.goal);
          const task = yield* requireTask(goal, flags.task);
          yield* dispatch({
            type: "goal.task.update",
            commandId: CommandId.make(yield* orchestrationCliUuid),
            goalId: goal.id,
            taskId: task.id,
            done,
          });
          return `Marked task ${task.id} ${done ? "done" : "open"}.`;
        }),
      ),
    ),
  );

const goalTaskRenameCommand = Command.make("rename", {
  ...projectLocationFlags,
  goal: Argument.string("goal").pipe(Argument.withDescription("Goal id or slug.")),
  task: Argument.string("task").pipe(Argument.withDescription("Task id.")),
  text: Argument.string("text").pipe(Argument.withDescription("New task text.")),
}).pipe(
  Command.withDescription("Rename a task."),
  Command.withHandler((flags) =>
    runGoalMutation(flags, ({ snapshot, dispatch }) =>
      Effect.gen(function* () {
        const goal = yield* resolveGoal(snapshot, flags.goal);
        const task = yield* requireTask(goal, flags.task);
        yield* dispatch({
          type: "goal.task.update",
          commandId: CommandId.make(yield* orchestrationCliUuid),
          goalId: goal.id,
          taskId: task.id,
          text: flags.text,
        });
        return `Renamed task ${task.id}.`;
      }),
    ),
  ),
);

const goalTaskDeleteCommand = Command.make("delete", {
  ...projectLocationFlags,
  goal: Argument.string("goal").pipe(Argument.withDescription("Goal id or slug.")),
  task: Argument.string("task").pipe(Argument.withDescription("Task id.")),
}).pipe(
  Command.withDescription("Delete a task (and its subtree)."),
  Command.withHandler((flags) =>
    runGoalMutation(flags, ({ snapshot, dispatch }) =>
      Effect.gen(function* () {
        const goal = yield* resolveGoal(snapshot, flags.goal);
        const task = yield* requireTask(goal, flags.task);
        yield* dispatch({
          type: "goal.task.delete",
          commandId: CommandId.make(yield* orchestrationCliUuid),
          goalId: goal.id,
          taskId: task.id,
        });
        return `Deleted task ${task.id}.`;
      }),
    ),
  ),
);

const goalTaskCommand = Command.make("task").pipe(
  Command.withDescription("Manage goal tasks."),
  Command.withSubcommands([
    goalTaskAddCommand,
    setTaskDoneCommand("done", true),
    setTaskDoneCommand("open", false),
    goalTaskRenameCommand,
    goalTaskDeleteCommand,
  ]),
);

export const goalCommand = Command.make("goal").pipe(
  Command.withDescription("Manage DB-authoritative goals and tasks."),
  Command.withSubcommands([
    goalListCommand,
    goalShowCommand,
    goalCreateCommand,
    goalUpdateCommand,
    goalTaskCommand,
  ]),
);
