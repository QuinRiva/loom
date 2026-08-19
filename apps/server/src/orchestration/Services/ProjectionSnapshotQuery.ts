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
  OrchestrationGoal,
  OrchestrationGoalShell,
  OrchestrationProject,
  OrchestrationProjectShell,
  OrchestrationLeanShellSnapshot,
  OrchestrationReadModel,
  OrchestrationSearchThreadsInput,
  OrchestrationSearchThreadsResult,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadDetailWindow,
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
 * The identity of one active project — all that a caller resolving a project by
 * id or title needs. Deliberately narrower than `OrchestrationProject`: it
 * carries no `repositoryIdentity`, so listing projects costs one indexed read
 * and never shells git per workspace root.
 */
export interface ProjectionActiveProjectRef {
  readonly id: ProjectId;
  readonly title: string;
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
 * The outstanding-obligation summary for ONE thread — the liveness input the
 * provider-session reaper needs to decide whether an idle session may be
 * stopped. "Idle" on its own is not enough: an orchestrator that has fanned out
 * work has no active turn of its own and its runtime row's `lastSeenAt` is
 * bumped only by its OWN activity (each child has its own row), so a parent
 * waiting two hours on a child looks exactly like an abandoned session. Reaping
 * it kills the session the parent must be resumed into when its children report.
 *
 * Deliberately a narrow aggregate query rather than a shell/snapshot hydration:
 * the sweep runs every 5 minutes over every binding, so per-thread cost matters.
 *
 * - `liveChildCount`: direct children in a non-terminal plan lane (anything but
 *   `done`/`cancelled`). Those are the obligations the parent is waiting on.
 * - `hasUnmetDependencies`: whether this thread is still gated, decided by the
 *   SHARED `areDependenciesSatisfied` predicate rather than a lane proxy — so a
 *   `done` isolated dependency whose fan-in has not landed, and a `done`
 *   attached reviewer whose gated coder has not fanned in, both count. Running
 *   the real predicate (over the thread's sibling set, which is where every
 *   gating edge lives) is what keeps this from drifting from the gate that
 *   actually decides whether the thread may run.
 * - `openUserInputCount`: open agent questions (`pending_user_input_count`). The
 *   exit handler force-cancels every open question on the thread, so reaping a
 *   thread parked on a question destroys a human's pending answer.
 * - `pendingRework`: an open review-gate rework round the dispatcher still owes
 *   this thread a resume for.
 *
 * `activeTurnId` rides along so the sweep's liveness check is ONE read per stale
 * binding instead of a shell hydration plus an obligations read.
 *
 * A thread's OWN pending fan-in is deliberately NOT an obligation: fan-in is a
 * pure git operation in `WorkstreamFanInReactor` (it never touches
 * `ProviderService`), so a `done` isolated thread awaiting its merge does not
 * need its provider process alive. Treating it as one would leak the process of
 * every ordinary isolated coder forever — strictly worse than the over-eager
 * reap this guard exists to fix.
 */
export interface ProjectionThreadObligations {
  /**
   * The thread's plan lane, which selects WHICH idle threshold applies: a
   * terminal (`done`/`cancelled`) thread with no obligations is spent — a human
   * resume re-spawns it — so it does not need its provider process kept warm for
   * as long as a live one. Free here: the obligations row already selects it.
   */
  readonly planLane: string;
  readonly activeTurnId: TurnId | null;
  readonly liveChildCount: number;
  readonly hasUnmetDependencies: boolean;
  readonly openUserInputCount: number;
  readonly pendingRework: boolean;
}

/**
 * An archived-but-not-deleted isolated child still pointing at its own worktree:
 * the minimum the fan-in reactor's deferred-removal branch needs to finish the
 * cleanup (remove the checkout, delete the branch, repoint the child and any
 * resident off the removed path).
 */
export interface ProjectionArchivedWorktreeChild {
  readonly threadId: ThreadId;
  readonly branch: string;
  readonly worktreePath: string;
  /**
   * The parent's own coordinates, joined in rather than looked up in the pass
   * index: the parent of an archived child is often archived too (archive
   * cascades), and it is absent from the shell snapshot when it is — which would
   * reintroduce the same invisibility this read exists to remove.
   */
  readonly parentProjectId: ProjectId;
  readonly parentBranch: string | null;
  readonly parentWorktreePath: string | null;
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
   * The control-plane read: the SAME active thread rows as `getShellSnapshot`,
   * with only the columns a sweep actually uses (see
   * `OrchestrationLeanShellSnapshot`). Every background sweep should read this;
   * only the client shell and the MCP surface need the wide columns.
   *
   * `role` narrows to a single thread role, for a sweep whose own first-line
   * skip is already `thread.role !== X` (the handoff drafter). This is a
   * QUARRY projection, safe only because `role` is immutable after spawn — it
   * is emphatically NOT the refuted settledness filter, which could drop a row
   * the sweep still owed an action on. Never narrow by a mutable, user-facing
   * axis. Note that `updatedAt` then covers the quarry rather than the whole
   * store; no consumer reads it, and a role-scoped caller wants the scoped one.
   */
  readonly getLeanShellSnapshot: (options?: {
    readonly role: string;
  }) => Effect.Effect<OrchestrationLeanShellSnapshot, ProjectionRepositoryError>;

  /**
   * The parents currently owed a DERIVED `needs_guidance` because a child has
   * sat brief-needed past {@link BRIEF_NEEDED_ATTENTION_MS} (liveness plan §3.3).
   *
   * Deliberately a SEPARATE read rather than a decoration on the shell queries:
   * `getShellSnapshot`/`getThreadShellById` are also the dispatcher's and
   * liveness sweep's control-plane reads, and those judge `attention.length` as
   * stored state — a derived member there would make a parent look internally
   * paused (suppressing its own stall recovery, waking ITS parent) merely
   * because a grandchild is unbriefed. Only the outward-facing boundary
   * (`briefNeededOutwardAttention`, applied in the ws shell stream and the shell
   * HTTP route) unions this into `attention`.
   */
  readonly getBriefNeededAttentionParentIds: () => Effect.Effect<
    ReadonlySet<ThreadId>,
    ProjectionRepositoryError
  >;

  /**
   * Read the live subtree rooted at a thread, with each member's session
   * liveness — the exact input the archive teardown sweep needs.
   *
   * This exists so archive does NOT pay for `getShellSnapshot()`, which
   * hydrates every active thread and shells out to `git` per workspace root to
   * resolve repository identities (hundreds of ms, sometimes >1s) purely to
   * derive a handful of thread ids. The lineage walk is a recursive CTE over
   * `idx_projection_threads_parent_thread_id`, so the cost tracks the subtree,
   * not the whole projection.
   *
   * The commanded root is always included, even when it is absent from the
   * projection, so the caller's sweep set matches the decider's cascade.
   */
  readonly getLiveSubtreeSessionLiveness: (
    threadId: ThreadId,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly threadId: ThreadId; readonly hasLiveSession: boolean }>,
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
   * Search active thread navigation metadata, user messages, and canonical
   * assistant outputs without hydrating thread detail snapshots.
   */
  readonly searchThreads: (
    input: OrchestrationSearchThreadsInput,
  ) => Effect.Effect<OrchestrationSearchThreadsResult, ProjectionRepositoryError>;

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
   * Read a single non-deleted goal (with its assembled task tree) by id.
   *
   * Unlike `getGoalShellById` an ARCHIVED goal is still returned: a thread whose
   * goal has been archived may still read and mutate its task tree.
   */
  readonly getGoalById: (
    goalId: GoalId,
  ) => Effect.Effect<Option.Option<OrchestrationGoal>, ProjectionRepositoryError>;

  /**
   * Read every goal slug of a project, INCLUDING deleted goals — slugs are
   * unique per project over all rows, so a uniqueness check must see them all.
   */
  readonly listGoalSlugsByProjectId: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<string>, ProjectionRepositoryError>;

  /**
   * Read the identities of all active projects in creation order, for callers
   * that resolve a project by id or title without needing project bodies.
   */
  readonly listActiveProjectRefs: () => Effect.Effect<
    ReadonlyArray<ProjectionActiveProjectRef>,
    ProjectionRepositoryError
  >;

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
   * Read the outstanding obligations still pending on ONE thread — its active
   * turn, live children, unmet dependencies, open user-input requests and open
   * rework round. This is the provider-session reaper's whole liveness input: a
   * thread with any obligation is waiting, not abandoned.
   *
   * Returns the empty (no-obligation) result for an unknown thread id, so a
   * binding whose projection row is gone stays reapable.
   */
  readonly getThreadObligations: (
    threadId: ThreadId,
  ) => Effect.Effect<ProjectionThreadObligations, ProjectionRepositoryError>;

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
   * loom: ids of threads that are DELETED (not merely archived), for the
   * provider-session retention sweep.
   *
   * One query for the whole set, because the sweep must classify every
   * persisted binding: doing it per binding cost six statements each on the
   * single serial SQL connection, which is a periodic global stall.
   *
   * Deletion is the only irreversible thread lifecycle state — `thread.archive`
   * has a matching `thread.unarchive` command, so an archived thread can come
   * back and must keep its provider binding.
   */
  readonly getDeletedThreadIds: () => Effect.Effect<
    ReadonlySet<ThreadId>,
    ProjectionRepositoryError
  >;

  /**
   * loom: fanned-in isolated children that are ARCHIVED but not deleted and
   * still point at their own worktree — the fan-in reactor's deferred-removal
   * blind spot.
   *
   * `getShellSnapshot()` filters `archived_at IS NULL`, so a child archived while
   * its worktree was still occupied is never selected by the deferred-removal
   * branch again: it is stranded permanently AND silently (never selected means
   * never logged). Live example: one 29-hour-old orphan whose checkout was still
   * on disk and still git-registered.
   *
   * Deliberately a narrow read rather than "include archived rows in the shell
   * snapshot": that snapshot is navigation state (archived threads must not
   * appear in it) and the fan-in pass runs on every `thread.session-set`, so
   * unioning ~700 wide archived rows into it every pass would trade one leak for
   * a throughput regression. The predicate here is the orphan shape itself, so
   * production returns a single-digit row count.
   */
  readonly getArchivedFannedInWorktreeChildren: () => Effect.Effect<
    ReadonlyArray<ProjectionArchivedWorktreeChild>,
    ProjectionRepositoryError
  >;

  /**
   * loom: every `worktree_path` any thread row still references, regardless of
   * lifecycle (active, archived AND deleted).
   *
   * The reference set for the path-based orphan sweep. Lifecycle-blind on
   * purpose: a directory referenced by a deleted thread's row is not an
   * unreachable orphan, it is a row-owned checkout whose removal belongs to the
   * thread lifecycle, and the sweep must not claim it.
   */
  readonly getReferencedWorktreePaths: () => Effect.Effect<
    ReadonlySet<string>,
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
   *
   * When `window` is provided, the thread's messages, activities, proposed
   * plans, and checkpoints are bounded to a page of recent turns and the
   * response carries `page` metadata (see `OrchestrationThreadDetailWindow`).
   * Without a window the full thread is returned with no `page` field —
   * pagination is strictly opt-in.
   */
  readonly getThreadDetailSnapshot: (
    threadId: ThreadId,
    window?: OrchestrationThreadDetailWindow,
  ) => Effect.Effect<Option.Option<OrchestrationThreadDetailSnapshot>, ProjectionRepositoryError>;
}

/**
 * ProjectionSnapshotQuery - Service tag for projection snapshot queries.
 */
export class ProjectionSnapshotQuery extends Context.Service<
  ProjectionSnapshotQuery,
  ProjectionSnapshotQueryShape
>()("t3/orchestration/Services/ProjectionSnapshotQuery") {}
