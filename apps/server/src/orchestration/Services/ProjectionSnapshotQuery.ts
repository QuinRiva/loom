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
 * mid-turn-stall heartbeat (newest tool/task/token row's `createdAt`);
 * `maxSequence` is the idle-wake episode key (the per-child wake dedups on
 * `(child.id, maxSequence-at-idle-onset)` because `activeTurnId` is null when
 * idle, so a turn-id key is unusable). Both null when the thread has no rows.
 */
export interface ProjectionActivityFreshness {
  readonly maxCreatedAt: string | null;
  readonly maxSequence: number | null;
}

/**
 * A normalized tool-activity signal for the D-liveness loop detector. The raw
 * row stores a generic `kind/summary/payload` shape (not a `(tool, args)`
 * tuple), so the comparable signature is derived from `kind` + `summary` (the
 * tool title, which usually carries the target) + `itemType` + `detail`.
 */
export interface ProjectionToolActivitySignal {
  readonly kind: string;
  readonly summary: string;
  readonly itemType: string | null;
  readonly detail: string | null;
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
}

/**
 * ProjectionSnapshotQuery - Service tag for projection snapshot queries.
 */
export class ProjectionSnapshotQuery extends Context.Service<
  ProjectionSnapshotQuery,
  ProjectionSnapshotQueryShape
>()("t3/orchestration/Services/ProjectionSnapshotQuery") {}
