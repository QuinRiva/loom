import {
  CommandId,
  type GoalId,
  GoalTaskId,
  type OrchestrationCommand,
  type OrchestrationGoal,
  type OrchestrationGoalTask,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import {
  buildGoalMetaUpdateCommand,
  buildGoalTaskCreateCommand,
  buildGoalTasksRewriteCommand,
  buildGoalTaskUpdateCommand,
} from "../orchestration/goalTaskCommands.ts";
import {
  parseGoalTaskMarkdown,
  resolveGoalTaskRewrite,
  validateGoalTaskRewriteText,
  validateGoalTaskText,
} from "../orchestration/goalTaskMarkdown.ts";
import {
  composeBranchRewrite,
  goalTaskSpine,
  isWithinGoalTaskBranch,
  resolveThreadAnchor,
} from "../orchestration/goalTaskAnchor.loom.ts";
import {
  renderGoalTaskBranch,
  renderGoalTaskEcho,
  renderGoalTaskTree,
  toGoalTaskNodes,
} from "../orchestration/goalTaskRender.ts";
import { flattenGoalTasks } from "../orchestration/goalTaskTree.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { resolveWorkstreamScope } from "./httpScope.ts";
import { PROVIDER_TOOL_PATHS } from "./toolPaths.ts";

interface GoalTaskAddRequest {
  readonly text?: unknown;
  readonly parentTaskId?: unknown;
}

interface GoalTaskListRequest {
  readonly scope?: unknown;
}

interface GoalTasksRewriteRequest {
  readonly markdown?: unknown;
}

interface GoalTaskUpdateRequest {
  readonly taskId?: unknown;
  readonly text?: unknown;
  readonly done?: unknown;
}

interface GoalUpdateRequest {
  readonly title?: unknown;
  readonly description?: unknown;
  readonly slug?: unknown;
}

const jsonError = (status: number, message: string) =>
  HttpServerResponse.jsonUnsafe({ message }, { status });

const trimString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

/** The canonical `- [x] text (id)` read format, shared by every goal-task surface. */
const renderTasks = (tasks: ReadonlyArray<OrchestrationGoalTask>): string =>
  tasks.length === 0 ? "(no tasks yet)" : renderGoalTaskTree(tasks).trimEnd();

/**
 * Every mutating tool answers with the resulting tree, not "Added task <id>":
 * the agent sees the shape it is accreting at the moment it mutates, and gets
 * the ids a follow-up rewrite needs without a read round-trip. Dispatch commits
 * the sqlite projection inside its own transaction, so this re-read is the
 * post-command tree; `renderGoalTaskEcho` scopes it to what the caller owns.
 */
const echoTree = Effect.fn("GoalTaskHttp.echoTree")(function* (input: {
  readonly goalId: GoalId;
  readonly summary: string;
  readonly anchorTaskId: GoalTaskId | null;
  readonly isChild: boolean;
  readonly placedTaskId?: GoalTaskId;
}) {
  const goal = yield* (yield* ProjectionSnapshotQuery).getGoalById(input.goalId);
  return renderGoalTaskEcho({ ...input, tasks: Option.isNone(goal) ? [] : goal.value.tasks });
});

const allTaskIds = (tasks: ReadonlyArray<OrchestrationGoalTask>): Set<string> =>
  new Set(flattenGoalTasks(tasks).map((task) => task.id as string));

/**
 * Resolve the caller thread → its active goal (with the full task tree, so
 * task-membership can be validated). The agent never passes a goalId: acting on
 * an arbitrary goal is structurally impossible. A thread with no goal, or whose
 * goal was deleted, yields a clean error response.
 */
const resolveActiveGoal = Effect.fn("GoalTaskHttp.resolveActiveGoal")(function* () {
  const scope = yield* resolveWorkstreamScope();
  if (!scope) {
    return { error: jsonError(401, "A valid provider-scoped Workstream credential is required.") };
  }
  const projection = yield* ProjectionSnapshotQuery;
  const thread = yield* projection.getThreadDetailById(scope.threadId);
  if (Option.isNone(thread)) {
    return { error: jsonError(404, "Current provider thread was not found.") };
  }
  const goalId = thread.value.goalId;
  if (goalId === null) {
    return {
      error: jsonError(400, "This thread has no active goal, so there is no task tree to mutate."),
    };
  }
  const goal = yield* projection.getGoalById(goalId);
  if (Option.isNone(goal)) {
    return { error: jsonError(404, "This thread's active goal was not found.") };
  }
  return { goal: goal.value, thread: thread.value };
});

/**
 * A bound thread reads its BRANCH by default (spine as read-only context, then
 * the branch as the complete rewrite source); `scope: "tree"` returns the whole
 * goal, which is what an unbound thread and the root always get — and the sole
 * complete rewrite source for the root.
 */
const handleGoalTaskList = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const resolved = yield* resolveActiveGoal();
  if ("error" in resolved) return resolved.error;
  const goal: OrchestrationGoal = resolved.goal;
  const body = (yield* request.json.pipe(
    Effect.orElseSucceed((): GoalTaskListRequest => ({})),
  )) as GoalTaskListRequest;
  const anchor =
    trimString(body.scope) === "tree"
      ? null
      : resolveThreadAnchor(goal.tasks, resolved.thread.anchorTaskId);
  return HttpServerResponse.jsonUnsafe({
    goalId: goal.id,
    title: goal.title,
    rendered:
      anchor === null
        ? renderTasks(goal.tasks)
        : renderGoalTaskBranch(anchor, goalTaskSpine(goal.tasks, anchor.id)),
    tasks: toGoalTaskNodes(anchor === null ? goal.tasks : [anchor]),
  });
}).pipe(
  Effect.catch((error: unknown) =>
    Effect.succeed(
      jsonError(500, error instanceof Error ? error.message : "Failed to read the task tree."),
    ),
  ),
);

const handleGoalTaskAdd = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const resolved = yield* resolveActiveGoal();
  if ("error" in resolved) return resolved.error;
  const goal: OrchestrationGoal = resolved.goal;

  const body = (yield* request.json.pipe(
    Effect.orElseSucceed((): GoalTaskAddRequest => ({})),
  )) as GoalTaskAddRequest;
  const text = trimString(body.text);
  if (!text) return jsonError(400, "text is required.");
  const textError = validateGoalTaskText(text);
  if (textError) return jsonError(400, textError);

  // A bound thread's adds land in its own branch unless it says otherwise; any
  // task of the goal stays a legal explicit target, so discovered work can be
  // recorded where it belongs (the echo then shows where it landed).
  const anchor = resolveThreadAnchor(goal.tasks, resolved.thread.anchorTaskId);
  let parentTaskId: GoalTaskId | null = anchor?.id ?? null;
  const parent = trimString(body.parentTaskId);
  if (parent) {
    if (!allTaskIds(goal.tasks).has(parent)) {
      return jsonError(400, `parentTaskId "${parent}" is not a task in this goal.`);
    }
    parentTaskId = GoalTaskId.make(parent);
  }

  const crypto = yield* Crypto.Crypto;
  const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const taskId = GoalTaskId.make(yield* crypto.randomUUIDv4);
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch(
    buildGoalTaskCreateCommand({
      commandId: CommandId.make(`server:goal-task-add:${yield* crypto.randomUUIDv4}`),
      goalId: goal.id,
      taskId,
      parentTaskId,
      text,
      createdAt: now,
    }) satisfies OrchestrationCommand,
  );
  return HttpServerResponse.jsonUnsafe({
    goalId: goal.id,
    taskId,
    rendered: yield* echoTree({
      goalId: goal.id,
      summary: `Added task ${taskId}: ${text}`,
      anchorTaskId: resolved.thread.anchorTaskId,
      isChild: resolved.thread.parentThreadId !== null,
      placedTaskId: taskId,
    }),
  });
}).pipe(
  Effect.catch((error: unknown) =>
    Effect.succeed(
      jsonError(500, error instanceof Error ? error.message : "Failed to add the task."),
    ),
  ),
);

const handleGoalTaskUpdate = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const resolved = yield* resolveActiveGoal();
  if ("error" in resolved) return resolved.error;
  const goal: OrchestrationGoal = resolved.goal;

  const body = (yield* request.json.pipe(
    Effect.orElseSucceed((): GoalTaskUpdateRequest => ({})),
  )) as GoalTaskUpdateRequest;
  const taskId = trimString(body.taskId);
  if (!taskId) return jsonError(400, "taskId is required.");
  if (!allTaskIds(goal.tasks).has(taskId)) {
    return jsonError(400, `taskId "${taskId}" is not a task in this goal.`);
  }
  // Ticking a sibling thread's task is the misfire branch scoping prevents.
  const anchor = resolveThreadAnchor(goal.tasks, resolved.thread.anchorTaskId);
  if (anchor !== null && !isWithinGoalTaskBranch(anchor, GoalTaskId.make(taskId))) {
    return jsonError(
      403,
      `Task ${taskId} is outside the branch you own, rooted at your anchor "${anchor.text}" (${anchor.id}) — only the thread that owns a task ticks or renames it. Record discovered work with goal_task_add instead (it lands in your branch by default; pass a parentTaskId to place it elsewhere), and say what needs doing to that task in your report, or ask its thread with consult_thread.`,
    );
  }
  const text = body.text === undefined ? undefined : trimString(body.text);
  if (body.text !== undefined && text === undefined) {
    return jsonError(400, "text must be a non-empty string.");
  }
  const textError = text === undefined ? undefined : validateGoalTaskText(text);
  if (textError) return jsonError(400, textError);
  const done = typeof body.done === "boolean" ? body.done : undefined;
  if (body.done !== undefined && done === undefined) {
    return jsonError(400, "done must be a boolean.");
  }
  if (text === undefined && done === undefined) {
    return jsonError(400, "Provide at least one of text or done.");
  }

  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch(
    buildGoalTaskUpdateCommand({
      commandId: CommandId.make(`server:goal-task-update:${yield* crypto.randomUUIDv4}`),
      goalId: goal.id,
      taskId: GoalTaskId.make(taskId),
      ...(text !== undefined ? { text } : {}),
      ...(done !== undefined ? { done } : {}),
    }) satisfies OrchestrationCommand,
  );
  return HttpServerResponse.jsonUnsafe({
    goalId: goal.id,
    taskId,
    rendered: yield* echoTree({
      goalId: goal.id,
      summary: `Updated task ${taskId}.`,
      anchorTaskId: resolved.thread.anchorTaskId,
      isChild: resolved.thread.parentThreadId !== null,
    }),
  });
}).pipe(
  Effect.catch((error: unknown) =>
    Effect.succeed(
      jsonError(500, error instanceof Error ? error.message : "Failed to update the task."),
    ),
  ),
);

/**
 * Declarative replace: the submitted markdown IS the resulting tree — the whole
 * tree for the root, and for a BOUND thread its own branch, spliced in place
 * (plans/task-tree-branch-scoping). All-or-nothing: the whole submission is
 * parsed, scoped and resolved before a single command is dispatched. Ownership
 * of shape is "the root owns the tree, a bound thread owns its branch's
 * interior", so an unbound child is still refused outright; the check can only
 * live at this edge, since the command carries no thread identity.
 */
const handleGoalTasksRewrite = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const resolved = yield* resolveActiveGoal();
  if ("error" in resolved) return resolved.error;
  const goal: OrchestrationGoal = resolved.goal;

  const anchor = resolveThreadAnchor(goal.tasks, resolved.thread.anchorTaskId);
  if (resolved.thread.parentThreadId !== null && anchor === null) {
    return jsonError(
      403,
      "Rewrites are scoped to what a thread owns: the whole tree belongs to the thread that owns the goal, and a child may rewrite only the branch it is anchored to — this thread has a parent and no anchor. Use goal_task_add to record discovered work (nested under the relevant parent task) and goal_task_update to mark your own task done; ask your orchestrator if the tree's shape needs restructuring.",
    );
  }

  const body = (yield* request.json.pipe(
    Effect.orElseSucceed((): GoalTasksRewriteRequest => ({})),
  )) as GoalTasksRewriteRequest;
  if (typeof body.markdown !== "string") return jsonError(400, "markdown is required.");

  const parsed = parseGoalTaskMarkdown(body.markdown, allTaskIds(goal.tasks));
  if ("error" in parsed) return jsonError(400, parsed.error);
  const current = flattenGoalTasks(goal.tasks);
  // Line numbers in this error name the SUBMITTED lines, so validate before a
  // branch submission is spliced into the rest of the tree.
  const textError = validateGoalTaskRewriteText(parsed.lines, current);
  if (textError) return jsonError(400, textError);
  const scoped =
    anchor === null
      ? { lines: parsed.lines }
      : composeBranchRewrite({ submitted: parsed.lines, tasks: goal.tasks, anchor });
  if ("error" in scoped) return jsonError(400, scoped.error);

  const crypto = yield* Crypto.Crypto;
  const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  // One id per line that carries none; the rest keep their identity.
  const minted = (yield* Effect.forEach(
    scoped.lines.filter((line) => line.taskId === null),
    () => crypto.randomUUIDv4,
  ))[Symbol.iterator]();
  const { tasks, summary, changed } = resolveGoalTaskRewrite({
    lines: scoped.lines,
    current,
    mintTaskId: () => GoalTaskId.make(minted.next().value!),
    now,
  });

  // A verbatim resubmission is genuinely a no-op: no event, no `updatedAt`
  // churn on every task, no 16 KB payload on the log.
  if (changed) {
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch(
      buildGoalTasksRewriteCommand({
        commandId: CommandId.make(`server:goal-tasks-rewrite:${yield* crypto.randomUUIDv4}`),
        goalId: goal.id,
        tasks,
        createdAt: now,
      }) satisfies OrchestrationCommand,
    );
  }
  return HttpServerResponse.jsonUnsafe({
    goalId: goal.id,
    rendered: yield* echoTree({
      goalId: goal.id,
      summary,
      anchorTaskId: resolved.thread.anchorTaskId,
      isChild: resolved.thread.parentThreadId !== null,
    }),
  });
}).pipe(
  Effect.catch((error: unknown) =>
    Effect.succeed(
      jsonError(500, error instanceof Error ? error.message : "Failed to rewrite the task tree."),
    ),
  ),
);

const handleGoalUpdate = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const resolved = yield* resolveActiveGoal();
  if ("error" in resolved) return resolved.error;
  const goal: OrchestrationGoal = resolved.goal;

  const body = (yield* request.json.pipe(
    Effect.orElseSucceed((): GoalUpdateRequest => ({})),
  )) as GoalUpdateRequest;
  const title = body.title === undefined ? undefined : trimString(body.title);
  if (body.title !== undefined && title === undefined) {
    return jsonError(400, "title must be a non-empty string.");
  }
  const slug = body.slug === undefined ? undefined : trimString(body.slug);
  if (body.slug !== undefined && slug === undefined) {
    return jsonError(400, "slug must be a non-empty string.");
  }
  // description may be set to empty (clearing the objective paragraph).
  const description = typeof body.description === "string" ? body.description : undefined;
  if (title === undefined && slug === undefined && description === undefined) {
    return jsonError(400, "Provide at least one of title, description, or slug.");
  }

  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch(
    buildGoalMetaUpdateCommand({
      commandId: CommandId.make(`server:goal-update:${yield* crypto.randomUUIDv4}`),
      goalId: goal.id,
      ...(slug !== undefined ? { slug } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(description !== undefined ? { description } : {}),
    }) satisfies OrchestrationCommand,
  );
  return HttpServerResponse.jsonUnsafe({
    goalId: goal.id,
    rendered: `Updated goal ${goal.id}.`,
  });
}).pipe(
  Effect.catch((error: unknown) =>
    Effect.succeed(
      jsonError(500, error instanceof Error ? error.message : "Failed to update the goal."),
    ),
  ),
);

export const layer = Layer.mergeAll(
  HttpRouter.add("POST", PROVIDER_TOOL_PATHS.goal_task_list, handleGoalTaskList),
  HttpRouter.add("POST", PROVIDER_TOOL_PATHS.goal_task_add, handleGoalTaskAdd),
  HttpRouter.add("POST", PROVIDER_TOOL_PATHS.goal_task_update, handleGoalTaskUpdate),
  HttpRouter.add("POST", PROVIDER_TOOL_PATHS.goal_tasks_rewrite, handleGoalTasksRewrite),
  HttpRouter.add("POST", PROVIDER_TOOL_PATHS.goal_update, handleGoalUpdate),
);
