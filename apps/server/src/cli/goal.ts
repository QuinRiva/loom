/**
 * `t3 goal …` — the human's command-line surface for goals and their task
 * trees, writing `LoomStoreV2.goals` / `tasks` directly in the home's database
 * (V1's orchestration-command helper is gone with the V1 engine; P3-27, DT-26).
 * The tree is read and written in the same `- [x] text (id)` markdown the
 * agent tools use, through the same parse/diff module. A running server's web
 * picks a CLI write up on its next shell snapshot: goal writes reach live
 * subscribers only through the server's in-process `LoomGoalBroadcast`, which
 * this process cannot reach (DL-343).
 *
 * @module cli/goal
 */
import { GoalId, GoalTaskId, type LoomGoal } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";

import * as ServerConfig from "../config.ts";
import {
  parseGoalTaskMarkdown,
  resolveGoalTaskRewrite,
  validateGoalTaskRewriteText,
  validateGoalTaskText,
} from "../loom/goals/goalTaskMarkdown.ts";
import { renderTasks } from "../loom/goals/goalTaskRender.ts";
import { findGoalTask, flattenGoalTasks } from "../loom/goals/goalTaskTree.ts";
import * as LoomStore from "../loom/projection/LoomStore.ts";
import { ProjectServiceLayerLive } from "../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../persistence/Layers/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { type CliAuthLocationFlags, projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

export class GoalCliError extends Schema.TaggedError<GoalCliError>()("GoalCliError", {
  message: Schema.String,
}) {}

const fail = (message: string) => Effect.fail(new GoalCliError({ message }));
const uuid = Effect.flatMap(Crypto.Crypto, (crypto) => crypto.randomUUIDv4);

const store = LoomStore.LoomStoreV2;

/** Runs one command against the home's database and prints its result. */
const runGoalCommand = Effect.fn("runGoalCommand")(function* <E>(
  flags: CliAuthLocationFlags,
  run: Effect.Effect<
    string,
    E,
    | LoomStore.LoomStoreV2
    | ProjectService.ProjectService
    | WorkspacePaths.WorkspacePaths
    | FileSystem.FileSystem
    | Crypto.Crypto
  >,
) {
  const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
  const runtime = Layer.mergeAll(LoomStore.layer, ProjectServiceLayerLive).pipe(
    Layer.provideMerge(ProjectEnrichmentService.layer),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(
      ProjectFaviconResolver.layer.pipe(
        Layer.provide(WorkspacePaths.layer),
        Layer.provide(T3ProjectFileLoader.layer),
      ),
    ),
    Layer.provideMerge(WorkspacePaths.layer),
    Layer.provideMerge(SqlitePersistence.layerConfig),
    Layer.provide(ServerConfig.layer(config)),
    Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
  );
  yield* Console.log(yield* run.pipe(Effect.provide(runtime)));
});

/** A live project by id or workspace root. */
const resolveProjectId = Effect.fn("goalCli.resolveProject")(function* (identifier: string) {
  const projects = (yield* (yield* ProjectService.ProjectService).snapshot).projects.filter(
    (project) => project.deletedAt === null,
  );
  const trimmed = identifier.trim();
  const root = yield* (yield* WorkspacePaths.WorkspacePaths)
    .normalizeWorkspaceRoot(trimmed)
    .pipe(Effect.orElseSucceed(() => trimmed));
  const project = projects.find((p) => p.id === trimmed || p.workspaceRoot === root);
  return project === undefined
    ? yield* fail(`No active project found for '${identifier}'.`)
    : project.id;
});

const liveGoals = Effect.fn("goalCli.liveGoals")(function* () {
  const projects = (yield* (yield* ProjectService.ProjectService).snapshot).projects;
  const loomStore = yield* store;
  return (yield* Effect.forEach(projects, (project) =>
    loomStore.goals.listByProject(project.id),
  )).flat();
});

/** A live goal by id or (unambiguous) slug. */
const resolveGoal = Effect.fn("goalCli.resolveGoal")(function* (identifier: string) {
  const goals = yield* liveGoals();
  const trimmed = identifier.trim();
  const byId = goals.find((goal) => goal.id === trimmed);
  if (byId !== undefined) return byId;
  const bySlug = goals.filter((goal) => goal.slug === trimmed);
  if (bySlug.length === 1) return bySlug[0]!;
  return yield* fail(
    bySlug.length > 1
      ? `Goal slug '${identifier}' is ambiguous; pass the goal id instead.`
      : `No active goal found for '${identifier}'.`,
  );
});

const countTasks = (goal: LoomGoal) => {
  const tasks = flattenGoalTasks(goal.tasks);
  return `${tasks.filter((task) => task.done).length}/${tasks.length}`;
};

const requireTask = (goal: LoomGoal, taskId: string) => {
  const task = findGoalTask(goal.tasks, GoalTaskId.make(taskId.trim()));
  return task === null
    ? fail(`No task '${taskId}' found in goal '${goal.id}'.`)
    : Effect.succeed(task);
};

const goalArgument = Argument.String("goal").pipe(Argument.withDescription("Goal id or slug."));

const goalListCommand = Command.make("list", {
  ...projectLocationFlags,
  project: Flag.String("project").pipe(
    Flag.withDescription("Filter by project id or workspace root."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("List goals."),
  Command.withHandler((flags) =>
    runGoalCommand(
      flags,
      Effect.gen(function* () {
        const projectId = Option.isSome(flags.project)
          ? yield* resolveProjectId(flags.project.value)
          : null;
        const goals = (yield* liveGoals()).filter(
          (goal) => projectId === null || goal.projectId === projectId,
        );
        return goals.length === 0
          ? "No goals."
          : goals
              .map((goal) => `${goal.id}  ${goal.slug}  ${goal.title}  [${countTasks(goal)}]`)
              .join("\n");
      }),
    ),
  ),
);

const goalShowCommand = Command.make("show", { ...projectLocationFlags, goal: goalArgument }).pipe(
  Command.withDescription("Show a goal and its task tree."),
  Command.withHandler((flags) =>
    runGoalCommand(
      flags,
      Effect.map(
        resolveGoal(flags.goal),
        (goal) =>
          `# ${goal.title} (${goal.id})\nslug: ${goal.slug}  tasks: ${countTasks(goal)}\n\n${goal.description}\n\n${renderTasks(goal.tasks)}`,
      ),
    ),
  ),
);

const goalCreateCommand = Command.make("create", {
  ...projectLocationFlags,
  project: Flag.String("project").pipe(
    Flag.withDescription("Project id or workspace root that owns the goal."),
  ),
  slug: Flag.String("slug").pipe(Flag.withDescription("Stable goal slug.")),
  title: Flag.String("title").pipe(Flag.withDescription("Goal title.")),
  description: Flag.String("description").pipe(
    Flag.withDescription("Goal objective paragraph."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Create a goal."),
  Command.withHandler((flags) =>
    runGoalCommand(
      flags,
      Effect.gen(function* () {
        const projectId = yield* resolveProjectId(flags.project);
        const taken = yield* (yield* store).goals.listByProject(projectId, {
          includeDeleted: true,
        });
        if (taken.some((goal) => goal.slug === flags.slug))
          return yield* fail(`Slug '${flags.slug}' is already used in this project.`);
        const goal = yield* (yield* store).goals.upsert({
          id: GoalId.make(`goal:${yield* uuid}`),
          projectId,
          slug: flags.slug,
          title: flags.title,
          description: Option.getOrElse(flags.description, () => ""),
        });
        return `Created goal ${goal.id} (${goal.slug}).`;
      }),
    ),
  ),
);

const goalUpdateCommand = Command.make("update", {
  ...projectLocationFlags,
  goal: goalArgument,
  title: Flag.String("title").pipe(Flag.withDescription("New goal title."), Flag.optional),
  description: Flag.String("description").pipe(
    Flag.withDescription("New goal objective paragraph."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Update a goal's title/description."),
  Command.withHandler((flags) =>
    runGoalCommand(
      flags,
      Effect.gen(function* () {
        const goal = yield* resolveGoal(flags.goal);
        yield* (yield* store).goals.upsert({
          id: goal.id,
          projectId: goal.projectId,
          slug: goal.slug,
          title: Option.getOrElse(flags.title, () => goal.title),
          description: Option.getOrElse(flags.description, () => goal.description),
        });
        return `Updated goal ${goal.id}.`;
      }),
    ),
  ),
);

const goalTaskAddCommand = Command.make("add", {
  ...projectLocationFlags,
  goal: goalArgument,
  text: Argument.String("text").pipe(Argument.withDescription("Task text.")),
  parent: Flag.String("parent").pipe(Flag.withDescription("Parent task id."), Flag.optional),
}).pipe(
  Command.withDescription("Add a task to a goal."),
  Command.withHandler((flags) =>
    runGoalCommand(
      flags,
      Effect.gen(function* () {
        const goal = yield* resolveGoal(flags.goal);
        const textError = validateGoalTaskText(flags.text);
        if (textError !== undefined) return yield* fail(textError);
        const parent = Option.isSome(flags.parent)
          ? yield* requireTask(goal, flags.parent.value)
          : null;
        const siblings = parent?.children ?? goal.tasks;
        const taskId = GoalTaskId.make(yield* uuid);
        yield* (yield* store).tasks.upsert({
          goalId: goal.id,
          id: taskId,
          parentTaskId: parent?.id ?? null,
          text: flags.text,
          done: false,
          position: Math.max(-1, ...siblings.map((task) => task.position)) + 1,
        });
        return `Added task ${taskId} to goal ${goal.id}.`;
      }),
    ),
  ),
);

const updateTask = (
  flags: CliAuthLocationFlags & { readonly goal: string; readonly task: string },
  change: { readonly text?: string; readonly done?: boolean },
  summary: (taskId: string) => string,
) =>
  runGoalCommand(
    flags,
    Effect.gen(function* () {
      const goal = yield* resolveGoal(flags.goal);
      const task = yield* requireTask(goal, flags.task);
      const textError = change.text === undefined ? undefined : validateGoalTaskText(change.text);
      if (textError !== undefined) return yield* fail(textError);
      yield* (yield* store).tasks.upsert({
        goalId: goal.id,
        id: task.id,
        parentTaskId: task.parentTaskId,
        text: change.text ?? task.text,
        done: change.done ?? task.done,
        position: task.position,
      });
      return summary(task.id);
    }),
  );

const taskArgument = Argument.String("task").pipe(Argument.withDescription("Task id."));

const setTaskDoneCommand = (name: "done" | "open", done: boolean) =>
  Command.make(name, { ...projectLocationFlags, goal: goalArgument, task: taskArgument }).pipe(
    Command.withDescription(done ? "Mark a task done." : "Mark a task open."),
    Command.withHandler((flags) =>
      updateTask(flags, { done }, (taskId) => `Marked task ${taskId} ${name}.`),
    ),
  );

const goalTaskRenameCommand = Command.make("rename", {
  ...projectLocationFlags,
  goal: goalArgument,
  task: taskArgument,
  text: Argument.String("text").pipe(Argument.withDescription("New task text.")),
}).pipe(
  Command.withDescription("Rename a task."),
  Command.withHandler((flags) =>
    updateTask(flags, { text: flags.text }, (taskId) => `Renamed task ${taskId}.`),
  ),
);

/** A whole markdown tree is not a flag value: it arrives as a file or on stdin. */
const readRewriteMarkdown = Effect.fn("goalCli.readRewriteMarkdown")(function* (
  file: Option.Option<string>,
) {
  if (Option.isSome(file))
    return yield* (yield* FileSystem.FileSystem)
      .readFileString(file.value)
      .pipe(
        Effect.mapError(
          (cause) => new GoalCliError({ message: `Could not read '${file.value}': ${cause}.` }),
        ),
      );
  if (process.stdin.isTTY)
    return yield* fail("Pass the markdown task tree with --file <path>, or pipe it on stdin.");
  // Stream stdin: a piped stdin is often non-blocking, and a sync read fails with EAGAIN.
  return yield* Effect.tryPromise({
    try: async () => {
      const chunks: Array<Buffer> = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString("utf8");
    },
    catch: (cause) =>
      new GoalCliError({ message: `Could not read the task tree from stdin: ${cause}.` }),
  });
});

/**
 * Declarative whole-tree replace, the human twin of `mcp__t3-code__goal_tasks_rewrite`: what
 * `t3 goal show` prints goes back in. No branch scoping — that steers agents.
 */
const goalTaskRewriteCommand = Command.make("rewrite", {
  ...projectLocationFlags,
  goal: goalArgument,
  file: Flag.String("file").pipe(
    Flag.withDescription("Markdown checklist file; omit to read stdin."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Replace a goal's whole task tree with a markdown checklist."),
  Command.withHandler((flags) =>
    runGoalCommand(
      flags,
      Effect.gen(function* () {
        const goal = yield* resolveGoal(flags.goal);
        const current = flattenGoalTasks(goal.tasks);
        const parsed = parseGoalTaskMarkdown(
          yield* readRewriteMarkdown(flags.file),
          new Set(current.map((task) => task.id)),
        );
        if ("error" in parsed) return yield* fail(parsed.error);
        const textError = validateGoalTaskRewriteText(parsed.lines, current);
        if (textError !== undefined) return yield* fail(textError);
        const minted = yield* Effect.forEach(
          parsed.lines.filter((line) => line.taskId === null),
          () => uuid,
        );
        const { tasks, summary, changed } = resolveGoalTaskRewrite({
          lines: parsed.lines,
          current,
          mintTaskId: () => GoalTaskId.make(minted.shift()!),
        });
        const tree = changed ? yield* (yield* store).tasks.replaceTree(goal.id, tasks) : goal.tasks;
        return `${summary}\n\n${renderTasks(tree)}`;
      }),
    ),
  ),
);

export const goalCommand = Command.make("goal").pipe(
  Command.withDescription("Manage Loom goals and their task trees."),
  Command.withSubcommands([
    goalListCommand,
    goalShowCommand,
    goalCreateCommand,
    goalUpdateCommand,
    Command.make("task").pipe(
      Command.withDescription("Manage goal tasks."),
      Command.withSubcommands([
        goalTaskAddCommand,
        setTaskDoneCommand("done", true),
        setTaskDoneCommand("open", false),
        goalTaskRenameCommand,
        goalTaskRewriteCommand,
      ]),
    ),
  ]),
);
