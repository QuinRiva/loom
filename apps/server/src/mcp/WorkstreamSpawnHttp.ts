import {
  AttentionReason,
  CommandId,
  ModelSelection,
  ThreadId,
  ThreadPlanLane,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { graphViewFor, subtreeOf } from "@t3tools/shared/workstreamGraph";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { askWorkstreamThread } from "../orchestration/workstreamAsk.ts";
import {
  isUnambiguousMatch,
  rankThreadsByName,
  resolveSessionFilePath,
} from "../orchestration/threadResolve.ts";
import { writeWorkstreamReport } from "../orchestration/workstreamReport.ts";
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
  readonly staged?: unknown;
}

interface WorkstreamLaneRequest {
  readonly threadId?: unknown;
  readonly planLane?: unknown;
}

interface WorkstreamAttentionRequest {
  readonly threadId?: unknown;
  readonly reason?: unknown;
}

interface WorkstreamTargetRequest {
  readonly threadId?: unknown;
}

interface WorkstreamDependenciesRequest {
  readonly threadId?: unknown;
  readonly blockedBy?: unknown;
}

interface WorkstreamReportRequest {
  readonly markdown?: unknown;
}

interface WorkstreamConsultThreadRequest {
  readonly threadId?: unknown;
  readonly name?: unknown;
  readonly question?: unknown;
}

interface SetThreadTitleRequest {
  readonly title?: unknown;
}

const SPAWN_PATH = "/provider-tools/workstream/spawn";
const LANE_PATH = "/provider-tools/workstream/lane";
const ATTENTION_PATH = "/provider-tools/workstream/attention";
const RELEASE_PATH = "/provider-tools/workstream/release";
const STOP_PATH = "/provider-tools/workstream/stop";
const DEPENDENCIES_PATH = "/provider-tools/workstream/dependencies";
const REPORT_PATH = "/provider-tools/workstream/report";
const LIST_PATH = "/provider-tools/workstream/list";
const CONSULT_THREAD_PATH = "/provider-tools/workstream/consult-thread";
const SET_TITLE_PATH = "/provider-tools/thread/set-title";

// Server-side guard on a single fork turn (forking handles transcript size, so
// only the turn duration and the question length need bounding).
const ASK_TIMEOUT_MS = 120_000;
const ASK_QUESTION_MAX_CHARS = 8_000;
// Cap candidates surfaced on an ambiguous name so the agent gets a focused
// disambiguation set rather than the whole server's thread list.
const CONSULT_CANDIDATE_LIMIT = 8;

// Plan lanes an agent may set (the `workstream_set_lane` enum). `in_progress` is
// control-plane-only (set by starting a turn) and is excluded; the decider also
// rejects an agent `in_progress`.
const SETTABLE_LANES: ReadonlyArray<ThreadPlanLane> = ["planned", "ready", "done", "cancelled"];
const VALID_LANES = new Set<ThreadPlanLane>(SETTABLE_LANES);
// Attention reasons an agent may raise. `error` is server-only and the two
// `awaiting_*` request reasons are derived from open requests — the decider
// rejects all three; this mirrors that set at the boundary.
const RAISABLE_REASONS: ReadonlyArray<AttentionReason> = ["awaiting_acceptance", "needs_guidance"];
const VALID_REASONS = new Set<AttentionReason>(RAISABLE_REASONS);

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
    : jsonError(403, "Credential may only act on its own thread or a thread it directly parents.");
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

export const workstreamLaneUrlFromMcpEndpoint = (mcpEndpoint: string): string =>
  workstreamUrlFromMcpEndpoint(mcpEndpoint, LANE_PATH);

export const workstreamAttentionUrlFromMcpEndpoint = (mcpEndpoint: string): string =>
  workstreamUrlFromMcpEndpoint(mcpEndpoint, ATTENTION_PATH);

export const workstreamReleaseUrlFromMcpEndpoint = (mcpEndpoint: string): string =>
  workstreamUrlFromMcpEndpoint(mcpEndpoint, RELEASE_PATH);

export const workstreamStopUrlFromMcpEndpoint = (mcpEndpoint: string): string =>
  workstreamUrlFromMcpEndpoint(mcpEndpoint, STOP_PATH);

export const workstreamDependenciesUrlFromMcpEndpoint = (mcpEndpoint: string): string =>
  workstreamUrlFromMcpEndpoint(mcpEndpoint, DEPENDENCIES_PATH);

export const workstreamReportUrlFromMcpEndpoint = (mcpEndpoint: string): string =>
  workstreamUrlFromMcpEndpoint(mcpEndpoint, REPORT_PATH);

export const workstreamListUrlFromMcpEndpoint = (mcpEndpoint: string): string =>
  workstreamUrlFromMcpEndpoint(mcpEndpoint, LIST_PATH);

export const workstreamConsultThreadUrlFromMcpEndpoint = (mcpEndpoint: string): string =>
  workstreamUrlFromMcpEndpoint(mcpEndpoint, CONSULT_THREAD_PATH);

export const setThreadTitleUrlFromMcpEndpoint = (mcpEndpoint: string): string =>
  workstreamUrlFromMcpEndpoint(mcpEndpoint, SET_TITLE_PATH);

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
  const title = trimString(body.title);
  // Default `ready` (runs once deps clear — current ergonomics); `staged: true`
  // creates a held `planned` node for the review-the-graph flow (design §3).
  const planLane: ThreadPlanLane = body.staged === true ? "planned" : "ready";
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
    planLane,
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

const handleWorkstreamSetLane = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const scope = yield* resolveWorkstreamScope();
  if (!scope) {
    return jsonError(401, "A valid provider-scoped Workstream credential is required.");
  }

  const body = (yield* request.json.pipe(
    Effect.orElseSucceed((): WorkstreamLaneRequest => ({})),
  )) as WorkstreamLaneRequest;
  const threadId = trimString(body.threadId);
  const planLane = trimString(body.planLane);
  if (!planLane || !VALID_LANES.has(planLane as ThreadPlanLane)) {
    return jsonError(400, `planLane must be one of: ${SETTABLE_LANES.join(", ")}.`);
  }

  // Missing threadId defaults to the caller's own thread (always authorised).
  const targetThreadId = threadId ? ThreadId.make(threadId) : scope.threadId;
  const denied = yield* authorizationError(scope.threadId, targetThreadId);
  if (denied) return denied;

  const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "thread.plan-lane.set",
    commandId: CommandId.make(`server:workstream-lane:${yield* crypto.randomUUIDv4}`),
    threadId: targetThreadId,
    planLane: planLane as ThreadPlanLane,
    createdAt: now,
  } satisfies OrchestrationCommand);

  return HttpServerResponse.jsonUnsafe({ threadId: targetThreadId, planLane });
}).pipe(
  Effect.catch((error: unknown) =>
    Effect.succeed(
      jsonError(500, error instanceof Error ? error.message : "Failed to set Workstream lane."),
    ),
  ),
);

const handleWorkstreamRequestAttention = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const scope = yield* resolveWorkstreamScope();
  if (!scope) {
    return jsonError(401, "A valid provider-scoped Workstream credential is required.");
  }

  const body = (yield* request.json.pipe(
    Effect.orElseSucceed((): WorkstreamAttentionRequest => ({})),
  )) as WorkstreamAttentionRequest;
  const threadId = trimString(body.threadId);
  const reason = trimString(body.reason);
  if (!reason || !VALID_REASONS.has(reason as AttentionReason)) {
    return jsonError(400, `reason must be one of: ${RAISABLE_REASONS.join(", ")}.`);
  }

  const targetThreadId = threadId ? ThreadId.make(threadId) : scope.threadId;
  const denied = yield* authorizationError(scope.threadId, targetThreadId);
  if (denied) return denied;

  const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "thread.attention.raise",
    commandId: CommandId.make(`server:workstream-attention:${yield* crypto.randomUUIDv4}`),
    threadId: targetThreadId,
    reason: reason as AttentionReason,
    createdAt: now,
  } satisfies OrchestrationCommand);

  return HttpServerResponse.jsonUnsafe({ threadId: targetThreadId, reason });
}).pipe(
  Effect.catch((error: unknown) =>
    Effect.succeed(
      jsonError(500, error instanceof Error ? error.message : "Failed to request attention."),
    ),
  ),
);

// Release a held subtree: flip every `planned` node in the target's subtree to
// `ready`. Reports the scope (which nodes flipped) so an intentional mixed-hold
// is not silently erased.
const handleWorkstreamRelease = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const scope = yield* resolveWorkstreamScope();
  if (!scope) {
    return jsonError(401, "A valid provider-scoped Workstream credential is required.");
  }

  const body = (yield* request.json.pipe(
    Effect.orElseSucceed((): WorkstreamTargetRequest => ({})),
  )) as WorkstreamTargetRequest;
  const threadId = trimString(body.threadId);
  const targetThreadId = threadId ? ThreadId.make(threadId) : scope.threadId;
  const denied = yield* authorizationError(scope.threadId, targetThreadId);
  if (denied) return denied;

  const threads = yield* collectGraphThreads();
  const held = subtreeOf(targetThreadId, threads).filter((t) => t.planLane === "planned");
  const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  for (const node of held) {
    yield* engine.dispatch({
      type: "thread.plan-lane.set",
      commandId: CommandId.make(`server:workstream-release:${yield* crypto.randomUUIDv4}`),
      threadId: node.id,
      planLane: "ready",
      createdAt: now,
    } satisfies OrchestrationCommand);
  }

  return HttpServerResponse.jsonUnsafe({
    threadId: targetThreadId,
    released: held.map((node) => node.id),
  });
}).pipe(
  Effect.catch((error: unknown) =>
    Effect.succeed(
      jsonError(500, error instanceof Error ? error.message : "Failed to release subtree."),
    ),
  ),
);

// Orchestrator stop of a direct child: interrupt the active turn WITHOUT raising
// attention (the `server:` commandId tells the decider this is an
// orchestrator-owned pause, not a human stop — the orchestrator owns the
// resume; the dispatcher's idle backstop covers a forgotten one).
const handleWorkstreamStop = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const scope = yield* resolveWorkstreamScope();
  if (!scope) {
    return jsonError(401, "A valid provider-scoped Workstream credential is required.");
  }

  const body = (yield* request.json.pipe(
    Effect.orElseSucceed((): WorkstreamTargetRequest => ({})),
  )) as WorkstreamTargetRequest;
  const threadId = trimString(body.threadId);
  if (!threadId) return jsonError(400, "threadId is required.");
  const targetThreadId = ThreadId.make(threadId);
  const denied = yield* authorizationError(scope.threadId, targetThreadId);
  if (denied) return denied;

  const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "thread.turn.interrupt",
    commandId: CommandId.make(`server:workstream-stop:${yield* crypto.randomUUIDv4}`),
    threadId: targetThreadId,
    createdAt: now,
  } satisfies OrchestrationCommand);

  return HttpServerResponse.jsonUnsafe({ threadId: targetThreadId });
}).pipe(
  Effect.catch((error: unknown) =>
    Effect.succeed(
      jsonError(500, error instanceof Error ? error.message : "Failed to stop the thread."),
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
  // Enrich each node with a last-activity signal (the projection's freshness
  // timestamp + one-line preview) and an absolute session jsonl path, so the
  // three-tier read model (report → list+jsonl → consult) needs no bespoke
  // read tool. `sessionPath` is resolved per node from the deterministic pi
  // session id; null until the file first lands on disk.
  const viewThreads = threads.map((thread) => ({
    ...thread,
    lastActivityAt: thread.updatedAt,
    lastActivitySummary: thread.lastActivityPreview,
  }));
  // The caller is implicitly in its own tree; no target arg, no 403 path.
  return HttpServerResponse.jsonUnsafe(
    graphViewFor(
      scope.threadId,
      viewThreads,
      (id) => resolveSessionFilePath(piSessionIdForThread(id)) ?? null,
    ),
  );
}).pipe(
  Effect.catch((error: unknown) =>
    Effect.succeed(
      jsonError(500, error instanceof Error ? error.message : "Failed to list the workstream."),
    ),
  ),
);

/**
 * USER-DIRECTED consult: a GLOBAL-scope read-only Q&A over another thread (every
 * thread the server knows, across worktrees/projects). It identifies the target either by
 * an exact `threadId` (e.g. injected by an @-mention) or by a fuzzy `name`. A
 * name with one clear match runs the read-only consult; an ambiguous name
 * returns ranked candidates for the caller to confirm with the user (consulting
 * the wrong thread is costly). The target session is resolved to its absolute
 * `.jsonl` path so the read-only fork locates it even in a different worktree.
 * The execution core (`askWorkstreamThread`) is reused unchanged.
 */
const handleWorkstreamConsultThread = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const scope = yield* resolveWorkstreamScope();
  if (!scope) {
    return jsonError(401, "A valid provider-scoped Workstream credential is required.");
  }
  const body = (yield* request.json.pipe(
    Effect.orElseSucceed((): WorkstreamConsultThreadRequest => ({})),
  )) as WorkstreamConsultThreadRequest;
  const threadId = trimString(body.threadId);
  const name = trimString(body.name);
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!threadId && !name) return jsonError(400, "Provide either threadId or name.");
  if (question.length === 0) return jsonError(400, "question is required.");
  if (question.length > ASK_QUESTION_MAX_CHARS) {
    return jsonError(400, `question must be at most ${ASK_QUESTION_MAX_CHARS} characters.`);
  }

  const config = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const settings = yield* serverSettings.getSettings;
  const crypto = yield* Crypto.Crypto;
  const threads = yield* collectGraphThreads();

  // Resolve the target to its absolute session path (bare id fallback) so the
  // read-only fork locates it regardless of which worktree/project it lives in.
  const askShell = (shell: (typeof threads)[number], freshSessionId: string) => {
    const sessionId = piSessionIdForThread(shell.id);
    return askWorkstreamThread({
      binaryPath: settings.providers.pi.binaryPath,
      targetSessionId: resolveSessionFilePath(sessionId) ?? sessionId,
      freshSessionId,
      cwd: shell.worktreePath ?? config.cwd,
      question,
      timeoutMs: ASK_TIMEOUT_MS,
    });
  };

  if (threadId) {
    const target = ThreadId.make(threadId);
    const shell = threads.find((thread) => thread.id === target);
    if (shell === undefined) return jsonError(404, "Target thread was not found.");
    const answer = yield* askShell(shell, yield* crypto.randomUUIDv4);
    return HttpServerResponse.jsonUnsafe({
      resolved: true,
      threadId: target,
      title: shell.title,
      answer,
    });
  }

  const ranked = rankThreadsByName(name!, threads);
  if (ranked.length === 0) {
    return jsonError(404, `No thread matches "${name}".`);
  }
  if (isUnambiguousMatch(ranked)) {
    const shell = ranked[0]!.thread;
    const answer = yield* askShell(shell, yield* crypto.randomUUIDv4);
    return HttpServerResponse.jsonUnsafe({
      resolved: true,
      threadId: shell.id,
      title: shell.title,
      answer,
    });
  }
  return HttpServerResponse.jsonUnsafe({
    resolved: false,
    candidates: ranked.slice(0, CONSULT_CANDIDATE_LIMIT).map((entry) => ({
      threadId: entry.thread.id,
      title: entry.thread.title,
      role: entry.thread.role,
      planLane: entry.thread.planLane,
      projectId: entry.thread.projectId,
      worktreePath: entry.thread.worktreePath,
    })),
  });
}).pipe(
  Effect.catch((error: unknown) =>
    Effect.succeed(
      jsonError(502, error instanceof Error ? error.message : "Failed to consult the thread."),
    ),
  ),
);

// A thread renames its OWN sidebar title. The title is always keyed to the
// calling thread (no threadId override — renaming an arbitrary thread is
// structurally impossible). Dispatches the existing `thread.meta.update`
// command (one source of truth); a later rename naturally wins over the
// auto-from-first-message title.
const handleSetThreadTitle = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const scope = yield* resolveWorkstreamScope();
  if (!scope) {
    return jsonError(401, "A valid provider-scoped Workstream credential is required.");
  }

  const body = (yield* request.json.pipe(
    Effect.orElseSucceed((): SetThreadTitleRequest => ({})),
  )) as SetThreadTitleRequest;
  const title = trimString(body.title);
  if (!title) return jsonError(400, "title must be a non-empty string.");

  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "thread.meta.update",
    commandId: CommandId.make(`server:set-thread-title:${yield* crypto.randomUUIDv4}`),
    threadId: scope.threadId,
    title,
  } satisfies OrchestrationCommand);

  return HttpServerResponse.jsonUnsafe({ threadId: scope.threadId, title });
}).pipe(
  Effect.catch((error: unknown) =>
    Effect.succeed(
      jsonError(500, error instanceof Error ? error.message : "Failed to set the thread title."),
    ),
  ),
);

export const workstreamSpawnRouteLayer = HttpRouter.add("POST", SPAWN_PATH, handleWorkstreamSpawn);
export const workstreamLaneRouteLayer = HttpRouter.add("POST", LANE_PATH, handleWorkstreamSetLane);
export const workstreamAttentionRouteLayer = HttpRouter.add(
  "POST",
  ATTENTION_PATH,
  handleWorkstreamRequestAttention,
);
export const workstreamReleaseRouteLayer = HttpRouter.add(
  "POST",
  RELEASE_PATH,
  handleWorkstreamRelease,
);
export const workstreamStopRouteLayer = HttpRouter.add("POST", STOP_PATH, handleWorkstreamStop);
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
export const workstreamConsultThreadRouteLayer = HttpRouter.add(
  "POST",
  CONSULT_THREAD_PATH,
  handleWorkstreamConsultThread,
);
export const setThreadTitleRouteLayer = HttpRouter.add(
  "POST",
  SET_TITLE_PATH,
  handleSetThreadTitle,
);

export const layer = Layer.mergeAll(
  workstreamSpawnRouteLayer,
  workstreamLaneRouteLayer,
  workstreamAttentionRouteLayer,
  workstreamReleaseRouteLayer,
  workstreamStopRouteLayer,
  workstreamDependenciesRouteLayer,
  workstreamReportRouteLayer,
  workstreamListRouteLayer,
  workstreamConsultThreadRouteLayer,
  setThreadTitleRouteLayer,
);
