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

import { graphViewFor, isInSameTree } from "@t3tools/shared/workstreamGraph";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { askWorkstreamThread } from "../orchestration/workstreamAsk.ts";
import { readWorkstreamReport, writeWorkstreamReport } from "../orchestration/workstreamReport.ts";
import { piSessionIdForThread } from "../provider/Layers/Pi/Cli.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

interface WorkstreamSpawnRequest {
  readonly role?: unknown;
  readonly purpose?: unknown;
  readonly brief?: unknown;
  readonly title?: unknown;
  readonly blockedBy?: unknown;
  readonly modelSelection?: unknown;
  readonly modelPreset?: unknown;
}

interface WorkstreamStatusRequest {
  readonly threadId?: unknown;
  readonly status?: unknown;
}

interface WorkstreamDependenciesRequest {
  readonly threadId?: unknown;
  readonly blockedBy?: unknown;
}

interface WorkstreamReportRequest {
  readonly markdown?: unknown;
}

interface WorkstreamReadThreadRequest {
  readonly threadId?: unknown;
}

interface WorkstreamAskThreadRequest {
  readonly threadId?: unknown;
  readonly question?: unknown;
}

const SPAWN_PATH = "/provider-tools/workstream/spawn";
const STATUS_PATH = "/provider-tools/workstream/status";
const DEPENDENCIES_PATH = "/provider-tools/workstream/dependencies";
const REPORT_PATH = "/provider-tools/workstream/report";
const LIST_PATH = "/provider-tools/workstream/list";
const READ_THREAD_PATH = "/provider-tools/workstream/read-thread";
const ASK_THREAD_PATH = "/provider-tools/workstream/ask-thread";

// Server-side guard on a single fork turn (forking handles transcript size, so
// only the turn duration and the question length need bounding).
const ASK_TIMEOUT_MS = 120_000;
const ASK_QUESTION_MAX_CHARS = 8_000;
const READ_ACTIVITY_LIMIT = 3;
const READ_MESSAGE_EXCERPT_LIMIT = 800;

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

/**
 * Resolution of a child's model selection when no explicit `modelSelection` was
 * supplied (steps 2–4 of the spawn precedence). An explicit, decoded selection
 * always wins and is handled in the caller before this runs.
 */
export type PresetResolution =
  | { readonly kind: "selection"; readonly selection: ModelSelection }
  | {
      readonly kind: "unknown-preset";
      readonly modelPreset: string;
      readonly available: ReadonlyArray<string>;
    };

/**
 * Named-preset / role-default resolution against a single keyed map:
 *   2. `modelPreset` present → the named preset, or an unknown-preset error.
 *   3. else a preset keyed by `role` → use it.
 *   4. else inherit the parent's selection.
 */
export const resolvePresetSelection = (input: {
  readonly presets: Record<string, ModelSelection>;
  readonly modelPreset: string | undefined;
  readonly role: string;
  readonly parentSelection: ModelSelection;
}): PresetResolution => {
  if (input.modelPreset !== undefined) {
    const preset = input.presets[input.modelPreset];
    return preset === undefined
      ? {
          kind: "unknown-preset",
          modelPreset: input.modelPreset,
          available: Object.keys(input.presets),
        }
      : { kind: "selection", selection: preset };
  }
  return { kind: "selection", selection: input.presets[input.role] ?? input.parentSelection };
};

const unknownPresetMessage = (name: string, available: ReadonlyArray<string>): string =>
  `Unknown modelPreset "${name}". Available presets: ${
    available.length > 0 ? available.join(", ") : "none configured"
  }.`;

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

export const workstreamReportUrlFromMcpEndpoint = (mcpEndpoint: string): string =>
  workstreamUrlFromMcpEndpoint(mcpEndpoint, REPORT_PATH);

export const workstreamListUrlFromMcpEndpoint = (mcpEndpoint: string): string =>
  workstreamUrlFromMcpEndpoint(mcpEndpoint, LIST_PATH);

export const workstreamReadThreadUrlFromMcpEndpoint = (mcpEndpoint: string): string =>
  workstreamUrlFromMcpEndpoint(mcpEndpoint, READ_THREAD_PATH);

export const workstreamAskThreadUrlFromMcpEndpoint = (mcpEndpoint: string): string =>
  workstreamUrlFromMcpEndpoint(mcpEndpoint, ASK_THREAD_PATH);

/**
 * The caller's whole workstream graph, active + archived. Both `list` (the
 * discovery view) and the same-tree auth predicate read this single set, so
 * "what you can see" and "what you can touch" are exactly the same scope.
 * Archived/finished threads are included — they are the likely inspection
 * targets.
 */
const collectGraphThreads = Effect.fn("WorkstreamHttp.collectGraphThreads")(function* () {
  const projection = yield* ProjectionSnapshotQuery;
  const active = yield* projection.getShellSnapshot();
  const archived = yield* projection.getArchivedShellSnapshot();
  return [...active.threads, ...archived.threads];
});

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

  // Model + thinking are intrinsic node config. Precedence:
  //   1. explicit `modelSelection` (decoded; invalid → 400),
  //   2. named `modelPreset` (unknown → 400),
  //   3. a preset keyed by the child's `role`,
  //   4. inherit the parent's selection.
  let modelSelection: ModelSelection;
  if (body.modelSelection !== undefined) {
    const decoded = yield* decodeModelSelection(body.modelSelection).pipe(
      Effect.map(Option.some),
      Effect.orElseSucceed(() => Option.none<ModelSelection>()),
    );
    if (Option.isNone(decoded)) return jsonError(400, "modelSelection is invalid.");
    modelSelection = decoded.value;
  } else {
    const settings = yield* (yield* ServerSettingsService).getSettings;
    const resolved = resolvePresetSelection({
      presets: settings.workstreamModelPresets as Record<string, ModelSelection>,
      modelPreset: trimString(body.modelPreset),
      role,
      parentSelection: current.modelSelection,
    });
    if (resolved.kind === "unknown-preset") {
      return jsonError(400, unknownPresetMessage(resolved.modelPreset, resolved.available));
    }
    modelSelection = resolved.selection;
  }

  // Trim before branding: ThreadId.make("") throws a defect that escapes the
  // typed Effect.catch, and untrimmed ids silently become dangling deps.
  const blockedBy = Array.isArray(body.blockedBy)
    ? body.blockedBy.map((id) => ThreadId.make((id as string).trim()))
    : undefined;

  const crypto = yield* Crypto.Crypto;
  const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const childThreadId = ThreadId.make(yield* crypto.randomUUIDv4);

  // Generation = the parent's ACTIVE turn at spawn time, so siblings spawned in
  // the same parent turn join into one wake. When the parent is not mid-turn
  // (no active turn) the spawn is out-of-turn and gets its own singleton
  // generation (the child id) — never the parent's last *completed* turn, which
  // would merge an out-of-turn spawn into a stale, already-joined generation.
  const spawnGeneration = current.session?.activeTurnId ?? childThreadId;

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
    spawnGeneration,
    title,
    modelSelection,
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

const handleWorkstreamReport = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const scope = yield* resolveWorkstreamScope();
  if (!scope) {
    return jsonError(401, "A valid provider-scoped Workstream credential is required.");
  }

  const body = (yield* request.json.pipe(
    Effect.orElseSucceed((): WorkstreamReportRequest => ({})),
  )) as WorkstreamReportRequest;
  const markdown = typeof body.markdown === "string" ? body.markdown : undefined;
  if (markdown === undefined || markdown.trim().length === 0) {
    return jsonError(400, "markdown is required.");
  }

  // A child may upsert only its OWN report; the report is always keyed to the
  // calling thread (no threadId override).
  const reportPath = yield* writeWorkstreamReport(scope.threadId, markdown);

  const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "thread.report.set",
    commandId: CommandId.make(`server:workstream-report:${yield* crypto.randomUUIDv4}`),
    threadId: scope.threadId,
    reportPath,
    createdAt: now,
  } satisfies OrchestrationCommand);

  return HttpServerResponse.jsonUnsafe({ threadId: scope.threadId, reportPath });
}).pipe(
  Effect.catch((error: unknown) =>
    Effect.succeed(
      jsonError(
        500,
        error instanceof Error ? error.message : "Failed to record Workstream report.",
      ),
    ),
  ),
);

const handleWorkstreamList = Effect.gen(function* () {
  const scope = yield* resolveWorkstreamScope();
  if (!scope) {
    return jsonError(401, "A valid provider-scoped Workstream credential is required.");
  }
  const threads = yield* collectGraphThreads();
  // The caller is implicitly in its own tree; no target arg, no 403 path.
  return HttpServerResponse.jsonUnsafe(graphViewFor(scope.threadId, threads));
}).pipe(
  Effect.catch((error: unknown) =>
    Effect.succeed(
      jsonError(500, error instanceof Error ? error.message : "Failed to list the workstream."),
    ),
  ),
);

const handleWorkstreamReadThread = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const scope = yield* resolveWorkstreamScope();
  if (!scope) {
    return jsonError(401, "A valid provider-scoped Workstream credential is required.");
  }
  const body = (yield* request.json.pipe(
    Effect.orElseSucceed((): WorkstreamReadThreadRequest => ({})),
  )) as WorkstreamReadThreadRequest;
  const threadId = trimString(body.threadId);
  if (!threadId) return jsonError(400, "threadId is required.");
  const target = ThreadId.make(threadId);

  const threads = yield* collectGraphThreads();
  const shell = threads.find((thread) => thread.id === target);
  // Distinguish missing (404) from out-of-tree (403).
  if (shell === undefined) return jsonError(404, "Target thread was not found.");
  if (!isInSameTree(scope.threadId, target, threads)) {
    return jsonError(403, "Credential may only read threads in its own workstream.");
  }

  const projection = yield* ProjectionSnapshotQuery;
  // Active detail carries messages/activities for the recent-activity summary;
  // an archived target has no detail query, so fall back to degraded shell
  // metadata (report + role/title/status) and omit the activity summary.
  const detail = yield* projection.getThreadDetailById(target);
  const report = yield* readWorkstreamReport(target);
  const source = Option.getOrUndefined(detail) ?? shell;

  const recentActivity = Option.match(detail, {
    onNone: () => null,
    onSome: (thread) => {
      const lastAssistant = [...thread.messages]
        .toReversed()
        .find((message) => message.role === "assistant");
      const lastAssistantMessage = lastAssistant
        ? lastAssistant.text.trim().slice(0, READ_MESSAGE_EXCERPT_LIMIT)
        : null;
      const activities = thread.activities.slice(-READ_ACTIVITY_LIMIT).map((activity) => ({
        kind: activity.kind,
        summary: activity.summary,
        createdAt: activity.createdAt,
      }));
      return { lastAssistantMessage, activities };
    },
  });

  return HttpServerResponse.jsonUnsafe({
    threadId: target,
    role: source.role,
    title: source.title,
    status: source.status,
    archived: Option.isNone(detail),
    hasReport: source.reportPath !== null,
    report: Option.getOrNull(report),
    recentActivity,
  });
}).pipe(
  Effect.catch((error: unknown) =>
    Effect.succeed(
      jsonError(500, error instanceof Error ? error.message : "Failed to read the thread."),
    ),
  ),
);

const handleWorkstreamAskThread = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const scope = yield* resolveWorkstreamScope();
  if (!scope) {
    return jsonError(401, "A valid provider-scoped Workstream credential is required.");
  }
  const body = (yield* request.json.pipe(
    Effect.orElseSucceed((): WorkstreamAskThreadRequest => ({})),
  )) as WorkstreamAskThreadRequest;
  const threadId = trimString(body.threadId);
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!threadId) return jsonError(400, "threadId is required.");
  if (question.length === 0) return jsonError(400, "question is required.");
  if (question.length > ASK_QUESTION_MAX_CHARS) {
    return jsonError(400, `question must be at most ${ASK_QUESTION_MAX_CHARS} characters.`);
  }
  const target = ThreadId.make(threadId);

  const threads = yield* collectGraphThreads();
  const shell = threads.find((thread) => thread.id === target);
  if (shell === undefined) return jsonError(404, "Target thread was not found.");
  if (!isInSameTree(scope.threadId, target, threads)) {
    return jsonError(403, "Credential may only ask threads in its own workstream.");
  }

  const config = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const settings = yield* serverSettings.getSettings;
  const crypto = yield* Crypto.Crypto;
  const answer = yield* askWorkstreamThread({
    binaryPath: settings.providers.pi.binaryPath,
    targetSessionId: piSessionIdForThread(target),
    freshSessionId: yield* crypto.randomUUIDv4,
    cwd: shell.worktreePath ?? config.cwd,
    question,
    timeoutMs: ASK_TIMEOUT_MS,
  });

  return HttpServerResponse.jsonUnsafe({ threadId: target, answer });
}).pipe(
  Effect.catch((error: unknown) =>
    Effect.succeed(
      jsonError(502, error instanceof Error ? error.message : "Failed to ask the thread."),
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
export const workstreamReportRouteLayer = HttpRouter.add(
  "POST",
  REPORT_PATH,
  handleWorkstreamReport,
);
export const workstreamListRouteLayer = HttpRouter.add("POST", LIST_PATH, handleWorkstreamList);
export const workstreamReadThreadRouteLayer = HttpRouter.add(
  "POST",
  READ_THREAD_PATH,
  handleWorkstreamReadThread,
);
export const workstreamAskThreadRouteLayer = HttpRouter.add(
  "POST",
  ASK_THREAD_PATH,
  handleWorkstreamAskThread,
);

export const layer = Layer.mergeAll(
  workstreamSpawnRouteLayer,
  workstreamStatusRouteLayer,
  workstreamDependenciesRouteLayer,
  workstreamReportRouteLayer,
  workstreamListRouteLayer,
  workstreamReadThreadRouteLayer,
  workstreamAskThreadRouteLayer,
);
