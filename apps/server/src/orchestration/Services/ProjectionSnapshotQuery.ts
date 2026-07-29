/**
 * ProjectionSnapshotQuery - Read-model snapshot query service interface.
 *
 * Exposes the current orchestration projection snapshot for read-only API
 * access.
 *
 * @module ProjectionSnapshotQuery
 */
import type {
  CheckpointRef,
  TurnId,
  OrchestrationCheckpointSummary,
  OrchestrationGetThreadActivitiesInput,
  OrchestrationGetThreadActivitiesResult,
  OrchestrationGetThreadLifecycleInput,
  OrchestrationGetThreadLifecycleResult,
  OrchestrationGoalShell,
  OrchestrationProject,
  OrchestrationProjectShell,
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadShell,
  GoalId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Option from "effect/Option";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface ProjectionSnapshotCounts {
  readonly projectCount: number;
  readonly threadCount: number;
}

/**
 * Freshness of a thread's activity timeline (D-liveness). `maxCreatedAt` is the
 * newest tool/task/token *row's* `createdAt` (control-plane `workstream.%` rows
 * — liveness nudges/markers — are excluded so the control plane can never reset
 * the clocks it measures). `maxCreatedAt` doubles as the idle-wake episode key
 * (the per-child wake dedups on `(child.id, maxCreatedAt-at-idle-onset)` because
 * `activeTurnId` is null when idle, so a turn-id key is unusable; it is stable
 * while the child stays idle → no re-nag, and advances the moment the child
 * resumes and emits a fresh activity row → the episode re-arms).
 * `heartbeatAt` is the persisted runtime heartbeat — the canonical
 * "last runtime activity at", advanced on ANY runtime event including assistant/
 * reasoning token deltas that never create a row, so the stall rail no longer
 * mistakes long silent reasoning for a stall. All null when the thread has no
 * rows / no heartbeat yet. (The parallel `lastActivityAt` workstream-node
 * effort should surface `heartbeatAt` rather than introduce a second signal.)
 */
export interface ProjectionActivityFreshness {
  readonly maxCreatedAt: string | null;
  readonly heartbeatAt: string | null;
}

/**
 * A normalized tool-activity signal for the D-liveness loop detector. The raw
 * row stores a generic `kind/summary/payload` shape (not a `(tool, args)`
 * tuple) whose title (`bash`, `read`, …) is identical across every call of a
 * tool — so the discriminating content (command line, path, search query) is
 * recovered by running the shared `deriveToolActivityPresentation` over the
 * row's payload. The resulting `summary`+`detail` are what the loop signature
 * compares; without this the detector false-positives on any normal coding
 * thread because three distinct shell commands collapse to one signature.
 */
export interface ProjectionToolActivitySignal {
  readonly summary: string;
  readonly detail: string | null;
}

/**
 * Raw work-product progress source for State-D ("possibly spinning") detection.
 * Both fields are opaque change-detection strings hashed into a per-thread
 * fingerprint — never parsed:
 * - `recentInputsSource`: a delimiter-joined concat of the latest tool calls'
 *   ACTUAL content (`data.rawInput`, falling back to `data.details.diff`, then
 *   the summary). This is the primary within-turn progress signal: distinct
 *   edits carry distinct `rawInput`, so it changes as real work happens and
 *   stays flat only when the same call is re-emitted (genuine spin). It is the
 *   actual content, NOT the display projection — a display string re-collapses
 *   distinct calls and is the exact bug State D must not reintroduce.
 * - `checkpointSource`: the latest checkpoint's turn-count + files JSON. A
 *   cross-turn corroborator (checkpoints only materialise at turn end, so this
 *   is flat within a single sub-thread turn); OR-combined so EITHER advancing
 *   re-arms. Both null when the thread has no tool rows / no checkpoints yet.
 */
export interface ProjectionThreadProgressSignal {
  readonly recentInputsSource: string | null;
  readonly checkpointSource: string | null;
}

/**
 * The tool call currently in flight within a thread's active turn (class-2
 * liveness): derived from the latest lifecycle row, provided its kind is
 * `tool.started` or `tool.updated` rather than `tool.completed`. `null` when
 * every started call has completed. Used to (a) exempt a running tool call from
 * the stall ladder and the State-D spin fingerprint, and (b) build the
 * informational slow-tool notice to the parent.
 */
export interface ProjectionInFlightTool {
  readonly toolName: string;
  /** The in-flight row's `createdAt` timestamp. */
  readonly startedAt: string;
  /** The in-flight row's id — the slow-tool notice episode key. */
  readonly activityId: string;
  /**
   * The normalised tool item type (e.g. `command_execution`, `file_change`).
   * The slow-tool rail honours a declared expected-duration ONLY for
   * `command_execution` calls, so incidental `# eta`-shaped text or a `timeout`
   * arg on a non-command tool never defers notices. `null` when unknown.
   */
  readonly itemType: string | null;
  /**
   * The call's presentation detail (for command execution, the command line) as
   * persisted on the started/updated row. Carries any inline `# eta: <n>m`
   * marker an agent prefixed to a known-long command, which the slow-tool rail
   * parses to defer its notices. `null` when the row has no detail.
   */
  readonly commandText: string | null;
  /**
   * The declared `timeout` (seconds) extracted from the call's input at
   * ingestion (a single bounded number, not the raw args), when present — the
   * fallback expected-duration signal for the slow-tool rail when no `# eta:`
   * marker is given (a call cannot outlive its timeout). `null` when undeclared.
   */
  readonly timeoutSeconds: number | null;
}

export interface ProjectionSnapshotSequence {
  readonly snapshotSequence: number;
}

/**
 * One pending notify_thread delivery, for the dispatcher's deferred-delivery
 * rail. `recordId` is the stable correlation key the delivery/expire/mark
 * command ids derive from; `framedMessage` is the exact bytes to land in the
 * target's transcript. Rows come oldest-first so the rail can deliver strictly
 * FIFO, at most one per target per pass.
 */
export interface ProjectionPendingPeerMessage {
  readonly recordId: string;
  readonly senderThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
  readonly framedMessage: string;
  readonly createdAt: string;
}

export interface ProjectionThreadDetailSnapshot {
  readonly thread: OrchestrationThread;
  readonly snapshotSequence: number;
}

export interface ProjectionThreadCheckpointContext {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>;
}

export interface ProjectionFullThreadDiffContext {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly latestCheckpointTurnCount: number;
  readonly toCheckpointRef: CheckpointRef | null;
}

/**
 * ProjectionSnapshotQueryShape - Service API for read-model snapshots.
 */
export interface ProjectionSnapshotQueryShape {
  /**
   * Read the lightweight command snapshot used to bootstrap the in-memory
   * orchestration engine without hydrating message/activity/checkpoint bodies.
   */
  readonly getCommandReadModel: () => Effect.Effect<
    OrchestrationReadModel,
    ProjectionRepositoryError
  >;

  /**
   * Read the latest orchestration projection snapshot.
   *
   * Rehydrates from projection tables and derives snapshot sequence from
   * projector cursor state.
   */
  readonly getSnapshot: () => Effect.Effect<OrchestrationReadModel, ProjectionRepositoryError>;

  /**
   * Read the latest orchestration shell snapshot.
   *
   * Returns only projects and thread shell summaries so clients can bootstrap
   * lightweight navigation state without hydrating every thread body.
   */
  readonly getShellSnapshot: () => Effect.Effect<
    OrchestrationShellSnapshot,
    ProjectionRepositoryError
  >;

  /**
   * Read archived thread shell summaries for the archive page.
   *
   * This query is separate from the main shell snapshot so archived threads
   * are never bootstrapped into normal navigation state.
   */
  readonly getArchivedShellSnapshot: () => Effect.Effect<
    OrchestrationShellSnapshot,
    ProjectionRepositoryError
  >;

  /**
   * Read the latest projection snapshot sequence without hydrating read-model
   * entities.
   */
  readonly getSnapshotSequence: () => Effect.Effect<
    ProjectionSnapshotSequence,
    ProjectionRepositoryError
  >;

  /**
   * Read aggregate projection counts without hydrating the full read model.
   */
  readonly getCounts: () => Effect.Effect<ProjectionSnapshotCounts, ProjectionRepositoryError>;

  /**
   * Read the active project for an exact workspace root match.
   */
  readonly getActiveProjectByWorkspaceRoot: (
    workspaceRoot: string,
  ) => Effect.Effect<Option.Option<OrchestrationProject>, ProjectionRepositoryError>;

  /**
   * Read a single active project shell row by id.
   */
  readonly getProjectShellById: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, ProjectionRepositoryError>;

  /**
   * Read a single active (non-archived, non-deleted) goal shell row by id.
   */
  readonly getGoalShellById: (
    goalId: GoalId,
  ) => Effect.Effect<Option.Option<OrchestrationGoalShell>, ProjectionRepositoryError>;

  /**
   * Read the earliest active thread for a project.
   */
  readonly getFirstActiveThreadIdByProjectId: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<ThreadId>, ProjectionRepositoryError>;

  /**
   * Read the checkpoint context needed to resolve a single thread diff.
   */
  readonly getThreadCheckpointContext: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProjectionThreadCheckpointContext>, ProjectionRepositoryError>;

  /**
   * Read only the narrow context needed to compute a full-thread diff from
   * checkpoint 0 to a specific turn count.
   */
  readonly getFullThreadDiffContext: (
    threadId: ThreadId,
    toTurnCount: number,
  ) => Effect.Effect<Option.Option<ProjectionFullThreadDiffContext>, ProjectionRepositoryError>;

  /**
   * Read a single active thread shell row by id.
   */
  readonly getThreadShellById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadShell>, ProjectionRepositoryError>;

  /**
   * Read a single active thread detail snapshot by id.
   */
  readonly getThreadDetailById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThread>, ProjectionRepositoryError>;

  /**
   * Read a single active thread detail snapshot together with the projection
   * `snapshotSequence` derived from the SAME read transaction. Callers use this
   * one consistent sequence both as the snapshot cursor and as the live-stream
   * dedup boundary (`event.sequence > snapshotSequence`), so no event committed
   * between the detail read and the sequence read can be dropped — the failure
   * mode when the two are read as independent snapshots.
   */
  readonly getThreadDetailSnapshotById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProjectionThreadDetailSnapshot>, ProjectionRepositoryError>;

  /**
   * Cursor-paginated load of a thread's older activities (lazy-load / infinite
   * scroll). Returns the page of activities immediately older than the provided
   * sequence or unsequenced activity cursor, ascending, plus whether older ones
   * remain.
   */
  readonly getThreadActivitiesPage: (
    input: OrchestrationGetThreadActivitiesInput,
  ) => Effect.Effect<OrchestrationGetThreadActivitiesResult, ProjectionRepositoryError>;

  /**
   * Scoped, on-demand read of one thread's ordered lifecycle events (plan-lane
   * transitions, attention raise/clear, submitted outcomes, loop route-takens,
   * fan-in settlements) straight from the event store, decoded through the
   * shared `OrchestrationEvent` contract. This is the per-thread journey the
   * latest-state read model throws away; it is pulled only when a graph node is
   * inspected, so it stays off the always-pushed snapshot. Works on all
   * pre-existing runs with no backfill.
   */
  readonly getThreadLifecycle: (
    input: OrchestrationGetThreadLifecycleInput,
  ) => Effect.Effect<OrchestrationGetThreadLifecycleResult, ProjectionRepositoryError>;

  /**
   * Read the set of thread ids that currently have a pending turn-start (a
   * turn requested but not yet started by the runtime). This is the
   * pending-turn-start projection used by the D-notify idle gate: a parent is
   * not idle while it has a pending turn-start, even though `activeTurnId` is
   * still null in that window.
   */
  readonly getPendingTurnStartThreadIds: () => Effect.Effect<
    ReadonlySet<ThreadId>,
    ProjectionRepositoryError
  >;

  /**
   * notify_thread deferred delivery: every still-pending peer message, oldest
   * first. The dispatcher rail groups by target and attempts only the oldest
   * per target per pass (one notification per target turn, strict FIFO).
   */
  readonly listPendingPeerMessages: () => Effect.Effect<
    ReadonlyArray<ProjectionPendingPeerMessage>,
    ProjectionRepositoryError
  >;

  /**
   * Read the activity-timeline freshness for a thread (D-liveness): the newest
   * activity-row `createdAt` (mid-turn-stall heartbeat) and the max activity
   * `sequence` (idle-wake episode key). Single aggregate row; both fields are
   * null when the thread has no activity rows.
   */
  readonly getActivityFreshnessByThreadId: (
    threadId: ThreadId,
  ) => Effect.Effect<ProjectionActivityFreshness, ProjectionRepositoryError>;

  /**
   * Read the set of agent-question requestIds still OPEN on a thread, folded
   * terminal-wins from its activity log (`@t3tools/shared/openRequests`). The
   * shell carries only the count; the dispatcher's `awaiting_input` parent wake
   * needs the identities to key its episode, so one question produces exactly
   * one wake and a second question re-arms rather than being suppressed.
   */
  readonly getOpenUserInputRequestIdsByThreadId: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlySet<string>, ProjectionRepositoryError>;

  /**
   * Read the tool call currently in flight within a thread's turn, or null
   * when no started call is pending completion.
   */
  readonly getInFlightToolByThreadId: (
    threadId: ThreadId,
    turnId: TurnId,
  ) => Effect.Effect<ProjectionInFlightTool | null, ProjectionRepositoryError>;

  /**
   * Read the most-recent tool-activity rows for a thread (newest first, capped
   * at `limit`), normalized for the D-liveness loop detector.
   */
  readonly getRecentToolActivityByThreadId: (
    threadId: ThreadId,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<ProjectionToolActivitySignal>, ProjectionRepositoryError>;

  /**
   * Read the cheap work-product progress source for a thread (State-D liveness):
   * the latest `limit` tool calls' raw content + the latest checkpoint, as
   * opaque change-detection strings. Read-only persisted rows (no git diff
   * recompute), called only for genuinely-busy sub-threads.
   */
  readonly getThreadProgressSignal: (
    threadId: ThreadId,
    limit: number,
  ) => Effect.Effect<ProjectionThreadProgressSignal, ProjectionRepositoryError>;

  /**
   * Read a single active thread detail together with the projection snapshot
   * sequence in one consistent transaction, so the returned `snapshotSequence`
   * exactly matches the state reflected in `thread` (no interleaving projector
   * update between the two reads).
   */
  readonly getThreadDetailSnapshot: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadDetailSnapshot>, ProjectionRepositoryError>;
}

/**
 * ProjectionSnapshotQuery - Service tag for projection snapshot queries.
 */
export class ProjectionSnapshotQuery extends Context.Service<
  ProjectionSnapshotQuery,
  ProjectionSnapshotQueryShape
>()("t3/orchestration/Services/ProjectionSnapshotQuery") {}
