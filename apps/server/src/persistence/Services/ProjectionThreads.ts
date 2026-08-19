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
  HandoffDestination,
  CommandId,
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
  TitleProvenance,
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
  // Handoff chain: the predecessor thread on the same goal when this thread was
  // created by `goal_continue` (null otherwise).
  continuesThreadId: Schema.NullOr(ThreadId),
  // Post-completion engagement (plan §8 item 3): the child's tip commit recorded
  // at fan-in / cancel (null until disposed). Historical marker only. Optional
  // so it need not appear in row literals; the SELECT always aliases the column.
  finalCommitSha: Schema.optional(Schema.NullOr(Schema.String)),
  reportPath: Schema.NullOr(Schema.String),
  // Scaffold-first graph authoring: the symbolic graph key (unique-forever per
  // parent) and the on-disk kickoff-brief pointer. Both null for legacy
  // spawns / roots and until a brief is attached.
  graphKey: Schema.NullOr(Schema.String),
  kickoffBriefPath: Schema.NullOr(Schema.String),
  // Scaffold-first graph authoring (plan §3): timestamp of this thread's most
  // recent plan-lane transition (its `thread.plan-lane-set` event, or creation
  // lane when it never transitioned). The stable, transition-derived clock the
  // brief-needed liveness episode reads — immune to the `updatedAt` re-arm loop
  // because activity appends do not emit a lane-set. Null on rows predating the
  // column.
  planLaneSince: Schema.NullOr(IsoDateTime),
  // Scaffold-first graph authoring (plan §3): timestamp of this thread's most
  // recent dependency-set transition (its `thread.dependencies-set` event).
  // Companion to `planLaneSince` for the re-enter-via-set_dependencies episode
  // transition; stamped only by that event, never by an activity append. Null
  // on rows predating the column / until the first dependency-set.
  dependenciesSince: Schema.NullOr(IsoDateTime),
  // Scaffold-first graph authoring (plan §3): timestamp of this thread's most
  // recent fan-in-settlement transition (its `thread.fanin-set` event). Third
  // companion to `planLaneSince`/`dependenciesSince`; stamped only by that event,
  // never by an activity append. Null on rows predating the column / until the
  // first fan-in-set.
  faninSince: Schema.NullOr(IsoDateTime),
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
  titleProvenance: TitleProvenance, // loom: §4 title provenance
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  latestTurnId: Schema.NullOr(TurnId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  settledOverride: Schema.NullOr(Schema.Literals(["settled", "active"])),
  settledAt: Schema.NullOr(IsoDateTime),
  snoozedUntil: Schema.NullOr(IsoDateTime),
  snoozedAt: Schema.NullOr(IsoDateTime),
  pinnedAt: Schema.NullOr(IsoDateTime),
  pinOrderKey: Schema.optional(Schema.NullOr(Schema.String)),
  titleRegenerationRequestId: Schema.optional(Schema.NullOr(CommandId)),
  titleRegenerationStartedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
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
  // `/handoff` fork-drafter (plan D5): the destinations this thread has placed
  // as a handoff-drafter (empty for every non-drafter thread).
  handoffDestinations: Schema.Array(HandoffDestination),
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
