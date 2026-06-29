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
  OrchestrationCheckpointSummary,
  OrchestrationGoalShell,
  OrchestrationProject,
  OrchestrationProjectShell,
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
  OrchestrationThread,
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
 * newest tool/task/token *row's* `createdAt`; `maxSequence` is the idle-wake
 * episode key (the per-child wake dedups on `(child.id, maxSequence-at-idle-
 * onset)` because `activeTurnId` is null when idle, so a turn-id key is
 * unusable). `heartbeatAt` is the persisted runtime heartbeat — the canonical
 * "last runtime activity at", advanced on ANY runtime event including assistant/
 * reasoning token deltas that never create a row, so the stall rail no longer
 * mistakes long silent reasoning for a stall. All null when the thread has no
 * rows / no heartbeat yet. (The parallel `lastActivityAt` workstream-node
 * effort should surface `heartbeatAt` rather than introduce a second signal.)
 */
export interface ProjectionActivityFreshness {
  readonly maxCreatedAt: string | null;
  readonly maxSequence: number | null;
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

export interface ProjectionSnapshotSequence {
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
   * Read the activity-timeline freshness for a thread (D-liveness): the newest
   * activity-row `createdAt` (mid-turn-stall heartbeat) and the max activity
   * `sequence` (idle-wake episode key). Single aggregate row; both fields are
   * null when the thread has no activity rows.
   */
  readonly getActivityFreshnessByThreadId: (
    threadId: ThreadId,
  ) => Effect.Effect<ProjectionActivityFreshness, ProjectionRepositoryError>;

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
}

/**
 * ProjectionSnapshotQuery - Service tag for projection snapshot queries.
 */
export class ProjectionSnapshotQuery extends Context.Service<
  ProjectionSnapshotQuery,
  ProjectionSnapshotQueryShape
>()("t3/orchestration/Services/ProjectionSnapshotQuery") {}
