import {
  CommandId,
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
  buildGoalTaskDeleteCommand,
  buildGoalTaskUpdateCommand,
} from "../orchestration/goalTaskCommands.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

interface GoalTaskAddRequest {
  readonly text?: unknown;
  readonly parentTaskId?: unknown;
  readonly position?: unknown;
}

interface GoalTaskUpdateRequest {
  readonly taskId?: unknown;
  readonly text?: unknown;
  readonly done?: unknown;
  readonly position?: unknown;
}

interface GoalTaskDeleteRequest {
  readonly taskId?: unknown;
}

interface GoalUpdateRequest {
  readonly title?: unknown;
  readonly description?: unknown;
  readonly slug?: unknown;
}

const TASK_ADD_PATH = "/provider-tools/goal/task/add";
const TASK_UPDATE_PATH = "/provider-tools/goal/task/update";
const TASK_DELETE_PATH = "/provider-tools/goal/task/delete";
const GOAL_UPDATE_PATH = "/provider-tools/goal/update";

const jsonError = (status: number, message: string) =>
  HttpServerResponse.jsonUnsafe({ message }, { status });

const trimString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const nonNegativeInt = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

/** Resolve the bearer token to a Workstream-capable scope (the same per-session
 * credential the workstream tools use), or undefined. */
const resolveGoalScope = Effect.fn("GoalTaskHttp.resolveScope")(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const token = request.headers.authorization?.startsWith("Bearer ")
    ? request.headers.authorization.slice("Bearer ".length).trim()
    : "";
  const scope = yield* McpSessionRegistry.resolveActiveMcpCredential(token);
  return scope && scope.capabilities.has("workstream") ? scope : undefined;
});

const allTaskIds = (tasks: ReadonlyArray<OrchestrationGoalTask>): Set<string> => {
  const ids = new Set<string>();
  const stack: OrchestrationGoalTask[] = [...tasks];
  while (stack.length > 0) {
    const task = stack.pop()!;
    ids.add(task.id);
    stack.push(...task.children);
  }
  return ids;
};

/**
 * Resolve the caller thread → its active goal (with the full task tree, so
 * task-membership can be validated). The agent never passes a goalId: acting on
 * an arbitrary goal is structurally impossible. A thread with no goal, or whose
 * goal was deleted, yields a clean error response.
 */
const resolveActiveGoal = Effect.fn("GoalTaskHttp.resolveActiveGoal")(function* () {
  const scope = yield* resolveGoalScope();
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
  const snapshot = yield* projection.getSnapshot();
  const goal = snapshot.goals.find((g) => g.id === goalId && g.deletedAt === null);
  if (!goal) return { error: jsonError(404, "This thread's active goal was not found.") };
  return { goal };
});

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
  const position = body.position === undefined ? undefined : nonNegativeInt(body.position);
  if (body.position !== undefined && position === undefined) {
    return jsonError(400, "position must be a non-negative integer.");
  }

  let parentTaskId: GoalTaskId | null = null;
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
      ...(position !== undefined ? { position } : {}),
      createdAt: now,
    }) satisfies OrchestrationCommand,
  );
  return HttpServerResponse.jsonUnsafe({ goalId: goal.id, taskId });
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
  const text = body.text === undefined ? undefined : trimString(body.text);
  if (body.text !== undefined && text === undefined) {
    return jsonError(400, "text must be a non-empty string.");
  }
  const done = typeof body.done === "boolean" ? body.done : undefined;
  if (body.done !== undefined && done === undefined) {
    return jsonError(400, "done must be a boolean.");
  }
  const position = body.position === undefined ? undefined : nonNegativeInt(body.position);
  if (body.position !== undefined && position === undefined) {
    return jsonError(400, "position must be a non-negative integer.");
  }
  if (text === undefined && done === undefined && position === undefined) {
    return jsonError(400, "Provide at least one of text, done, or position.");
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
      ...(position !== undefined ? { position } : {}),
    }) satisfies OrchestrationCommand,
  );
  return HttpServerResponse.jsonUnsafe({ goalId: goal.id, taskId });
}).pipe(
  Effect.catch((error: unknown) =>
    Effect.succeed(
      jsonError(500, error instanceof Error ? error.message : "Failed to update the task."),
    ),
  ),
);

const handleGoalTaskDelete = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const resolved = yield* resolveActiveGoal();
  if ("error" in resolved) return resolved.error;
  const goal: OrchestrationGoal = resolved.goal;

  const body = (yield* request.json.pipe(
    Effect.orElseSucceed((): GoalTaskDeleteRequest => ({})),
  )) as GoalTaskDeleteRequest;
  const taskId = trimString(body.taskId);
  if (!taskId) return jsonError(400, "taskId is required.");
  if (!allTaskIds(goal.tasks).has(taskId)) {
    return jsonError(400, `taskId "${taskId}" is not a task in this goal.`);
  }

  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch(
    buildGoalTaskDeleteCommand({
      commandId: CommandId.make(`server:goal-task-delete:${yield* crypto.randomUUIDv4}`),
      goalId: goal.id,
      taskId: GoalTaskId.make(taskId),
    }) satisfies OrchestrationCommand,
  );
  return HttpServerResponse.jsonUnsafe({ goalId: goal.id, taskId });
}).pipe(
  Effect.catch((error: unknown) =>
    Effect.succeed(
      jsonError(500, error instanceof Error ? error.message : "Failed to delete the task."),
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
  return HttpServerResponse.jsonUnsafe({ goalId: goal.id });
}).pipe(
  Effect.catch((error: unknown) =>
    Effect.succeed(
      jsonError(500, error instanceof Error ? error.message : "Failed to update the goal."),
    ),
  ),
);

const goalToolUrlFromMcpEndpoint = (mcpEndpoint: string, path: string): string =>
  mcpEndpoint.endsWith("/mcp")
    ? `${mcpEndpoint.slice(0, -"/mcp".length)}${path}`
    : `${mcpEndpoint.replace(/\/$/, "")}${path}`;

export const goalTaskAddUrlFromMcpEndpoint = (mcpEndpoint: string): string =>
  goalToolUrlFromMcpEndpoint(mcpEndpoint, TASK_ADD_PATH);

export const goalTaskUpdateUrlFromMcpEndpoint = (mcpEndpoint: string): string =>
  goalToolUrlFromMcpEndpoint(mcpEndpoint, TASK_UPDATE_PATH);

export const goalTaskDeleteUrlFromMcpEndpoint = (mcpEndpoint: string): string =>
  goalToolUrlFromMcpEndpoint(mcpEndpoint, TASK_DELETE_PATH);

export const goalUpdateUrlFromMcpEndpoint = (mcpEndpoint: string): string =>
  goalToolUrlFromMcpEndpoint(mcpEndpoint, GOAL_UPDATE_PATH);

export const layer = Layer.mergeAll(
  HttpRouter.add("POST", TASK_ADD_PATH, handleGoalTaskAdd),
  HttpRouter.add("POST", TASK_UPDATE_PATH, handleGoalTaskUpdate),
  HttpRouter.add("POST", TASK_DELETE_PATH, handleGoalTaskDelete),
  HttpRouter.add("POST", GOAL_UPDATE_PATH, handleGoalUpdate),
);
