import {
  CommandId,
  ModelSelection,
  ThreadId,
  ThreadStatus,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

interface WorkstreamSpawnRequest {
  readonly role?: unknown;
  readonly purpose?: unknown;
  readonly brief?: unknown;
  readonly title?: unknown;
  readonly blockedBy?: unknown;
  readonly modelSelection?: unknown;
}

interface WorkstreamStatusRequest {
  readonly threadId?: unknown;
  readonly status?: unknown;
}

interface WorkstreamDependenciesRequest {
  readonly threadId?: unknown;
  readonly blockedBy?: unknown;
}

const SPAWN_PATH = "/provider-tools/workstream/spawn";
const STATUS_PATH = "/provider-tools/workstream/status";
const DEPENDENCIES_PATH = "/provider-tools/workstream/dependencies";

const VALID_STATUSES = new Set<ThreadStatus>(ThreadStatus.literals);

const jsonError = (status: number, message: string) =>
  HttpServerResponse.jsonUnsafe({ message }, { status });

const trimString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

/** Resolve the bearer token to a Workstream-capable scope, or undefined. */
const resolveWorkstreamScope = Effect.fn("WorkstreamHttp.resolveScope")(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const token = request.headers.authorization?.startsWith("Bearer ")
    ? request.headers.authorization.slice("Bearer ".length).trim()
    : "";
  const scope = yield* McpSessionRegistry.resolveActiveMcpCredential(token);
  return scope && scope.capabilities.has("workstream") ? scope : undefined;
});

/**
 * D3 authorisation: a credential may mutate status/deps only on its OWN thread
 * or a thread it directly parents. Returns an error response when the target is
 * missing or out of scope, otherwise undefined (authorised).
 */
const authorizationError = Effect.fn("WorkstreamHttp.authorize")(function* (
  scopeThreadId: ThreadId,
  targetThreadId: ThreadId,
) {
  if (targetThreadId === scopeThreadId) return undefined;
  const projection = yield* ProjectionSnapshotQuery;
  const target = yield* projection.getThreadDetailById(targetThreadId);
  if (Option.isNone(target)) return jsonError(404, "Target thread was not found.");
  return target.value.parentThreadId === scopeThreadId
    ? undefined
    : jsonError(
        403,
        "Credential may only set status/dependencies on its own thread or a thread it directly parents.",
      );
});

const decodeModelSelection = Schema.decodeUnknownEffect(ModelSelection);

const workstreamUrlFromMcpEndpoint = (mcpEndpoint: string, path: string): string =>
  mcpEndpoint.endsWith("/mcp")
    ? `${mcpEndpoint.slice(0, -"/mcp".length)}${path}`
    : `${mcpEndpoint.replace(/\/$/, "")}${path}`;

export const workstreamSpawnUrlFromMcpEndpoint = (mcpEndpoint: string): string =>
  workstreamUrlFromMcpEndpoint(mcpEndpoint, SPAWN_PATH);

export const workstreamStatusUrlFromMcpEndpoint = (mcpEndpoint: string): string =>
  workstreamUrlFromMcpEndpoint(mcpEndpoint, STATUS_PATH);

export const workstreamDependenciesUrlFromMcpEndpoint = (mcpEndpoint: string): string =>
  workstreamUrlFromMcpEndpoint(mcpEndpoint, DEPENDENCIES_PATH);

const handleWorkstreamSpawn = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const scope = yield* resolveWorkstreamScope();
  if (!scope) {
    return jsonError(401, "A valid provider-scoped Workstream credential is required.");
  }

  const body = (yield* request.json.pipe(
    Effect.orElseSucceed((): WorkstreamSpawnRequest => ({})),
  )) as WorkstreamSpawnRequest;
  const role = trimString(body.role);
  const purpose = trimString(body.purpose);
  const brief = trimString(body.brief);
  const title = trimString(body.title) ?? purpose;
  if (!role) return jsonError(400, "role is required.");
  if (!purpose) return jsonError(400, "purpose is required.");
  if (!title) return jsonError(400, "title is required.");
  if (
    body.blockedBy !== undefined &&
    (!Array.isArray(body.blockedBy) || !body.blockedBy.every((id) => trimString(id)))
  ) {
    return jsonError(400, "blockedBy must be an array of non-empty thread id strings.");
  }

  const projection = yield* ProjectionSnapshotQuery;
  const parent = yield* projection.getThreadDetailById(scope.threadId);
  if (Option.isNone(parent)) {
    return jsonError(404, "Current provider thread was not found.");
  }
  const current = parent.value;

  // Model + thinking are intrinsic node config: honour an explicit selection,
  // otherwise inherit the parent's. Invalid selections fail visibly as 400.
  const modelSelection =
    body.modelSelection === undefined
      ? Option.some(current.modelSelection)
      : yield* decodeModelSelection(body.modelSelection).pipe(
          Effect.map(Option.some),
          Effect.orElseSucceed(() => Option.none<ModelSelection>()),
        );
  if (Option.isNone(modelSelection)) {
    return jsonError(400, "modelSelection is invalid.");
  }

  // Trim before branding: ThreadId.make("") throws a defect that escapes the
  // typed Effect.catch, and untrimmed ids silently become dangling deps.
  const blockedBy = Array.isArray(body.blockedBy)
    ? body.blockedBy.map((id) => ThreadId.make((id as string).trim()))
    : undefined;

  const crypto = yield* Crypto.Crypto;
  const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const childThreadId = ThreadId.make(yield* crypto.randomUUIDv4);

  // Create-only: the WorkstreamDispatcher is the sole start authority and fires
  // the deferred kick-off turn once every `blockedBy` thread reaches `done`.
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make(
      `server:workstream-spawn:create-thread:${yield* crypto.randomUUIDv4}`,
    ),
    threadId: childThreadId,
    projectId: current.projectId,
    goalId: current.goalId ?? null,
    parentThreadId: scope.threadId,
    role,
    purpose,
    ...(brief !== undefined ? { brief } : {}),
    ...(blockedBy !== undefined ? { blockedBy } : {}),
    title,
    modelSelection: modelSelection.value,
    runtimeMode: current.runtimeMode,
    interactionMode: current.interactionMode,
    branch: current.branch,
    worktreePath: current.worktreePath,
    createdAt: now,
  } satisfies OrchestrationCommand);

  return HttpServerResponse.jsonUnsafe({ childThreadId, parentThreadId: scope.threadId, title });
}).pipe(
  Effect.catch((error: unknown) =>
    Effect.succeed(
      jsonError(
        500,
        error instanceof Error ? error.message : "Failed to spawn Workstream sub-thread.",
      ),
    ),
  ),
);

const handleWorkstreamSetStatus = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const scope = yield* resolveWorkstreamScope();
  if (!scope) {
    return jsonError(401, "A valid provider-scoped Workstream credential is required.");
  }

  const body = (yield* request.json.pipe(
    Effect.orElseSucceed((): WorkstreamStatusRequest => ({})),
  )) as WorkstreamStatusRequest;
  const threadId = trimString(body.threadId);
  const status = trimString(body.status);
  if (!status || !VALID_STATUSES.has(status as ThreadStatus)) {
    return jsonError(400, `status must be one of: ${ThreadStatus.literals.join(", ")}.`);
  }

  // Missing threadId defaults to the caller's own thread (always authorised).
  const targetThreadId = threadId ? ThreadId.make(threadId) : scope.threadId;
  const denied = yield* authorizationError(scope.threadId, targetThreadId);
  if (denied) return denied;

  const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "thread.status.set",
    commandId: CommandId.make(`server:workstream-status:${yield* crypto.randomUUIDv4}`),
    threadId: targetThreadId,
    status: status as ThreadStatus,
    createdAt: now,
  } satisfies OrchestrationCommand);

  return HttpServerResponse.jsonUnsafe({ threadId: targetThreadId, status });
}).pipe(
  Effect.catch((error: unknown) =>
    Effect.succeed(
      jsonError(500, error instanceof Error ? error.message : "Failed to set Workstream status."),
    ),
  ),
);

const handleWorkstreamSetDependencies = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const scope = yield* resolveWorkstreamScope();
  if (!scope) {
    return jsonError(401, "A valid provider-scoped Workstream credential is required.");
  }

  const body = (yield* request.json.pipe(
    Effect.orElseSucceed((): WorkstreamDependenciesRequest => ({})),
  )) as WorkstreamDependenciesRequest;
  const threadId = trimString(body.threadId);
  if (!Array.isArray(body.blockedBy) || !body.blockedBy.every((id) => trimString(id))) {
    return jsonError(400, "blockedBy must be an array of non-empty thread id strings.");
  }

  // Missing threadId defaults to the caller's own thread (always authorised).
  const targetThreadId = threadId ? ThreadId.make(threadId) : scope.threadId;
  const denied = yield* authorizationError(scope.threadId, targetThreadId);
  if (denied) return denied;

  // Trim before branding: ThreadId.make("") throws a defect that escapes the
  // typed Effect.catch, and untrimmed ids silently become dangling deps.
  const blockedBy = body.blockedBy.map((id) => ThreadId.make((id as string).trim()));
  const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "thread.dependencies.set",
    commandId: CommandId.make(`server:workstream-dependencies:${yield* crypto.randomUUIDv4}`),
    threadId: targetThreadId,
    blockedBy,
    createdAt: now,
  } satisfies OrchestrationCommand);

  return HttpServerResponse.jsonUnsafe({ threadId: targetThreadId, blockedBy });
}).pipe(
  Effect.catch((error: unknown) =>
    Effect.succeed(
      jsonError(
        500,
        error instanceof Error ? error.message : "Failed to set Workstream dependencies.",
      ),
    ),
  ),
);

export const workstreamSpawnRouteLayer = HttpRouter.add("POST", SPAWN_PATH, handleWorkstreamSpawn);
export const workstreamStatusRouteLayer = HttpRouter.add(
  "POST",
  STATUS_PATH,
  handleWorkstreamSetStatus,
);
export const workstreamDependenciesRouteLayer = HttpRouter.add(
  "POST",
  DEPENDENCIES_PATH,
  handleWorkstreamSetDependencies,
);

export const layer = Layer.mergeAll(
  workstreamSpawnRouteLayer,
  workstreamStatusRouteLayer,
  workstreamDependenciesRouteLayer,
);
