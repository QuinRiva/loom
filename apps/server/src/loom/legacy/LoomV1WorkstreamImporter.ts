// @effect-diagnostics nodeBuiltinImport:off - one boot-time walk of the pi sessions root.
/**
 * The Loom V1 importer (plans/upstream-pull9-phase4-import/plan.mdx §1): a
 * startup phase piped onto upstream's `importLegacyShells`, so it runs after
 * every V1 thread has a V2 `thread.created` shell and before recovery and the
 * Loom reactors. Per V1 thread upstream imported and Loom's ledger
 * (`loom_legacy_imports`, migration 1051) has not seen, in one transaction: the
 * sidecar row (`loom_thread_workstream`, live workstream threads only), the
 * `subagent` lineage re-emit (every non-deleted child) with the provider fix
 * folded in, the binding to the thread's pi session file, and the ledger row.
 * Idempotent on every boot; re-run a thread by deleting its ledger row.
 *
 * @module loom/legacy/LoomV1WorkstreamImporter
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  defaultInstanceIdForDriver,
  EventId,
  GoalId,
  GoalTaskId,
  HandoffDestination,
  type LoomAttentionReason,
  type LoomThreadWorkstream,
  ModelSelection,
  OrchestrationV2AppThreadJson,
  PI_DEFAULT_MODEL,
  ProjectId,
  ThreadId,
  WorkOutcomeRecord,
  WorkstreamRoute,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import { PI_PROVIDER } from "../../orchestration-v2/Adapters/PiAdapterV2.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import { deriveProviderThread } from "../../orchestration-v2/IdAllocator.ts";
import { randomUuidV4 } from "../../orchestration-v2/RandomUuid.ts";
import {
  piSessionIdForThread,
  piSessionsRoot,
  readSessionHeaderId,
} from "../../provider/piSessionFiles.ts";
import { loomPaths } from "../loomPaths.ts";
import { readWorkstream, writeWorkstream } from "../projection/LoomStore.ts";

/** The pi instance, derived exactly as `PiAdapterV2` derives its default instance. */
const PI_INSTANCE_ID = defaultInstanceIdForDriver(PI_PROVIDER);

/** The `projection_threads` columns the mapping reads. */
export interface LegacyV1Thread {
  readonly thread_id: string;
  readonly project_id: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly archived_at: string | null;
  readonly deleted_at: string | null;
  readonly parent_thread_id: string | null;
  readonly goal_id: string | null;
  readonly anchor_task_id: string | null;
  readonly role: string | null;
  readonly purpose: string | null;
  readonly graph_key: string | null;
  readonly spawn_generation: string | null;
  readonly fork_from_thread_id: string | null;
  readonly continues_thread_id: string | null;
  readonly kickoff_brief_path: string | null;
  readonly brief: string | null;
  readonly plan_lane: string;
  readonly plan_lane_since: string | null;
  readonly attention: string;
  readonly blocked_by: string;
  readonly dependencies_since: string | null;
  readonly routes: string;
  readonly gate_rounds: number;
  readonly pending_rework: number;
  readonly last_outcome: string | null;
  readonly report_path: string | null;
  readonly handoff_destinations: string;
  readonly model_selection_json: string | null;
}

export type LegacyImportStatus =
  | "imported"
  | "archived-child"
  | "archived-root"
  | "skipped:deleted"
  | "skipped:not-workstream";

/** Everything the pure mapping reads besides the row itself. */
export interface LegacyMappingContext {
  /** Every V1 thread, by id (parent walks, dependency and route targets). */
  readonly threads: ReadonlyMap<string, LegacyV1Thread>;
  /** `loom_goals` goal id → project id. */
  readonly goalProjects: ReadonlyMap<string, string>;
  /** `loom_goal_tasks` task id → goal id. */
  readonly taskGoals: ReadonlyMap<string, string>;
  /** `${parentThreadId}\u0000${graphKey}` → the thread whose sidecar row holds it. */
  readonly takenGraphKeys: ReadonlyMap<string, string>;
  readonly briefsDir: string;
  readonly fileExists: (path: string) => boolean;
}

export interface LegacyThreadMapping {
  readonly status: LegacyImportStatus;
  /** The V1 parent (lineage target) for a non-deleted child; null otherwise. */
  readonly parentThreadId: ThreadId | null;
  /** Top of the V1 parent chain; the thread itself for a root. */
  readonly rootThreadId: ThreadId;
  readonly sidecar: LoomThreadWorkstream | null;
  /** A pre-1026 brief (text, no path) to write before the sidecar lands. */
  readonly briefFile: { readonly path: string; readonly text: string } | null;
  readonly warnings: ReadonlyArray<string>;
}

const STORED_ATTENTION = new Set<string>(["error", "awaiting_acceptance", "needs_guidance"]);

const parseJson = (json: string | null): unknown => {
  if (json === null) return undefined;
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
};
const stringArray = (json: string): ReadonlyArray<string> => {
  const value = parseJson(json);
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
};
const text = (value: string | null) => value?.trim() || null;

const decodeRoute = Schema.decodeUnknownOption(WorkstreamRoute);
const decodeOutcome = Schema.decodeUnknownOption(WorkOutcomeRecord);
const decodeHandoffs = Schema.decodeUnknownOption(Schema.Array(HandoffDestination));
const decodeModelSelection = Schema.decodeUnknownOption(ModelSelection);
const encodeWarnings = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeStoredThread = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);

/** V1 rows that get a sidecar row: live, with a parent, a goal or a role. */
const isWorkstreamRow = (row: LegacyV1Thread) =>
  row.deleted_at === null &&
  row.archived_at === null &&
  (row.parent_thread_id !== null || row.goal_id !== null || row.role !== null);

/**
 * The pure V1 → Loom mapping (plan §1 column mapping and six-lane mapping) for
 * one thread. `kickoffAt` is the thread's first turn request or user message
 * (null = never started).
 */
export const mapLegacyThread = (
  row: LegacyV1Thread,
  kickoffAt: string | null,
  ctx: LegacyMappingContext,
): LegacyThreadMapping => {
  const warnings: Array<string> = [];
  const threadId = ThreadId.make(row.thread_id);
  const seen = new Set([row.thread_id]);
  let top = row.thread_id;
  for (let next = row.parent_thread_id; next !== null && !seen.has(next);) {
    seen.add(next);
    top = next;
    const parent = ctx.threads.get(next);
    if (parent === undefined) warnings.push(`ancestor ${next} is not a V1 thread`);
    else if (parent.deleted_at !== null && next === row.parent_thread_id)
      warnings.push(`parent ${next} is deleted`);
    next = parent?.parent_thread_id ?? null;
  }
  const isChild = row.parent_thread_id !== null;
  const base = {
    parentThreadId:
      isChild && row.deleted_at === null ? ThreadId.make(row.parent_thread_id!) : null,
    rootThreadId: ThreadId.make(top),
    briefFile: null,
  };
  if (row.deleted_at !== null)
    return { ...base, status: "skipped:deleted", sidecar: null, warnings: [] };
  if (row.archived_at !== null)
    return {
      ...base,
      status: isChild ? "archived-child" : "archived-root",
      sidecar: null,
      warnings,
    };
  if (!isWorkstreamRow(row))
    return { ...base, status: "skipped:not-workstream", sidecar: null, warnings };

  const started = kickoffAt !== null;
  const since = row.plan_lane_since ?? row.updated_at;
  const terminal = row.plan_lane === "done" || row.plan_lane === "cancelled";
  if (!["planned", "ready", "in_progress", "yielded", "done", "cancelled"].includes(row.plan_lane))
    warnings.push(`unknown plan_lane ${row.plan_lane} read as in progress`);

  const goalId =
    row.goal_id !== null && ctx.goalProjects.get(row.goal_id) === row.project_id
      ? row.goal_id
      : null;
  if (row.goal_id !== null && goalId === null) warnings.push(`goal ${row.goal_id} dropped`);
  const anchorTaskId =
    goalId !== null &&
    row.anchor_task_id !== null &&
    ctx.taskGoals.get(row.anchor_task_id) === goalId
      ? row.anchor_task_id
      : null;
  if (row.anchor_task_id !== null && anchorTaskId === null)
    warnings.push(`anchor task ${row.anchor_task_id} dropped`);

  let graphKey = text(row.graph_key);
  const holder = ctx.takenGraphKeys.get(`${row.parent_thread_id}\u0000${graphKey}`);
  if (isChild && graphKey !== null && holder !== undefined && holder !== row.thread_id) {
    warnings.push(`graph key ${graphKey} duplicates a sibling's; dropped`);
    graphKey = null;
  }

  // A dependency on a thread without a sidecar row: dropped when V1 had it done (satisfied);
  // otherwise kept and flagged (DL-511: V2 never gates on an absent id, so an unstarted
  // dependent is also held — the only stored fact that keeps it from starting).
  let wedged = false;
  const blockedBy = stringArray(row.blocked_by).filter((depId) => {
    const dep = ctx.threads.get(depId);
    if (dep !== undefined && isWorkstreamRow(dep)) return true;
    if (dep?.plan_lane === "done") {
      warnings.push(`dependency ${depId} (done, no sidecar row) dropped`);
      return false;
    }
    warnings.push(
      `dependency ${depId} (${dep?.plan_lane ?? "unknown"}, no sidecar row) kept: unsatisfiable`,
    );
    wedged = true;
    return true;
  });

  const rawRoutes = parseJson(row.routes);
  const routes = (Array.isArray(rawRoutes) ? rawRoutes : []).flatMap((raw: unknown) => {
    const route = Option.getOrUndefined(decodeRoute(raw));
    const target = route?.to === undefined ? undefined : ctx.threads.get(route.to);
    if (
      route !== undefined &&
      (route.to === undefined || (target !== undefined && isWorkstreamRow(target)))
    )
      return [route];
    warnings.push(`route ${JSON.stringify(raw)} dropped`);
    return [];
  });

  const rawOutcome = parseJson(row.last_outcome) as Record<string, unknown> | undefined;
  const lastOutcome =
    rawOutcome === undefined
      ? null
      : Option.getOrNull(
          decodeOutcome({
            ...Object.fromEntries(
              Object.entries(rawOutcome).filter(([key]) => key !== "recordedByEventId"),
            ),
            eventId: null,
          }),
        );
  if (rawOutcome !== undefined && lastOutcome === null)
    warnings.push("last_outcome undecodable; dropped");

  const handoffDestinations = Option.getOrElse(
    decodeHandoffs(parseJson(row.handoff_destinations)),
    () => {
      warnings.push("handoff_destinations undecodable; dropped");
      return [];
    },
  );

  let kickoffBriefPath = text(row.kickoff_brief_path);
  let briefFile: LegacyThreadMapping["briefFile"] = null;
  if (kickoffBriefPath !== null && !ctx.fileExists(kickoffBriefPath)) {
    warnings.push(`brief file ${kickoffBriefPath} missing${started ? "" : "; unbriefed"}`);
    if (!started) kickoffBriefPath = null;
  } else if (kickoffBriefPath === null && isChild && !started && text(row.brief) !== null) {
    kickoffBriefPath = NodePath.join(ctx.briefsDir, `${row.thread_id}.md`);
    briefFile = { path: kickoffBriefPath, text: row.brief! };
  }
  const reportPath = text(row.report_path);
  if (reportPath !== null && !ctx.fileExists(reportPath))
    warnings.push(`report file ${reportPath} missing`);

  const held = !terminal && isChild && !started && (row.plan_lane === "planned" || wedged);
  const attention = terminal
    ? []
    : ([
        ...new Set([
          ...stringArray(row.attention).filter((reason) => STORED_ATTENTION.has(reason)),
          ...(row.plan_lane === "yielded" ? ["awaiting_orchestrator"] : []),
          ...(wedged ? ["needs_guidance"] : []),
        ]),
      ] as Array<LoomAttentionReason>);

  return {
    ...base,
    status: "imported",
    briefFile,
    warnings,
    sidecar: {
      threadId,
      projectId: ProjectId.make(row.project_id),
      goalId: goalId === null ? null : GoalId.make(goalId),
      anchorTaskId: anchorTaskId === null ? null : GoalTaskId.make(anchorTaskId),
      parentThreadId: isChild ? ThreadId.make(row.parent_thread_id!) : null,
      rootThreadId: base.rootThreadId,
      role: text(row.role),
      purpose: text(row.purpose),
      graphKey,
      kickoffBriefPath,
      held,
      heldSince: held ? since : null,
      outcome: terminal ? (row.plan_lane as "done" | "cancelled") : null,
      outcomeAt: terminal ? since : null,
      outcomeEventId: null,
      kickoffAt,
      attention,
      attentionEpisodes: {},
      blockedBy: blockedBy.map((id) => ThreadId.make(id)),
      dependenciesSince: blockedBy.length > 0 ? row.dependencies_since : null,
      spawnGeneration: text(row.spawn_generation),
      forkFromThreadId:
        row.fork_from_thread_id === null ? null : ThreadId.make(row.fork_from_thread_id),
      continuesThreadId:
        row.continues_thread_id === null ? null : ThreadId.make(row.continues_thread_id),
      routes,
      gateRounds: row.gate_rounds,
      pendingRework: row.pending_rework !== 0,
      lastOutcome,
      lastRoute: null,
      reportPath,
      handoffDestinations,
      notifySendLog: [],
      archivedAt: null,
      unarchivedAt: null,
      unarchivedEventId: null,
      deletedAt: null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
  };
};

/** The model for a provider-fixed thread: V1's own pi selection if it had one, else Loom's default. */
const piModelSelection = (json: string | null): ModelSelection => {
  const raw = parseJson(json) as
    | { instanceId?: unknown; provider?: unknown; model?: unknown }
    | undefined;
  const decoded = Option.getOrUndefined(decodeModelSelection(raw));
  if (decoded?.instanceId === PI_INSTANCE_ID) return decoded;
  const isPi = (raw?.instanceId ?? raw?.provider) === PI_INSTANCE_ID;
  return {
    instanceId: PI_INSTANCE_ID,
    model:
      isPi && typeof raw?.model === "string" && raw.model.trim() !== ""
        ? raw.model
        : PI_DEFAULT_MODEL,
  };
};

/** pi's session root: `PI_CODING_AGENT_SESSION_DIR`, else `<PI_CODING_AGENT_DIR>/sessions`, else `~/.pi/agent/sessions`. */
export const piSessionsRootFromEnv = (env: NodeJS.ProcessEnv = process.env) =>
  env.PI_CODING_AGENT_SESSION_DIR ||
  (env.PI_CODING_AGENT_DIR ? NodePath.join(env.PI_CODING_AGENT_DIR, "sessions") : piSessionsRoot());

/**
 * `<sessionId>` → absolute path for every `<timestamp>_<sessionId>.jsonl` at depth 1
 * (a flat root) or 2 (pi's slug directories); the newest mtime wins a duplicate.
 */
export const indexPiSessions = (root: string): ReadonlyMap<string, string> => {
  const index = new Map<string, { readonly path: string; mtimeMs?: number }>();
  const add = (dir: string, name: string) => {
    const underscore = name.indexOf("_");
    if (!name.endsWith(".jsonl") || underscore === -1) return;
    const id = name.slice(underscore + 1, -".jsonl".length);
    const path = NodePath.join(dir, name);
    const current = index.get(id);
    if (current === undefined) return void index.set(id, { path });
    const mtime = (entry: { readonly path: string; mtimeMs?: number }) =>
      (entry.mtimeMs ??= NodeFS.statSync(entry.path).mtimeMs);
    const candidate = { path };
    if (mtime(candidate) > mtime(current)) index.set(id, candidate);
  };
  const entries = (dir: string) => {
    try {
      return NodeFS.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  for (const entry of entries(root)) {
    if (entry.isDirectory()) {
      const dir = NodePath.join(root, entry.name);
      for (const file of entries(dir)) if (file.isFile()) add(dir, file.name);
    } else if (entry.isFile()) add(root, entry.name);
  }
  return new Map([...index].map(([id, entry]) => [id, entry.path]));
};

export type LegacySessionStatus =
  | "bound"
  | "missing"
  | "corrupt"
  | "not-pi"
  | "deleted"
  | "already-bound";

const SESSION_COUNT = {
  bound: "bindings",
  "already-bound": "alreadyBound",
  missing: "missing",
  corrupt: "corrupt",
  "not-pi": "notPi",
  deleted: "deleted",
} as const;

const V1_COLUMNS = `thread_id, project_id, created_at, updated_at, archived_at, deleted_at,
  parent_thread_id, goal_id, anchor_task_id, role, purpose, graph_key, spawn_generation,
  fork_from_thread_id, continues_thread_id, kickoff_brief_path, brief, plan_lane, plan_lane_since,
  attention, blocked_by, dependencies_since, routes, gate_rounds, pending_rework, last_outcome,
  report_path, handoff_destinations, model_selection_json`;

/**
 * The startup phase. Logs one summary line ("Loom V1 workstream import") naming
 * the sessions root it indexed and the counts; a per-thread failure is logged
 * with the thread id and the phase continues.
 */
const makeReconcile = (
  sql: SqlClient.SqlClient,
  eventSink: EventSink.EventSinkV2Shape,
  stateDir: string,
) =>
  Effect.gen(function* () {
    const pending = yield* sql.unsafe<LegacyV1Thread>(`
    SELECT ${V1_COLUMNS} FROM projection_threads
    WHERE thread_id IN (
      SELECT li.thread_id FROM orchestration_v2_legacy_imports li
      WHERE NOT EXISTS (SELECT 1 FROM loom_legacy_imports l WHERE l.thread_id = li.thread_id))
    ORDER BY created_at ASC, thread_id ASC`);
    const sessionsRoot = piSessionsRootFromEnv();
    const counts = {
      considered: pending.length,
      sidecars: 0,
      lineageReemits: 0,
      providerFixes: 0,
      bindings: 0,
      alreadyBound: 0,
      missing: 0,
      corrupt: 0,
      notPi: 0,
      deleted: 0,
      failed: 0,
    };
    if (pending.length === 0) {
      return yield* Effect.logInfo("Loom V1 workstream import", { sessionsRoot, ...counts });
    }

    const threads = new Map(
      (yield* sql.unsafe<LegacyV1Thread>(`SELECT ${V1_COLUMNS} FROM projection_threads`)).map(
        (row) => [row.thread_id, row] as const,
      ),
    );
    const goalProjects = new Map(
      (yield* sql<{
        goal_id: string;
        project_id: string;
      }>`SELECT goal_id, project_id FROM loom_goals`).map(
        (row) => [row.goal_id, row.project_id] as const,
      ),
    );
    const taskGoals = new Map(
      (yield* sql<{
        task_id: string;
        goal_id: string;
      }>`SELECT task_id, goal_id FROM loom_goal_tasks`).map(
        (row) => [row.task_id, row.goal_id] as const,
      ),
    );
    const takenGraphKeys = new Map(
      (yield* sql<{
        key: string;
        thread_id: string;
      }>`SELECT parent_thread_id || char(0) || graph_key AS key, thread_id
      FROM loom_thread_workstream WHERE parent_thread_id IS NOT NULL AND graph_key IS NOT NULL`).map(
        (row) => [row.key, row.thread_id] as const,
      ),
    );
    const ctx: LegacyMappingContext = {
      threads,
      goalProjects,
      taskGoals,
      takenGraphKeys,
      briefsDir: loomPaths({ stateDir }).workstreamBriefsDir,
      fileExists: NodeFS.existsSync,
    };
    const indexStarted = yield* Clock.currentTimeMillis;
    if (!NodeFS.existsSync(sessionsRoot))
      yield* Effect.logWarning("Loom V1 workstream import: the pi sessions root does not exist", {
        sessionsRoot,
      });
    const sessions = indexPiSessions(sessionsRoot);
    const indexMs = (yield* Clock.currentTimeMillis) - indexStarted;
    const now = yield* DateTime.now;
    const importedAt = DateTime.formatIso(now);

    const importThread = (row: LegacyV1Thread) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make(row.thread_id);
        const [turn] = yield* sql<{ at: string | null }>`
        SELECT MIN(requested_at) AS at FROM projection_turns WHERE thread_id = ${threadId}`;
        const [message] = yield* sql<{ at: string | null }>`
        SELECT MIN(created_at) AS at FROM projection_thread_messages
        WHERE thread_id = ${threadId} AND role = 'user'`;
        const mapping = mapLegacyThread(row, turn?.at ?? message?.at ?? null, ctx);
        const [stored] = yield* sql<{ payload_json: string }>`
        SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
        const current = Option.getOrThrowWith(
          decodeStoredThread(stored?.payload_json),
          () => new Error(`no decodable V2 thread row for ${threadId}`),
        );

        let session: { status: LegacySessionStatus; path: string | null } = {
          status: "deleted",
          path: null,
        };
        if (row.deleted_at === null) {
          const [bound] = yield* sql`
          SELECT 1 FROM orchestration_v2_projection_provider_threads
          WHERE thread_id = ${threadId} AND driver = ${PI_PROVIDER}
            AND json_extract(payload_json, '$.nativeThreadRef.strength') = 'strong' LIMIT 1`;
          const sessionId = piSessionIdForThread(threadId);
          const path = sessions.get(sessionId);
          session =
            bound !== undefined
              ? { status: "already-bound", path: null }
              : path === undefined
                ? {
                    status: current.providerInstanceId === PI_INSTANCE_ID ? "missing" : "not-pi",
                    path: null,
                  }
                : readSessionHeaderId(path) === sessionId
                  ? { status: "bound", path }
                  : { status: "corrupt", path: null };
        }
        const providerFix =
          session.status === "bound" && current.providerInstanceId !== PI_INSTANCE_ID
            ? {
                providerInstanceId: PI_INSTANCE_ID,
                modelSelection: piModelSelection(row.model_selection_json),
              }
            : undefined;
        const wantsLineage =
          mapping.parentThreadId !== null && current.lineage.relationshipToParent !== "subagent";
        const warnings = [
          ...mapping.warnings,
          ...(providerFix ? [`provider fixed from ${current.providerInstanceId}`] : []),
        ];

        const written = yield* sql.withTransaction(
          Effect.gen(function* () {
            const sidecarWritten =
              mapping.sidecar !== null && (yield* readWorkstream(sql, threadId)) === null;
            if (sidecarWritten) {
              if (mapping.briefFile !== null) {
                NodeFS.mkdirSync(NodePath.dirname(mapping.briefFile.path), { recursive: true });
                NodeFS.writeFileSync(mapping.briefFile.path, mapping.briefFile.text);
              }
              yield* writeWorkstream(sql, mapping.sidecar!);
            }
            if (wantsLineage || providerFix !== undefined) {
              yield* eventSink.write({
                events: [
                  {
                    id: EventId.make(
                      `loom-import:v1:thread:${threadId}:re-emit:${yield* randomUuidV4}`,
                    ),
                    type: "thread.metadata-updated",
                    threadId,
                    providerInstanceId:
                      providerFix?.providerInstanceId ?? current.providerInstanceId,
                    occurredAt: now,
                    payload: {
                      ...current,
                      ...(wantsLineage
                        ? {
                            lineage: {
                              parentThreadId: mapping.parentThreadId,
                              relationshipToParent: "subagent" as const,
                              rootThreadId: mapping.rootThreadId,
                            },
                          }
                        : {}),
                      ...providerFix,
                    },
                  },
                ],
              });
            }
            if (session.status === "bound") {
              yield* eventSink.write({
                events: [
                  {
                    id: EventId.make(`loom-import:v1:provider-thread:${threadId}`),
                    type: "provider-thread.updated",
                    threadId,
                    driver: PI_PROVIDER,
                    providerInstanceId: PI_INSTANCE_ID,
                    occurredAt: now,
                    payload: {
                      id: deriveProviderThread({
                        driver: PI_PROVIDER,
                        nativeThreadId: session.path!,
                      }),
                      driver: PI_PROVIDER,
                      providerInstanceId: PI_INSTANCE_ID,
                      providerSessionId: null,
                      appThreadId: threadId,
                      ownerNodeId: null,
                      nativeThreadRef: {
                        driver: PI_PROVIDER,
                        nativeId: session.path!,
                        strength: "strong",
                      },
                      nativeConversationHeadRef: null,
                      status: "idle",
                      firstRunOrdinal: null,
                      lastRunOrdinal: null,
                      handoffIds: [],
                      forkedFrom: null,
                      pendingBackgroundTasks: [],
                      contextUsage: null,
                      nativeMetadata: null,
                      createdAt: current.createdAt,
                      updatedAt: current.updatedAt,
                    },
                  },
                ],
              });
            }
            yield* sql`INSERT INTO loom_legacy_imports ${sql.insert({
              thread_id: threadId,
              imported_at: importedAt,
              status: mapping.status,
              sidecar_written: sidecarWritten ? 1 : 0,
              lineage_reemitted: wantsLineage ? 1 : 0,
              session_status: session.status,
              session_path: session.path,
              warnings_json: encodeWarnings(warnings),
            })}`;
            return sidecarWritten;
          }),
        );
        if (written && mapping.sidecar !== null && mapping.sidecar.graphKey !== null)
          takenGraphKeys.set(
            `${mapping.sidecar.parentThreadId}\u0000${mapping.sidecar.graphKey}`,
            threadId,
          );
        counts.sidecars += written ? 1 : 0;
        counts.lineageReemits += wantsLineage ? 1 : 0;
        counts.providerFixes += providerFix ? 1 : 0;
        counts[SESSION_COUNT[session.status]] += 1;
      });

    for (const row of pending) {
      yield* importThread(row).pipe(
        Effect.catchCause((cause) => {
          counts.failed += 1;
          return Effect.logWarning("Loom V1 workstream import failed for a thread; skipped", {
            threadId: row.thread_id,
            cause,
          });
        }),
      );
    }
    yield* Effect.logInfo("Loom V1 workstream import", {
      sessionsRoot,
      indexedSessionFiles: sessions.size,
      indexMs,
      ...counts,
    });
  });

export class LoomV1WorkstreamImporter extends Context.Service<
  LoomV1WorkstreamImporter,
  { readonly reconcile: ReturnType<typeof makeReconcile> }
>()("t3/loom/legacy/LoomV1WorkstreamImporter") {}

export const layer = Layer.effect(
  LoomV1WorkstreamImporter,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const eventSink = yield* EventSink.EventSinkV2;
    const { stateDir } = yield* ServerConfig.ServerConfig;
    return { reconcile: makeReconcile(sql, eventSink, stateDir) };
  }),
);

/** The startup phase, as `serverRuntimeStartup.ts` pipes it after upstream's shell import. */
export const reconcile = Effect.flatMap(LoomV1WorkstreamImporter, (importer) => importer.reconcile);
