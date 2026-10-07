/**
 * LoomStoreV2 — reads and plain-table writes over Loom's sidecar tables
 * (plans/upstream-pull9-phase2-substrate/plan.mdx §4): the workstream record
 * the arm, the re-drive planner and the dispatcher read; goal and task CRUD for
 * the Phase 3a handlers; the summaries the shell join attaches.
 *
 * `loom_thread_workstream` is written ONLY by the projector
 * (`loomProjection.ts`) inside V2's commit transaction — and once per V1 thread
 * by the Phase 4 importer (`loom/legacy/LoomV1WorkstreamImporter.ts`), which
 * inserts imported rows directly at first boot; this module owns its
 * row ↔ record codec, which the projector shares. Reads see committed state
 * only (no pending-event overlay).
 *
 * @module loom/projection/LoomStore
 */
import {
  EventId,
  GoalId,
  GoalTaskId,
  IsoDateTime,
  LoomGoal,
  LoomGoalTask,
  LoomContextUsage,
  LoomOutcome,
  LoomRouteKind,
  LoomRouteRecord,
  LoomThreadConsultSummary,
  type LoomThreadHistoryEntry,
  LoomThreadPeerMessageSummary,
  LoomThreadShellFields,
  LoomThreadWorkstream,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  WorkOutcomeRecord,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";

export class LoomStoreError extends Schema.TaggedError<LoomStoreError>()("LoomStoreError", {
  operation: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Loom store operation ${this.operation} failed.`;
  }
}

// ---------------------------------------------------------------------------
// Row ↔ record codec (the one place the column layout is spelled out)
// ---------------------------------------------------------------------------

/** `loom_thread_workstream` as stored: bits for booleans, JSON text for structures. */
export const LoomThreadWorkstreamRow = LoomThreadWorkstream.mapFields((fields) => ({
  ...fields,
  held: Schema.BooleanFromBit,
  pendingRework: Schema.BooleanFromBit,
  attention: Schema.fromJsonString(fields.attention),
  attentionEpisodes: Schema.fromJsonString(fields.attentionEpisodes),
  blockedBy: Schema.fromJsonString(fields.blockedBy),
  routes: Schema.fromJsonString(fields.routes),
  lastOutcome: Schema.NullOr(Schema.fromJsonString(WorkOutcomeRecord)),
  lastRoute: Schema.NullOr(Schema.fromJsonString(LoomRouteRecord)),
  handoffDestinations: Schema.fromJsonString(fields.handoffDestinations),
  notifySendLog: Schema.fromJsonString(fields.notifySendLog),
}));

const WORKSTREAM_COLUMNS = {
  thread_id: "threadId",
  project_id: "projectId",
  goal_id: "goalId",
  anchor_task_id: "anchorTaskId",
  parent_thread_id: "parentThreadId",
  root_thread_id: "rootThreadId",
  role: "role",
  purpose: "purpose",
  graph_key: "graphKey",
  kickoff_brief_path: "kickoffBriefPath",
  held: "held",
  held_since: "heldSince",
  outcome: "outcome",
  outcome_at: "outcomeAt",
  outcome_event_id: "outcomeEventId",
  kickoff_at: "kickoffAt",
  attention: "attention",
  attention_episodes: "attentionEpisodes",
  blocked_by: "blockedBy",
  dependencies_since: "dependenciesSince",
  spawn_generation: "spawnGeneration",
  fork_from_thread_id: "forkFromThreadId",
  continues_thread_id: "continuesThreadId",
  routes: "routes",
  gate_rounds: "gateRounds",
  pending_rework: "pendingRework",
  last_outcome: "lastOutcome",
  last_route: "lastRoute",
  report_path: "reportPath",
  handoff_destinations: "handoffDestinations",
  notify_send_log: "notifySendLog",
  archived_at: "archivedAt",
  unarchived_at: "unarchivedAt",
  unarchived_event_id: "unarchivedEventId",
  deleted_at: "deletedAt",
  created_at: "createdAt",
  updated_at: "updatedAt",
} as const satisfies Record<string, keyof LoomThreadWorkstream>;

const workstreamSelectList = Object.entries(WORKSTREAM_COLUMNS)
  .map(([column, key]) => `w.${column} AS "${key}"`)
  .join(", ");
const workstreamUpdateList = Object.keys(WORKSTREAM_COLUMNS)
  .filter((column) => column !== "thread_id" && column !== "created_at")
  .map((column) => `${column} = excluded.${column}`)
  .join(", ");

const decodeWorkstreamRows = Schema.decodeUnknownEffect(Schema.Array(LoomThreadWorkstreamRow));
const encodeWorkstreamRow = Schema.encodeEffect(LoomThreadWorkstreamRow);

/** Rows of `loom_thread_workstream w` matching `where` (a fragment over alias `w`). */
export const selectWorkstreams = (sql: SqlClient.SqlClient, where: Statement.Fragment) =>
  sql`SELECT ${sql.literal(workstreamSelectList)} FROM loom_thread_workstream w WHERE ${where}
      ORDER BY w.created_at ASC, w.thread_id ASC`.pipe(Effect.flatMap(decodeWorkstreamRows));

export const readWorkstream = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  selectWorkstreams(sql, sql`w.thread_id = ${threadId}`).pipe(
    Effect.map((rows) => rows[0] ?? null),
  );

/** Full-row upsert; `created_at` is kept from the first write. */
export const writeWorkstream = (sql: SqlClient.SqlClient, record: LoomThreadWorkstream) =>
  encodeWorkstreamRow(record).pipe(
    Effect.flatMap(
      (encoded) => sql`
        INSERT INTO loom_thread_workstream ${sql.insert(
          Object.fromEntries(
            Object.entries(WORKSTREAM_COLUMNS).map(([column, key]) => [column, encoded[key]]),
          ),
        )}
        ON CONFLICT (thread_id) DO UPDATE SET ${sql.literal(workstreamUpdateList)}
      `,
    ),
  );

/** A row for a thread that has none yet (a root's first goal-set, a spawn's created event). */
export const emptyWorkstream = (input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly parentThreadId: ThreadId | null;
  readonly rootThreadId: ThreadId;
  readonly at: IsoDateTime;
}): LoomThreadWorkstream => ({
  ...input,
  goalId: null,
  anchorTaskId: null,
  role: null,
  purpose: null,
  graphKey: null,
  kickoffBriefPath: null,
  held: false,
  heldSince: null,
  outcome: null,
  outcomeAt: null,
  outcomeEventId: null,
  kickoffAt: null,
  attention: [],
  attentionEpisodes: {},
  blockedBy: [],
  dependenciesSince: null,
  spawnGeneration: null,
  forkFromThreadId: null,
  continuesThreadId: null,
  routes: [],
  gateRounds: 0,
  pendingRework: false,
  lastOutcome: null,
  lastRoute: null,
  reportPath: null,
  handoffDestinations: [],
  notifySendLog: [],
  archivedAt: null,
  unarchivedAt: null,
  unarchivedEventId: null,
  deletedAt: null,
  createdAt: input.at,
  updatedAt: input.at,
});

const GoalRow = Schema.Struct({
  id: GoalId,
  projectId: ProjectId,
  slug: Schema.String,
  title: Schema.String,
  description: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  deletedAt: Schema.NullOr(IsoDateTime),
});
type GoalRow = typeof GoalRow.Type;

const TaskRow = Schema.Struct({
  id: GoalTaskId,
  goalId: GoalId,
  parentTaskId: Schema.NullOr(GoalTaskId),
  position: Schema.Number,
  text: Schema.String,
  done: Schema.BooleanFromBit,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
type TaskRow = typeof TaskRow.Type;

const decodeGoalRows = Schema.decodeUnknownEffect(Schema.Array(GoalRow));
const decodeTaskRows = Schema.decodeUnknownEffect(Schema.Array(TaskRow));

/** Assemble live task rows into the nested tree (siblings by position, then age, then id). */
const buildTaskTree = (rows: ReadonlyArray<TaskRow>): ReadonlyArray<LoomGoalTask> => {
  const byParent = Map.groupBy(rows, (row): string => row.parentTaskId ?? "");
  const build = (parent: string): ReadonlyArray<LoomGoalTask> =>
    (byParent.get(parent) ?? [])
      .toSorted(
        (a, b) =>
          a.position - b.position ||
          a.createdAt.localeCompare(b.createdAt) ||
          a.id.localeCompare(b.id),
      )
      .map((row) => ({ ...row, deletedAt: null, children: build(row.id) }));
  return build("");
};

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export interface LoomTreeQueryOptions {
  readonly includeArchived?: boolean;
  readonly includeDeleted?: boolean;
}

/** A goal's editable fields; the store stamps `createdAt` / `updatedAt`. */
export interface LoomGoalInput {
  readonly id: GoalId;
  readonly projectId: ProjectId;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
}

/** One task as a handler submits it; the store stamps timestamps. */
export interface LoomGoalTaskInput {
  readonly id: GoalTaskId;
  readonly parentTaskId: GoalTaskId | null;
  readonly text: string;
  readonly done: boolean;
  readonly position: number;
}

/** A still-undelivered mcp__t3-code__notify_thread message, oldest first. */
export interface LoomPendingPeerMessage {
  readonly recordId: string;
  readonly senderThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
  readonly framedMessage: string;
  readonly createdAt: IsoDateTime;
}

type Op<A> = Effect.Effect<A, LoomStoreError>;

export interface LoomStoreV2Shape {
  readonly getWorkstream: (threadId: ThreadId) => Op<LoomThreadWorkstream | null>;
  /** The subtree sharing `rootThreadId`; archived and deleted rows excluded unless asked for. */
  readonly listWorkstreamTree: (
    rootThreadId: ThreadId,
    options?: LoomTreeQueryOptions,
  ) => Op<ReadonlyArray<LoomThreadWorkstream>>;
  readonly listChildren: (
    parentThreadId: ThreadId,
    options?: LoomTreeQueryOptions,
  ) => Op<ReadonlyArray<LoomThreadWorkstream>>;
  /** Every row neither archived nor deleted. */
  readonly listActiveWorkstreams: () => Op<ReadonlyArray<LoomThreadWorkstream>>;
  /**
   * The re-drive planner's input: live rows, plus every cancelled / archived /
   * deleted / unarchived episode root whose in-scope descendants have not
   * followed it, plus those roots' descendants.
   */
  readonly listReDriveInput: () => Op<ReadonlyArray<LoomThreadWorkstream>>;
  /** Loom threads with a held queued V2 run. */
  readonly listThreadsWithHeldQueue: () => Op<ReadonlyArray<ThreadId>>;
  readonly goals: {
    /** Any state, tasks live only. */
    readonly get: (goalId: GoalId) => Op<LoomGoal | null>;
    /** Deleted goals excluded unless asked for. */
    readonly listByProject: (
      projectId: ProjectId,
      options?: { readonly includeDeleted?: boolean },
    ) => Op<ReadonlyArray<LoomGoal>>;
    readonly upsert: (goal: LoomGoalInput) => Op<LoomGoal>;
    readonly archive: (goalId: GoalId) => Op<LoomGoal | null>;
    readonly unarchive: (goalId: GoalId) => Op<LoomGoal | null>;
    readonly softDelete: (goalId: GoalId) => Op<LoomGoal | null>;
    /** Returns the goals this call deleted. */
    readonly softDeleteByProject: (projectId: ProjectId) => Op<ReadonlyArray<LoomGoal>>;
  };
  readonly tasks: {
    /** The live tree (roots with nested `children`). */
    readonly listByGoal: (goalId: GoalId) => Op<ReadonlyArray<LoomGoalTask>>;
    /** The goal's tombstoned tasks, flat: what a rewrite may restore by resubmitting an id. */
    readonly listDeleted: (
      goalId: GoalId,
    ) => Op<ReadonlyArray<Omit<LoomGoalTask, "children" | "deletedAt">>>;
    /** The submitted list IS the tree: upserts every entry (restoring tombstoned ones), tombstones the live rest. */
    readonly replaceTree: (
      goalId: GoalId,
      entries: ReadonlyArray<LoomGoalTaskInput>,
    ) => Op<ReadonlyArray<LoomGoalTask>>;
    readonly upsert: (
      task: LoomGoalTaskInput & { readonly goalId: GoalId },
    ) => Op<ReadonlyArray<LoomGoalTask>>;
    /** Tombstones the task and its subtree. */
    readonly markDeleted: (goalId: GoalId, taskId: GoalTaskId) => Op<ReadonlyArray<LoomGoalTask>>;
  };
  /** One query per table for the whole batch; threads without a row are absent. */
  readonly shellFields: (
    threadIds: ReadonlyArray<ThreadId>,
  ) => Op<ReadonlyMap<ThreadId, LoomThreadShellFields>>;
  /**
   * The thread's event history, oldest first (`LoomThreadHistoryEntry`): each
   * outcome with the report its submit set, flags, gate routes and plan
   * outcomes. Read from the event log, V1-imported and V2 events alike: the
   * sidecar keeps only the latest of each.
   */
  readonly history: (threadId: ThreadId) => Op<ReadonlyArray<LoomThreadHistoryEntry>>;
  readonly consults: {
    /** Per-target consult summaries for the asker, newest first. */
    readonly listByAsker: (askerThreadId: ThreadId) => Op<ReadonlyArray<LoomThreadConsultSummary>>;
  };
  readonly peerMessages: {
    /** Pending messages (all targets when omitted), oldest first. */
    readonly listPending: (targetThreadId?: ThreadId) => Op<ReadonlyArray<LoomPendingPeerMessage>>;
    /** Messages the sender recorded to the target at or after `since`, in any state (the cap's count). */
    readonly countSent: (
      senderThreadId: ThreadId,
      targetThreadId: ThreadId,
      since: IsoDateTime,
    ) => Op<number>;
  };
}

export class LoomStoreV2 extends Context.Service<LoomStoreV2, LoomStoreV2Shape>()(
  "t3/loom/projection/LoomStore/LoomStoreV2",
) {}

const ConsultSummaryRow = Schema.Struct({
  askerThreadId: ThreadId,
  ...LoomThreadConsultSummary.fields,
});
const PeerMessageSummaryRow = Schema.Struct({
  senderThreadId: ThreadId,
  ...LoomThreadPeerMessageSummary.fields,
});
const PendingPeerMessageRow = Schema.Struct({
  recordId: Schema.String,
  senderThreadId: ThreadId,
  targetThreadId: ThreadId,
  framedMessage: Schema.String,
  createdAt: IsoDateTime,
});

const historyRow = <const Type extends string, Payload extends Schema.Struct.Fields>(
  type: Type,
  payload: Payload,
) =>
  Schema.Struct({
    type: Schema.Literal(type),
    eventId: EventId,
    at: IsoDateTime,
    payload: Schema.fromJsonString(Schema.Struct(payload)),
  });

/** The event-log rows `history` folds. V1 rows carry extra payload fields and V1 reasons. */
const HistoryEventRow = Schema.Union([
  historyRow("thread.report-set", { reportPath: TrimmedNonEmptyString }),
  historyRow("thread.outcome-recorded", Struct.omit(WorkOutcomeRecord.fields, ["eventId", "at"])),
  historyRow("thread.attention-raised", { reason: TrimmedNonEmptyString }),
  historyRow("thread.attention-cleared", { reason: Schema.optional(TrimmedNonEmptyString) }),
  // V1's route-taken had no kind: every V1 route was a loop.
  historyRow("thread.route-taken", {
    to: ThreadId,
    round: NonNegativeInt,
    kind: Schema.optional(LoomRouteKind),
  }),
  historyRow("thread.gate-rework-accepted", { sourceThreadId: ThreadId, round: NonNegativeInt }),
  historyRow("thread.outcome-set", { outcome: Schema.NullOr(LoomOutcome) }),
  // V1's lane axis: a yield was the `yielded` lane, done/cancelled were lanes.
  historyRow("thread.plan-lane-set", { planLane: Schema.String }),
]);
const decodeHistoryRow = Schema.decodeUnknownOption(HistoryEventRow);
const HISTORY_EVENT_TYPES = HistoryEventRow.members.map((member) => member.fields.type.literal);

/**
 * The predicate `loom_turn_items_tool_calls_idx` (migration 1068) is partial on,
 * as literal SQL: SQLite uses a partial index only for the identical term.
 */
const TOOL_CALL_ITEM_PREDICATE =
  "type IN ('command_execution', 'file_change', 'file_search', 'web_search', 'dynamic_tool')";

const ThreadStatsRow = Schema.Struct({
  threadId: ThreadId,
  toolCalls: NonNegativeInt,
  contextUsage: Schema.NullOr(Schema.fromJsonString(LoomContextUsage)),
});

const SHELL_OMITTED = [
  "notifySendLog",
  "handoffDestinations",
  "lastRoute",
  "outcomeEventId",
  "unarchivedEventId",
  "unarchivedAt",
  "attentionEpisodes",
] as const;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const run =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((cause) => new LoomStoreError({ operation, cause })));

  const visibility = (options: LoomTreeQueryOptions = {}) =>
    sql.and([
      options.includeArchived ? "1 = 1" : "w.archived_at IS NULL",
      options.includeDeleted ? "1 = 1" : "w.deleted_at IS NULL",
    ]);

  const selectGoals = (where: Statement.Fragment) =>
    sql`SELECT goal_id AS "id", project_id AS "projectId", slug, title, description,
          created_at AS "createdAt", updated_at AS "updatedAt",
          archived_at AS "archivedAt", deleted_at AS "deletedAt"
        FROM loom_goals WHERE ${where} ORDER BY created_at ASC, goal_id ASC`.pipe(
      Effect.flatMap(decodeGoalRows),
    );

  const selectTasks = (goalId: GoalId, deleted: boolean) =>
    sql`SELECT task_id AS "id", goal_id AS "goalId", parent_task_id AS "parentTaskId",
          position, text, done, created_at AS "createdAt", updated_at AS "updatedAt"
        FROM loom_goal_tasks WHERE goal_id = ${goalId}
          AND deleted_at IS ${deleted ? sql`NOT NULL` : sql`NULL`}`.pipe(
      Effect.flatMap(decodeTaskRows),
    );

  const listTasks = (goalId: GoalId) => selectTasks(goalId, false).pipe(Effect.map(buildTaskTree));

  const withTasks = (row: GoalRow) =>
    listTasks(row.id).pipe(Effect.map((tasks): LoomGoal => ({ ...row, tasks })));

  const getGoal = (goalId: GoalId) =>
    selectGoals(sql`goal_id = ${goalId}`).pipe(
      Effect.flatMap((rows) => (rows[0] === undefined ? Effect.succeed(null) : withTasks(rows[0]))),
    );

  const touchGoal = (goalId: GoalId, at: string) =>
    sql`UPDATE loom_goals SET updated_at = ${at} WHERE goal_id = ${goalId}`;

  const setGoalState = (
    operation: string,
    goalId: GoalId,
    assignments: (at: string) => Statement.Fragment,
  ) =>
    Effect.gen(function* () {
      const at = yield* now;
      yield* sql`UPDATE loom_goals SET ${assignments(at)}, updated_at = ${at} WHERE goal_id = ${goalId}`;
      return yield* getGoal(goalId);
    }).pipe(sql.withTransaction, run(operation));

  const upsertTaskRow = (goalId: GoalId, task: LoomGoalTaskInput, at: string) =>
    sql`INSERT INTO loom_goal_tasks ${sql.insert({
      task_id: task.id,
      goal_id: goalId,
      parent_task_id: task.parentTaskId,
      position: task.position,
      text: task.text,
      done: task.done ? 1 : 0,
      created_at: at,
      updated_at: at,
      deleted_at: null,
    })}
    ON CONFLICT (task_id) DO UPDATE SET goal_id = excluded.goal_id,
      parent_task_id = excluded.parent_task_id, position = excluded.position,
      text = excluded.text, done = excluded.done, updated_at = excluded.updated_at,
      deleted_at = NULL`;

  const consultSummaries = (askerThreadIds: ReadonlyArray<ThreadId>) =>
    sql`SELECT "askerThreadId", "targetThreadId", "targetTitle", count, "lastConsultAt", "lastQuestionPreview"
        FROM (
          SELECT c.asker_thread_id AS "askerThreadId", c.target_thread_id AS "targetThreadId",
            c.target_title AS "targetTitle", c.question_preview AS "lastQuestionPreview",
            c.created_at AS "lastConsultAt",
            COUNT(*) OVER (PARTITION BY c.asker_thread_id, c.target_thread_id) AS count,
            ROW_NUMBER() OVER (
              PARTITION BY c.asker_thread_id, c.target_thread_id
              ORDER BY c.created_at DESC, c.event_id DESC
            ) AS rn
          FROM loom_thread_consults c
          WHERE c.asker_thread_id IN ${sql.in(askerThreadIds)}
        )
        WHERE rn = 1
        ORDER BY "askerThreadId" ASC, "lastConsultAt" DESC`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ConsultSummaryRow))),
    );

  const peerMessageSummaries = (senderThreadIds: ReadonlyArray<ThreadId>) =>
    sql`SELECT "senderThreadId", "targetThreadId", "targetTitle", count, "pendingCount",
          "lastMessageAt", "lastMessagePreview"
        FROM (
          SELECT pm.sender_thread_id AS "senderThreadId", pm.target_thread_id AS "targetThreadId",
            pm.target_title AS "targetTitle", pm.message_preview AS "lastMessagePreview",
            pm.created_at AS "lastMessageAt",
            COUNT(*) OVER (PARTITION BY pm.sender_thread_id, pm.target_thread_id) AS count,
            SUM(CASE WHEN pm.status = 'pending' THEN 1 ELSE 0 END) OVER (
              PARTITION BY pm.sender_thread_id, pm.target_thread_id
            ) AS "pendingCount",
            ROW_NUMBER() OVER (
              PARTITION BY pm.sender_thread_id, pm.target_thread_id
              ORDER BY pm.created_at DESC, pm.seq DESC
            ) AS rn
          FROM loom_thread_peer_messages pm
          WHERE pm.sender_thread_id IN ${sql.in(senderThreadIds)}
        )
        WHERE rn = 1
        ORDER BY "senderThreadId" ASC, "lastMessageAt" DESC`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(PeerMessageSummaryRow))),
    );

  // The card's tool-call count (index-only, migration 1068) and the active
  // provider thread's context window.
  const threadStats = (threadIds: ReadonlyArray<ThreadId>) =>
    sql`SELECT t.thread_id AS "threadId",
          (SELECT COUNT(*) FROM orchestration_v2_projection_turn_items i
            WHERE i.thread_id = t.thread_id AND ${sql.literal(TOOL_CALL_ITEM_PREDICATE)}
          ) AS "toolCalls",
          (SELECT json_extract(p.payload_json, '$.contextUsage')
            FROM orchestration_v2_projection_provider_threads p
            WHERE p.provider_thread_id = t.active_provider_thread_id
          ) AS "contextUsage"
        FROM orchestration_v2_projection_threads t
        WHERE t.thread_id IN ${sql.in(threadIds)}`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ThreadStatsRow))),
      Effect.map((rows) => new Map(rows.map((row) => [row.threadId, row]))),
    );

  const service: LoomStoreV2Shape = {
    getWorkstream: (threadId) => readWorkstream(sql, threadId).pipe(run("getWorkstream")),
    listWorkstreamTree: (rootThreadId, options) =>
      selectWorkstreams(
        sql,
        sql.and([sql`w.root_thread_id = ${rootThreadId}`, visibility(options)]),
      ).pipe(run("listWorkstreamTree")),
    listChildren: (parentThreadId, options) =>
      selectWorkstreams(
        sql,
        sql.and([sql`w.parent_thread_id = ${parentThreadId}`, visibility(options)]),
      ).pipe(run("listChildren")),
    listActiveWorkstreams: () =>
      selectWorkstreams(sql, visibility()).pipe(run("listActiveWorkstreams")),
    // A row is an episode root that its subtree has not followed when an
    // in-scope descendant still disagrees with it. "In scope" excludes nodes
    // created after the episode, and nodes a human moved deliberately after it
    // (unarchived after an archive, re-archived after an unarchive, reopened
    // after a cancel) — the planner's episode-keyed ids would skip those anyway,
    // so listing them would only re-read them every pass. Imported rows carry no
    // `outcome_event_id`, so a historical cancel is never an episode.
    listReDriveInput: () =>
      sql`
        WITH RECURSIVE descent(ancestor_id, thread_id) AS (
          SELECT parent_thread_id, thread_id FROM loom_thread_workstream
          WHERE parent_thread_id IS NOT NULL
          UNION
          SELECT d.ancestor_id, w.thread_id FROM descent d
          JOIN loom_thread_workstream w ON w.parent_thread_id = d.thread_id
        ),
        stale(thread_id) AS (
          SELECT r.thread_id FROM loom_thread_workstream r
          WHERE EXISTS (
            SELECT 1 FROM descent d JOIN loom_thread_workstream c ON c.thread_id = d.thread_id
            WHERE d.ancestor_id = r.thread_id AND (
              (r.outcome = 'cancelled' AND r.outcome_event_id IS NOT NULL
                AND c.created_at <= r.outcome_at AND c.deleted_at IS NULL
                AND c.outcome IS NULL AND (c.outcome_at IS NULL OR c.outcome_at <= r.outcome_at))
              OR (r.archived_at IS NOT NULL
                AND c.created_at <= r.archived_at AND c.deleted_at IS NULL
                AND c.archived_at IS NULL AND (c.unarchived_at IS NULL OR c.unarchived_at <= r.archived_at))
              OR (r.unarchived_event_id IS NOT NULL AND r.archived_at IS NULL
                AND c.created_at <= r.unarchived_at AND c.deleted_at IS NULL
                AND c.archived_at IS NOT NULL AND c.archived_at <= r.unarchived_at)
              OR (r.deleted_at IS NOT NULL AND c.deleted_at IS NULL)
            )
          )
        )
        SELECT ${sql.literal(workstreamSelectList)} FROM loom_thread_workstream w
        WHERE (w.archived_at IS NULL AND w.deleted_at IS NULL)
          OR w.thread_id IN (SELECT thread_id FROM stale)
          OR w.thread_id IN (
            SELECT d.thread_id FROM descent d JOIN stale s ON s.thread_id = d.ancestor_id
          )
        ORDER BY w.created_at ASC, w.thread_id ASC
      `.pipe(Effect.flatMap(decodeWorkstreamRows), run("listReDriveInput")),
    listThreadsWithHeldQueue: () =>
      sql<{ readonly threadId: ThreadId }>`
        SELECT DISTINCT w.thread_id AS "threadId"
        FROM loom_thread_workstream w
        JOIN orchestration_v2_projection_runs r ON r.thread_id = w.thread_id
        WHERE r.status = 'queued' AND json_extract(r.payload_json, '$.queueHeld') = 1
        ORDER BY w.thread_id
      `.pipe(
        Effect.map((rows) => rows.map((row) => row.threadId)),
        run("listThreadsWithHeldQueue"),
      ),
    goals: {
      get: (goalId) => getGoal(goalId).pipe(run("goals.get")),
      listByProject: (projectId, options) =>
        selectGoals(
          sql.and([
            sql`project_id = ${projectId}`,
            options?.includeDeleted ? "1 = 1" : "deleted_at IS NULL",
          ]),
        ).pipe(Effect.flatMap(Effect.forEach(withTasks)), run("goals.listByProject")),
      upsert: (goal) =>
        Effect.gen(function* () {
          const at = yield* now;
          yield* sql`INSERT INTO loom_goals ${sql.insert({
            goal_id: goal.id,
            project_id: goal.projectId,
            slug: goal.slug,
            title: goal.title,
            description: goal.description,
            created_at: at,
            updated_at: at,
            archived_at: null,
            deleted_at: null,
          })}
          ON CONFLICT (goal_id) DO UPDATE SET slug = excluded.slug, title = excluded.title,
            description = excluded.description, updated_at = excluded.updated_at`;
          return (yield* getGoal(goal.id))!;
        }).pipe(sql.withTransaction, run("goals.upsert")),
      archive: (goalId) => setGoalState("goals.archive", goalId, (at) => sql`archived_at = ${at}`),
      unarchive: (goalId) => setGoalState("goals.unarchive", goalId, () => sql`archived_at = NULL`),
      softDelete: (goalId) =>
        setGoalState("goals.softDelete", goalId, (at) => sql`deleted_at = ${at}`),
      softDeleteByProject: (projectId) =>
        Effect.gen(function* () {
          const at = yield* now;
          const live = yield* selectGoals(sql`project_id = ${projectId} AND deleted_at IS NULL`);
          yield* sql`UPDATE loom_goals SET deleted_at = ${at}, updated_at = ${at}
            WHERE project_id = ${projectId} AND deleted_at IS NULL`;
          return yield* Effect.forEach(live, (row) =>
            withTasks({ ...row, deletedAt: at, updatedAt: at }),
          );
        }).pipe(sql.withTransaction, run("goals.softDeleteByProject")),
    },
    tasks: {
      listByGoal: (goalId) => listTasks(goalId).pipe(run("tasks.listByGoal")),
      listDeleted: (goalId) => selectTasks(goalId, true).pipe(run("tasks.listDeleted")),
      replaceTree: (goalId, entries) =>
        Effect.gen(function* () {
          const at = yield* now;
          yield* Effect.forEach(entries, (entry) => upsertTaskRow(goalId, entry, at), {
            discard: true,
          });
          yield* sql`UPDATE loom_goal_tasks SET deleted_at = ${at}, updated_at = ${at}
            WHERE ${sql.and([
              sql`goal_id = ${goalId} AND deleted_at IS NULL`,
              ...(entries.length === 0
                ? []
                : [sql`task_id NOT IN ${sql.in(entries.map((entry) => entry.id))}`]),
            ])}`;
          yield* touchGoal(goalId, at);
          return yield* listTasks(goalId);
        }).pipe(sql.withTransaction, run("tasks.replaceTree")),
      upsert: (task) =>
        Effect.gen(function* () {
          const at = yield* now;
          yield* upsertTaskRow(task.goalId, task, at);
          yield* touchGoal(task.goalId, at);
          return yield* listTasks(task.goalId);
        }).pipe(sql.withTransaction, run("tasks.upsert")),
      markDeleted: (goalId, taskId) =>
        Effect.gen(function* () {
          const at = yield* now;
          yield* sql`
            WITH RECURSIVE subtree(task_id) AS (
              SELECT ${taskId}
              UNION
              SELECT t.task_id FROM loom_goal_tasks t JOIN subtree s ON t.parent_task_id = s.task_id
            )
            UPDATE loom_goal_tasks SET deleted_at = ${at}, updated_at = ${at}
            WHERE goal_id = ${goalId} AND deleted_at IS NULL
              AND task_id IN (SELECT task_id FROM subtree)`;
          yield* touchGoal(goalId, at);
          return yield* listTasks(goalId);
        }).pipe(sql.withTransaction, run("tasks.markDeleted")),
    },
    shellFields: (threadIds) =>
      Effect.gen(function* () {
        if (threadIds.length === 0) return new Map<ThreadId, LoomThreadShellFields>();
        const rows = yield* selectWorkstreams(sql, sql`w.thread_id IN ${sql.in(threadIds)}`);
        if (rows.length === 0) return new Map<ThreadId, LoomThreadShellFields>();
        const rowIds = rows.map((row) => row.threadId);
        const consults = Map.groupBy(yield* consultSummaries(rowIds), (row) => row.askerThreadId);
        const peerMessages = Map.groupBy(
          yield* peerMessageSummaries(rowIds),
          (row) => row.senderThreadId,
        );
        const stats = yield* threadStats(rowIds);
        return new Map(
          rows.map(
            (row) =>
              [
                row.threadId,
                {
                  ...Struct.omit(row, SHELL_OMITTED),
                  consults: (consults.get(row.threadId) ?? []).map((summary) =>
                    Struct.omit(summary, ["askerThreadId"]),
                  ),
                  peerMessages: (peerMessages.get(row.threadId) ?? []).map((summary) =>
                    Struct.omit(summary, ["senderThreadId"]),
                  ),
                  toolCalls: stats.get(row.threadId)?.toolCalls ?? 0,
                  contextUsage: stats.get(row.threadId)?.contextUsage ?? null,
                },
              ] as const,
          ),
        );
      }).pipe(run("shellFields")),
    history: (threadId) =>
      sql`SELECT event_id AS "eventId", event_type AS "type", occurred_at AS "at",
            payload_json AS "payload"
          FROM orchestration_events
          WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
            AND event_type IN ${sql.in(HISTORY_EVENT_TYPES)}
          ORDER BY sequence`.pipe(
        Effect.map((rows) => {
          // A submit's `report-set` precedes its `outcome-recorded`: carry it onto that outcome.
          let reportPath: string | null = null;
          let lane: string | null = null;
          // An undecodable (foreign V1) row is skipped rather than failing the timeline.
          return rows.flatMap((raw): ReadonlyArray<LoomThreadHistoryEntry> => {
            const row = Option.getOrNull(decodeHistoryRow(raw));
            if (row === null) return [];
            const event = { eventId: row.eventId, at: row.at };
            switch (row.type) {
              case "thread.report-set":
                reportPath = row.payload.reportPath;
                return [];
              case "thread.outcome-recorded": {
                const outcome = { type: "outcome" as const, ...row.payload, ...event, reportPath };
                reportPath = null;
                return [outcome];
              }
              case "thread.attention-raised":
                return [{ type: "attention-raised", ...event, reason: row.payload.reason }];
              case "thread.attention-cleared":
                return [
                  { type: "attention-cleared", ...event, reason: row.payload.reason ?? null },
                ];
              case "thread.route-taken":
                return [
                  {
                    type: "route-taken",
                    ...event,
                    ...row.payload,
                    kind: row.payload.kind ?? "loop",
                  },
                ];
              case "thread.gate-rework-accepted":
                return [{ type: "rework-accepted", ...event, ...row.payload }];
              case "thread.outcome-set":
                return [{ type: "outcome-set", ...event, outcome: row.payload.outcome }];
              case "thread.plan-lane-set": {
                const previous = lane;
                lane = row.payload.planLane;
                if (lane === "yielded")
                  return [{ type: "attention-raised", ...event, reason: "awaiting_orchestrator" }];
                if (lane === "done" || lane === "cancelled")
                  return [{ type: "outcome-set", ...event, outcome: lane }];
                if (previous === "yielded")
                  return [{ type: "attention-cleared", ...event, reason: "awaiting_orchestrator" }];
                if (previous === "done" || previous === "cancelled")
                  return [{ type: "outcome-set", ...event, outcome: null }];
                return [];
              }
            }
          });
        }),
        run("history"),
      ),
    consults: {
      listByAsker: (askerThreadId) =>
        consultSummaries([askerThreadId]).pipe(
          Effect.map((rows) => rows.map((summary) => Struct.omit(summary, ["askerThreadId"]))),
          run("consults.listByAsker"),
        ),
    },
    peerMessages: {
      listPending: (targetThreadId) =>
        sql`SELECT record_id AS "recordId", sender_thread_id AS "senderThreadId",
              target_thread_id AS "targetThreadId", framed_message AS "framedMessage",
              created_at AS "createdAt"
            FROM loom_thread_peer_messages
            WHERE ${sql.and([
              "status = 'pending'",
              ...(targetThreadId === undefined ? [] : [sql`target_thread_id = ${targetThreadId}`]),
            ])}
            ORDER BY created_at ASC, seq ASC`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(PendingPeerMessageRow))),
          run("peerMessages.listPending"),
        ),
      countSent: (senderThreadId, targetThreadId, since) =>
        sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM loom_thread_peer_messages
            WHERE sender_thread_id = ${senderThreadId} AND target_thread_id = ${targetThreadId}
              AND created_at >= ${since}`.pipe(
          Effect.map(([row]) => row?.n ?? 0),
          run("peerMessages.countSent"),
        ),
    },
  };
  return service;
});

export const layer: Layer.Layer<LoomStoreV2, never, SqlClient.SqlClient> = Layer.effect(
  LoomStoreV2,
  make,
);
