/**
 * ProjectionThreadRepository - Projection repository interface for threads.
 *
 * Owns persistence operations for projected thread records in the
 * orchestration read model.
 *
 * @module ProjectionThreadRepository
 */
import {
  GoalId,
  IsoDateTime,
  ModelSelection,
  NonNegativeInt,
  NonNegativeNumber,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadAttention,
  ThreadFanInState,
  ThreadId,
  ThreadIsolation,
  ThreadPlanLane,
  TurnId,
  WorkOutcomeRecord,
  WorkstreamRoute,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThread = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  goalId: Schema.NullOr(GoalId),
  parentThreadId: Schema.NullOr(ThreadId),
  role: Schema.NullOr(Schema.String),
  purpose: Schema.NullOr(Schema.String),
  brief: Schema.NullOr(Schema.String),
  planLane: ThreadPlanLane,
  attention: ThreadAttention,
  blockedBy: Schema.Array(ThreadId),
  spawnGeneration: Schema.NullOr(Schema.String),
  // Thread fork (MVP): the source thread this thread was forked from (null when
  // not a fork). Read by the driver at first launch to fork the pi session.
  forkFromThreadId: Schema.NullOr(ThreadId),
  reportPath: Schema.NullOr(Schema.String),
  // Review gates (design §8): route edges + projected loop counters.
  // `pendingRework` is stored as 0/1 (SQLite has no boolean).
  routes: Schema.Array(WorkstreamRoute),
  gateRounds: NonNegativeInt,
  pendingRework: NonNegativeInt,
  lastOutcome: Schema.NullOr(WorkOutcomeRecord),
  // Worktree isolation (design §1/§3): the isolation policy + fan-in
  // settlement of an isolated child.
  isolation: ThreadIsolation,
  fanInState: ThreadFanInState,
  title: Schema.String,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  latestTurnId: Schema.NullOr(TurnId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  latestUserMessageAt: Schema.NullOr(IsoDateTime),
  pendingApprovalCount: NonNegativeInt,
  pendingUserInputCount: NonNegativeInt,
  hasActionableProposedPlan: NonNegativeInt,
  cumulativeCostUsd: NonNegativeNumber,
  // Latest context-window snapshot (newest `context-window.updated` activity).
  // Null when unknown (non-pi threads / before first activity) so the UI can
  // suppress the chip rather than show a misleading 0.
  toolUses: Schema.NullOr(NonNegativeInt),
  usedTokens: Schema.NullOr(NonNegativeInt),
  maxTokens: Schema.NullOr(NonNegativeInt),
  // Cumulative lines-of-diff (SUM of checkpoint turn file additions/deletions).
  // Null when unknown (no checkpoint yet) so the UI suppresses the chip.
  diffAdditions: Schema.NullOr(NonNegativeInt),
  diffDeletions: Schema.NullOr(NonNegativeInt),
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionThread = typeof ProjectionThread.Type;

export const GetProjectionThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type GetProjectionThreadInput = typeof GetProjectionThreadInput.Type;

export const DeleteProjectionThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadInput = typeof DeleteProjectionThreadInput.Type;

export const ListProjectionThreadsByProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type ListProjectionThreadsByProjectInput = typeof ListProjectionThreadsByProjectInput.Type;

/**
 * ProjectionThreadRepositoryShape - Service API for projected thread records.
 */
export interface ProjectionThreadRepositoryShape {
  /**
   * Insert or replace a projected thread row.
   *
   * Upserts by `threadId`.
   */
  readonly upsert: (thread: ProjectionThread) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read a projected thread row by id.
   */
  readonly getById: (
    input: GetProjectionThreadInput,
  ) => Effect.Effect<Option.Option<ProjectionThread>, ProjectionRepositoryError>;

  /**
   * List projected threads for a project.
   *
   * Returned in deterministic creation order.
   */
  readonly listByProjectId: (
    input: ListProjectionThreadsByProjectInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThread>, ProjectionRepositoryError>;

  /**
   * Soft-delete a projected thread row by id.
   */
  readonly deleteById: (
    input: DeleteProjectionThreadInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionThreadRepository - Service tag for thread projection persistence.
 */
export class ProjectionThreadRepository extends Context.Service<
  ProjectionThreadRepository,
  ProjectionThreadRepositoryShape
>()("t3/persistence/Services/ProjectionThreads/ProjectionThreadRepository") {}
