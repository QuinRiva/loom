import {
  AttentionReason,
  CommandId,
  DEFAULT_GATE_MAX_ROUNDS,
  MAX_GATE_MAX_ROUNDS,
  MessageId,
  ModelSelection,
  ThreadId,
  ThreadIsolation,
  ThreadPlanLane,
  type OrchestrationCommand,
  type WorkstreamRoute,
} from "@t3tools/contracts";
import { findDependencyCycle } from "@t3tools/shared/workstreamDependencies";
import { roleDefaultIsolation } from "@t3tools/shared/workstreamIsolation";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import {
  gateLoopTargetOf,
  graphViewFor,
  requiresSubmitToComplete,
  routeWorkSubmit,
  subtreeOf,
} from "@t3tools/shared/workstreamGraph";

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
  readonly gate?: unknown;
  readonly isolation?: unknown;
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

interface WorkstreamPromptRequest {
  readonly threadId?: unknown;
  readonly message?: unknown;
}

interface WorkstreamDependenciesRequest {
  readonly threadId?: unknown;
  readonly blockedBy?: unknown;
}

interface WorkstreamSubmitRequest {
  readonly markdown?: unknown;
  readonly outcome?: unknown;
  readonly contested?: unknown;
  readonly counts?: unknown;
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
const PROMPT_PATH = "/provider-tools/workstream/prompt";
const DEPENDENCIES_PATH = "/provider-tools/workstream/dependencies";
const SUBMIT_PATH = "/provider-tools/workstream/submit";
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
// Worktree isolation (design §1): spawn-overridable policy. `attached` is not
// directly settable — it is the control-plane default for a gated reviewer.
const SPAWN_ISOLATIONS: ReadonlyArray<ThreadIsolation> = ["isolated", "shared"];
const VALID_SPAWN_ISOLATIONS = new Set<ThreadIsolation>(SPAWN_ISOLATIONS);
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

type DependencySibling = {
  readonly id: ThreadId;
  readonly title: string | null;
  readonly role: string | null;
  readonly parentThreadId: ThreadId | null;
  readonly planLane: ThreadPlanLane;
  readonly blockedBy: ReadonlyArray<ThreadId>;
  readonly session: unknown | null;
  readonly latestUserMessageAt: string | null;
};

export type SpawnGraphResult =
  | { readonly kind: "rejected"; readonly message: string }
  | {
      readonly kind: "ok";
      readonly blockedBy: ReadonlyArray<ThreadId> | undefined;
      readonly forceAttached: boolean;
      readonly warnings: ReadonlyArray<string>;
    };

export interface SpawnGraphInput {
  readonly operation?: "spawn" | "set-dependencies";
  readonly siblings: ReadonlyArray<DependencySibling>;
  readonly archivedSiblings?: ReadonlyArray<DependencySibling>;
  readonly blockedBy: ReadonlyArray<ThreadId> | undefined;
  readonly gateRework: ThreadId | undefined;
  readonly gateMaxRounds?: number | undefined;
  readonly isolationOverride: ThreadIsolation | undefined;
  readonly role: string;
  readonly newThreadId?: ThreadId;
  readonly target?: DependencySibling;
}

export const hasThreadStarted = (thread: {
  readonly session: unknown | null;
  readonly latestUserMessageAt: string | null;
}): boolean => thread.session !== null || thread.latestUserMessageAt !== null;

const uniqueIds = (ids: ReadonlyArray<ThreadId>): ReadonlyArray<ThreadId> => [...new Set(ids)];

const formatThread = (thread: Pick<DependencySibling, "id" | "title" | "planLane">): string =>
  `${thread.id} — "${thread.title ?? "(untitled)"}" (${thread.planLane})`;

const knownChildrenMessage = (siblings: ReadonlyArray<DependencySibling>): string =>
  siblings.length > 0 ? siblings.map(formatThread).join(", ") : "none";

const dependencyCycleMessage = (
  cycle: ReadonlyArray<ThreadId>,
  operation: "spawn" | "set-dependencies",
): string => {
  const path = cycle.join(" → ");
  return operation === "spawn"
    ? `blockedBy would place this child behind a dependency cycle: ${path}. A cyclic set never releases, so the child would never start. Fix the cycle first (workstream_set_dependencies on one of the members). Nothing was spawned.`
    : `These dependencies would create a cycle: ${path}. A cyclic set never releases — every member waits on another member forever. Remove one edge, or re-order the work. Nothing was changed.`;
};

export const validateSpawnGraph = (input: SpawnGraphInput): SpawnGraphResult => {
  const operation = input.operation ?? "spawn";
  if (
    operation === "spawn" &&
    input.gateMaxRounds !== undefined &&
    (!Number.isInteger(input.gateMaxRounds) ||
      input.gateMaxRounds < 1 ||
      input.gateMaxRounds > MAX_GATE_MAX_ROUNDS)
  ) {
    return {
      kind: "rejected",
      message: `gate.maxRounds must be an integer between 1 and ${MAX_GATE_MAX_ROUNDS}. Each round is a full rework + re-review cycle; if you expect to need more than a few, the work should be re-scoped instead of looped.`,
    };
  }
  if (operation === "set-dependencies" && input.target?.parentThreadId === null) {
    return {
      kind: "rejected",
      message:
        "Dependencies have no effect on a root thread — only sub-threads are dependency-gated. Nothing was changed.",
    };
  }

  const blockedBy = uniqueIds(input.blockedBy ?? []);
  if (operation === "set-dependencies" && input.target !== undefined) {
    if (blockedBy.includes(input.target.id)) {
      return {
        kind: "rejected",
        message: `A thread cannot block on itself (${input.target.id} is the target thread). Nothing was changed.`,
      };
    }
  }

  const validSiblings =
    operation === "set-dependencies" && input.target !== undefined
      ? input.siblings.filter((thread) => thread.id !== input.target!.id)
      : input.siblings;
  const activeById = new Map(validSiblings.map((thread) => [thread.id, thread] as const));
  const invalid = blockedBy.filter((id) => !activeById.has(id));
  if (invalid.length > 0) {
    const archivedById = new Map(
      (input.archivedSiblings ?? []).map((thread) => [thread.id, thread] as const),
    );
    const archived = invalid.flatMap((id) => {
      const thread = archivedById.get(id);
      return thread === undefined ? [] : [thread];
    });
    if (archived.length > 0) {
      const archivedIds = new Set(archived.map((thread) => thread.id));
      const otherInvalid = invalid.filter((id) => !archivedIds.has(id));
      return {
        kind: "rejected",
        message: `${operation === "spawn" ? "blockedBy names" : "Dependencies name"} ${archived.map((thread) => `${thread.id} ("${thread.title ?? "(untitled)"}")`).join(", ")}, which ${archived.length === 1 ? "is" : "are"} archived and no longer active — an archived thread cannot gate (depending on it would silently release). ${otherInvalid.length > 0 ? `Other invalid ids: ${otherInvalid.join(", ")}. ` : ""}Known active siblings: ${knownChildrenMessage(validSiblings)}. Depend on an active sibling instead. ${operation === "spawn" ? "Nothing was spawned." : "Nothing was changed."}`,
      };
    }
    return {
      kind: "rejected",
      message:
        operation === "spawn"
          ? `blockedBy contains ids that are not children of this thread: ${invalid.join(", ")}. A dependency can only name a sibling of the new child — a thread you directly parent. Known children: ${knownChildrenMessage(validSiblings)}. Use the exact childThreadId returned by workstream_spawn, or check workstream_list. Nothing was spawned.`
          : `blockedBy contains ids that are not siblings of the target thread: ${invalid.join(", ")}. A dependency can only name an active sibling of the target. Known siblings: ${knownChildrenMessage(validSiblings)}. Use the exact thread id from workstream_list. Nothing was changed.`,
    };
  }

  const warnings: Array<string> = [];
  let effectiveBlockedBy = blockedBy;
  let gateTarget: DependencySibling | undefined;
  if (operation === "spawn" && input.gateRework !== undefined) {
    gateTarget = activeById.get(input.gateRework);
    if (gateTarget === undefined) {
      const archived = (input.archivedSiblings ?? []).find(
        (thread) => thread.id === input.gateRework,
      );
      return {
        kind: "rejected",
        message:
          archived === undefined
            ? `gate.rework must name an active sibling: a thread this thread directly parents. Known children: ${knownChildrenMessage(validSiblings)}. Nothing was spawned.`
            : `gate.rework names ${archived.id} ("${archived.title ?? "(untitled)"}"), which is archived and no longer active — an archived thread cannot gate (depending on it would silently release). Depend on an active sibling instead. Nothing was spawned.`,
      };
    }
    if (!effectiveBlockedBy.includes(input.gateRework)) {
      effectiveBlockedBy = [...effectiveBlockedBy, input.gateRework];
      warnings.push(
        `gate.rework ${input.gateRework} was added to blockedBy automatically — a gated reviewer always waits for the thread it reviews.`,
      );
    }
    if (input.isolationOverride !== undefined) {
      warnings.push(
        `isolation "${input.isolationOverride}" was ignored: a gated reviewer always runs attached (it joins the reviewed thread's worktree). Any other isolation deadlocks the gate — the reviewer would wait for the coder's fan-in, which is deferred until the gate the reviewer itself must resolve.`,
      );
    }
    if (roleDefaultIsolation(gateTarget.role) !== "isolated") {
      warnings.push(
        `gate.rework targets ${gateTarget.id} ("${gateTarget.title ?? "(untitled)"}", role "${gateTarget.role ?? "thread"}") — a reader-style role. Review gates loop rework back to the thread that produces the work (coder/planner/free-text writer); gating a ${gateTarget.role ?? "thread"} is usually a wiring mistake. Proceeding anyway.`,
      );
    }
  }

  for (const depId of effectiveBlockedBy) {
    const dep = activeById.get(depId);
    if (dep?.planLane === "cancelled") {
      warnings.push(
        `blockedBy names ${dep.id} ("${dep.title ?? "(untitled)"}"), which is cancelled. A cancelled dependency never releases — ${operation === "spawn" ? "this child" : "the target thread"} will not start unless ${dep.id} is revived (workstream_set_lane → ready) or ${operation === "spawn" ? "this child's" : "the target thread's"} dependencies are re-pointed.`,
      );
    }
  }

  const graphThreads =
    operation === "set-dependencies" && input.target !== undefined
      ? input.siblings.map((thread) =>
          thread.id === input.target!.id ? { ...thread, blockedBy: effectiveBlockedBy } : thread,
        )
      : [
          ...input.siblings,
          {
            id: input.newThreadId ?? ("__new_child__" as ThreadId),
            parentThreadId: input.siblings[0]?.parentThreadId ?? null,
            blockedBy: effectiveBlockedBy,
          },
        ];
  const cycle = findDependencyCycle(graphThreads);
  if (cycle !== null)
    return { kind: "rejected", message: dependencyCycleMessage(cycle, operation) };

  if (
    operation === "set-dependencies" &&
    input.target !== undefined &&
    hasThreadStarted(input.target)
  ) {
    warnings.push(
      `${input.target.id} has already started: the dependency edge was recorded for DISPLAY ONLY — a started thread is never un-run, so this will not pause or re-gate it. To pause it use workstream_stop; to abandon it set its lane to cancelled; to sequence future work, set blockedBy at spawn time.`,
    );
  }

  return {
    kind: "ok",
    blockedBy:
      input.blockedBy === undefined && effectiveBlockedBy.length === 0
        ? undefined
        : effectiveBlockedBy,
    forceAttached: operation === "spawn" && input.gateRework !== undefined,
    warnings,
  };
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

export const workstreamPromptUrlFromMcpEndpoint = (mcpEndpoint: string): string =>
  workstreamUrlFromMcpEndpoint(mcpEndpoint, PROMPT_PATH);

export const workstreamDependenciesUrlFromMcpEndpoint = (mcpEndpoint: string): string =>
  workstreamUrlFromMcpEndpoint(mcpEndpoint, DEPENDENCIES_PATH);

export const workstreamSubmitUrlFromMcpEndpoint = (mcpEndpoint: string): string =>
  workstreamUrlFromMcpEndpoint(mcpEndpoint, SUBMIT_PATH);

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
  // Review gates (design §4.2): the v1 gate sugar. Shape-validate here; the
  // sibling rule is checked against the projection below.
  const gate =
    typeof body.gate === "object" && body.gate !== null && !Array.isArray(body.gate)
      ? (body.gate as { readonly rework?: unknown; readonly maxRounds?: unknown })
      : undefined;
  const gateRework = gate === undefined ? undefined : trimString(gate.rework);
  const isolationOverride = trimString(body.isolation);
  if (
    isolationOverride !== undefined &&
    !VALID_SPAWN_ISOLATIONS.has(isolationOverride as ThreadIsolation)
  ) {
    return jsonError(400, `isolation must be one of: ${SPAWN_ISOLATIONS.join(", ")}.`);
  }
  if (body.gate !== undefined) {
    if (gate === undefined || !gateRework) {
      return jsonError(400, "gate must be an object with a non-empty rework thread id.");
    }
    if (
      gate.maxRounds !== undefined &&
      (typeof gate.maxRounds !== "number" ||
        !Number.isInteger(gate.maxRounds) ||
        gate.maxRounds < 1 ||
        gate.maxRounds > MAX_GATE_MAX_ROUNDS)
    ) {
      return jsonError(
        400,
        `gate.maxRounds must be an integer between 1 and ${MAX_GATE_MAX_ROUNDS}. Each round is a full rework + re-review cycle; if you expect to need more than a few, the work should be re-scoped instead of looped.`,
      );
    }
  }

  const projection = yield* ProjectionSnapshotQuery;
  const parent = yield* projection.getThreadDetailById(scope.threadId);
  if (Option.isNone(parent)) {
    return jsonError(404, "Current provider thread was not found.");
  }
  const current = parent.value;

  const activeSnapshot = yield* projection.getShellSnapshot();
  const activeChildren = activeSnapshot.threads.filter(
    (thread) => thread.parentThreadId === scope.threadId,
  );
  const archivedSnapshot = yield* projection.getArchivedShellSnapshot();
  const archivedChildren = archivedSnapshot.threads.filter(
    (thread) => thread.parentThreadId === scope.threadId,
  );

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

  const graph = validateSpawnGraph({
    siblings: activeChildren,
    archivedSiblings: archivedChildren,
    blockedBy,
    gateRework: gateRework === undefined ? undefined : ThreadId.make(gateRework),
    gateMaxRounds: gate?.maxRounds as number | undefined,
    isolationOverride: isolationOverride as ThreadIsolation | undefined,
    role,
    newThreadId: childThreadId,
  });
  if (graph.kind === "rejected") return jsonError(400, graph.message);

  const routes: ReadonlyArray<WorkstreamRoute> | undefined =
    gateRework === undefined
      ? undefined
      : [
          {
            on: ["needs_rework"],
            kind: "loop",
            to: ThreadId.make(gateRework),
            maxRounds: (gate?.maxRounds as number | undefined) ?? DEFAULT_GATE_MAX_ROUNDS,
          },
          { on: ["clean", "fixed_inline"], kind: "resolve" },
        ];

  // Generation = the parent's ACTIVE turn at spawn time, so siblings spawned in
  // the same parent turn join into one wake. When the parent is not mid-turn
  // (no active turn) the spawn is out-of-turn and gets its own singleton
  // generation (the child id) — never the parent's last *completed* turn, which
  // would merge an out-of-turn spawn into a stale, already-joined generation.
  const spawnGeneration = current.session?.activeTurnId ?? childThreadId;

  // Worktree isolation (design §1): a gated reviewer is forced `attached` (it
  // joins its gate target's worktree at promotion, §4); everything else honours
  // the explicit override or takes the role default.
  const isolation: ThreadIsolation = graph.forceAttached
    ? "attached"
    : ((isolationOverride as ThreadIsolation | undefined) ?? roleDefaultIsolation(role));

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
    ...(graph.blockedBy !== undefined ? { blockedBy: graph.blockedBy } : {}),
    ...(routes !== undefined ? { routes } : {}),
    isolation,
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

  return HttpServerResponse.jsonUnsafe({
    childThreadId,
    parentThreadId: scope.threadId,
    title,
    ...(graph.warnings.length > 0 ? { warnings: graph.warnings } : {}),
  });
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

  // Bypass guard (review-gates design §5.3), keyed off the ACTOR SCOPE: a gate
  // party may not SELF-set `done` around the routing — with an open rework
  // round or an unresolved gate as source, completion must go through
  // workstream_submit so the outcome routes the gate. A parent-issued lane
  // change (targetThreadId !== scope.threadId) deliberately bypasses this
  // (decision 9: parent overrides dissolve gates).
  if (planLane === "done" && targetThreadId === scope.threadId) {
    const self = yield* (yield* ProjectionSnapshotQuery).getThreadDetailById(targetThreadId);
    if (Option.isSome(self) && requiresSubmitToComplete(self.value)) {
      return jsonError(
        409,
        "This thread is part of an active review gate; finish with workstream_submit (your outcome routes the gate) instead of setting your own lane to done.",
      );
    }
  }

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

// Orchestrator prompt to a direct child: dispatch a plain `thread.turn.start`
// carrying the parent's markdown message. On an idle child this starts/resumes
// a turn; on a child with an open turn PiDriver maps it to a queued steer
// folded in between model rounds (no `requireIdle`, no `setInProgress` — the
// same shape as the liveness nudge's steer).
const handleWorkstreamPrompt = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const scope = yield* resolveWorkstreamScope();
  if (!scope) {
    return jsonError(401, "A valid provider-scoped Workstream credential is required.");
  }

  const body = (yield* request.json.pipe(
    Effect.orElseSucceed((): WorkstreamPromptRequest => ({})),
  )) as WorkstreamPromptRequest;
  const threadId = trimString(body.threadId);
  const message =
    typeof body.message === "string" && body.message.trim().length > 0 ? body.message : undefined;
  if (!threadId) return jsonError(400, "threadId is required.");
  if (!message) return jsonError(400, "message is required.");
  const targetThreadId = ThreadId.make(threadId);
  const denied = yield* authorizationError(scope.threadId, targetThreadId);
  if (denied) return denied;

  const projection = yield* ProjectionSnapshotQuery;
  const target = yield* projection.getThreadDetailById(targetThreadId);
  if (Option.isNone(target)) return jsonError(404, "Target thread was not found.");
  // Sticky terminal (design §3.4/§6): the decider treats a turn-start on a
  // `done`/`cancelled` thread as a silent re-engagement — runtime runs, lane
  // and attention unchanged. Reject it here instead: a parent prompting a
  // terminal child is almost always a mistake, and a deliberate re-open goes
  // through workstream_set_lane (or a new spawn) first.
  if (target.value.planLane === "done" || target.value.planLane === "cancelled") {
    return jsonError(
      409,
      `Thread is ${target.value.planLane}; prompting would re-engage it without changing its lane. Re-open it with workstream_set_lane first, or spawn a new child.`,
    );
  }

  const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  // Advisory only (the driver makes the authoritative steer-vs-start call from
  // its live session state): whether the child had an open turn at dispatch.
  const delivery = target.value.session?.activeTurnId ? "steer" : "turn";
  yield* engine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.make(`server:workstream-prompt:${yield* crypto.randomUUIDv4}`),
    threadId: targetThreadId,
    message: {
      messageId: MessageId.make(yield* crypto.randomUUIDv4),
      role: "user",
      text: message,
      attachments: [],
    },
    runtimeMode: target.value.runtimeMode,
    interactionMode: target.value.interactionMode,
    createdAt: now,
  } satisfies OrchestrationCommand);

  return HttpServerResponse.jsonUnsafe({ threadId: targetThreadId, delivery });
}).pipe(
  Effect.catch((error: unknown) =>
    Effect.succeed(
      jsonError(500, error instanceof Error ? error.message : "Failed to prompt the thread."),
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

  const projection = yield* ProjectionSnapshotQuery;
  const activeSnapshot = yield* projection.getShellSnapshot();
  const target = activeSnapshot.threads.find((thread) => thread.id === targetThreadId);
  if (target === undefined) return jsonError(404, "Target thread was not found or is archived.");
  const siblings = activeSnapshot.threads.filter(
    (thread) => thread.parentThreadId === target.parentThreadId,
  );
  const archivedSnapshot = yield* projection.getArchivedShellSnapshot();
  const archivedSiblings = archivedSnapshot.threads.filter(
    (thread) => thread.parentThreadId === target.parentThreadId,
  );
  const graph = validateSpawnGraph({
    operation: "set-dependencies",
    siblings,
    archivedSiblings,
    blockedBy,
    gateRework: undefined,
    isolationOverride: undefined,
    role: target.role ?? "thread",
    target,
  });
  if (graph.kind === "rejected") return jsonError(400, graph.message);

  const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "thread.dependencies.set",
    commandId: CommandId.make(`server:workstream-dependencies:${yield* crypto.randomUUIDv4}`),
    threadId: targetThreadId,
    blockedBy: graph.blockedBy ?? [],
    createdAt: now,
  } satisfies OrchestrationCommand);

  return HttpServerResponse.jsonUnsafe({
    threadId: targetThreadId,
    blockedBy: graph.blockedBy ?? [],
    ...(graph.warnings.length > 0 ? { warnings: graph.warnings } : {}),
  });
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

// Review gates (design §3): the single terminal call. Writes the report file
// and dispatches `thread.work.submit`; the decider derives the report pointer,
// the outcome record, and the lane/attention events in ONE transaction.
const handleWorkstreamSubmit = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const scope = yield* resolveWorkstreamScope();
  if (!scope) {
    return jsonError(401, "A valid provider-scoped Workstream credential is required.");
  }

  const body = (yield* request.json.pipe(
    Effect.orElseSucceed((): WorkstreamSubmitRequest => ({})),
  )) as WorkstreamSubmitRequest;
  const markdown = typeof body.markdown === "string" ? body.markdown : undefined;
  if (markdown === undefined || markdown.trim().length === 0) {
    return jsonError(400, "markdown is required.");
  }
  const outcome = body.outcome === undefined ? undefined : trimString(body.outcome);
  if (body.outcome !== undefined && outcome === undefined) {
    return jsonError(400, "outcome must be a non-empty string when present.");
  }
  if (
    body.contested !== undefined &&
    (!Array.isArray(body.contested) || !body.contested.every((entry) => trimString(entry)))
  ) {
    return jsonError(400, "contested must be an array of non-empty strings.");
  }
  const counts = body.counts as { mustFix?: unknown; niceToHave?: unknown } | undefined;
  const isCount = (value: unknown) =>
    typeof value === "number" && Number.isInteger(value) && value >= 0;
  if (counts !== undefined && (!isCount(counts.mustFix) || !isCount(counts.niceToHave))) {
    return jsonError(400, "counts must be { mustFix, niceToHave } with non-negative integers.");
  }

  // Routing mirror (shared `routeWorkSubmit`, the same pure decision the
  // decider makes): picks the per-round report file name for loop rounds
  // (risk R2 — conserve every round's prose) and lets the tool response echo
  // the routing decision (risk R5 — "you are not done yet" must be visible).
  const effectiveOutcome = outcome ?? "done";
  const snapshot = yield* (yield* ProjectionSnapshotQuery).getShellSnapshot();
  const self = snapshot.threads.find((thread) => thread.id === scope.threadId);
  const routing =
    self === undefined ? undefined : routeWorkSubmit(self, snapshot.threads, effectiveOutcome);

  // A child may submit only its OWN work; the report is always keyed to the
  // calling thread (no threadId override). Loop rounds write
  // `<threadId>.round-<n>.md`; round 0 / non-gate submits keep `<threadId>.md`.
  const reportPath = yield* writeWorkstreamReport(
    scope.threadId,
    markdown,
    routing?.decision === "loop" ? routing.round : null,
  );

  const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "thread.work.submit",
    commandId: CommandId.make(`server:workstream-submit:${yield* crypto.randomUUIDv4}`),
    threadId: scope.threadId,
    reportPath,
    ...(outcome !== undefined ? { outcome } : {}),
    ...(Array.isArray(body.contested)
      ? { contested: body.contested.map((entry) => (entry as string).trim()) }
      : {}),
    ...(counts !== undefined
      ? { counts: { mustFix: counts.mustFix as number, niceToHave: counts.niceToHave as number } }
      : {}),
    createdAt: now,
  } satisfies OrchestrationCommand);

  const decision = routing?.decision ?? (effectiveOutcome === "done" ? "terminal" : "yield");
  const disposition =
    decision === "terminal"
      ? "done"
      : decision === "attention"
        ? "needs_human"
        : decision === "loop"
          ? "routed"
          : decision === "resolve"
            ? "resolved"
            : "yielded";
  return HttpServerResponse.jsonUnsafe({
    threadId: scope.threadId,
    reportPath,
    outcome: effectiveOutcome,
    disposition,
    ...(routing !== undefined && decision === "loop"
      ? {
          routedTo: routing.routeTo,
          round: routing.round,
          // The source's findings route to the coder (rework); an intercepted
          // target rework-round submit routes back to the reviewer (reverify).
          leg: gateLoopTargetOf(self!) === routing.routeTo ? "rework" : "reverify",
        }
      : {}),
    ...(decision === "cap-breach" ? { reason: "cap-breach", round: routing?.round } : {}),
  });
}).pipe(
  Effect.catch((error: unknown) =>
    Effect.succeed(
      jsonError(500, error instanceof Error ? error.message : "Failed to submit Workstream work."),
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
  const engine = yield* OrchestrationEngineService;
  const threads = yield* collectGraphThreads();

  // Resolve the target to its absolute session path (bare id fallback) so the
  // read-only fork locates it regardless of which worktree/project it lives in;
  // retain the fork jsonl under userdata for deep inspection; and record the
  // resolved consult as a durable `thread.consult-recorded` event on the ASKER
  // (best-effort — a recording failure must never fail the consult response).
  const consult = (shell: (typeof threads)[number]) =>
    Effect.gen(function* () {
      const freshSessionId = yield* crypto.randomUUIDv4;
      const sessionId = piSessionIdForThread(shell.id);
      const startedAt = yield* DateTime.now;
      const { answer, forkSessionPath } = yield* askWorkstreamThread({
        binaryPath: settings.providers.pi.binaryPath,
        targetSessionId: resolveSessionFilePath(sessionId) ?? sessionId,
        freshSessionId,
        cwd: shell.worktreePath ?? config.cwd,
        question,
        timeoutMs: ASK_TIMEOUT_MS,
        forkRetentionDir: config.workstreamConsultsDir,
      });
      const finishedAt = yield* DateTime.now;
      yield* engine
        .dispatch({
          type: "thread.consult.record",
          commandId: CommandId.make(`server:consult-thread:${freshSessionId}`),
          threadId: scope.threadId,
          targetThreadId: shell.id,
          targetTitle: shell.title,
          question,
          answer,
          resolved: true,
          durationMs: Math.max(
            0,
            DateTime.toEpochMillis(finishedAt) - DateTime.toEpochMillis(startedAt),
          ),
          ...(forkSessionPath !== undefined ? { forkSessionPath } : {}),
          createdAt: DateTime.formatIso(finishedAt),
        } satisfies OrchestrationCommand)
        .pipe(
          Effect.catch((cause: unknown) =>
            Effect.logWarning("failed to record consult_thread event", {
              askerThreadId: scope.threadId,
              targetThreadId: shell.id,
              cause,
            }),
          ),
        );
      return answer;
    });

  if (threadId) {
    const target = ThreadId.make(threadId);
    const shell = threads.find((thread) => thread.id === target);
    if (shell === undefined) return jsonError(404, "Target thread was not found.");
    const answer = yield* consult(shell);
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
    const answer = yield* consult(shell);
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
export const workstreamPromptRouteLayer = HttpRouter.add(
  "POST",
  PROMPT_PATH,
  handleWorkstreamPrompt,
);
export const workstreamDependenciesRouteLayer = HttpRouter.add(
  "POST",
  DEPENDENCIES_PATH,
  handleWorkstreamSetDependencies,
);
export const workstreamSubmitRouteLayer = HttpRouter.add(
  "POST",
  SUBMIT_PATH,
  handleWorkstreamSubmit,
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
  workstreamPromptRouteLayer,
  workstreamDependenciesRouteLayer,
  workstreamSubmitRouteLayer,
  workstreamListRouteLayer,
  workstreamConsultThreadRouteLayer,
  setThreadTitleRouteLayer,
);
