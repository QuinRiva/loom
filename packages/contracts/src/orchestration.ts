import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Struct from "effect/Struct";
import { ProviderOptionSelections } from "./model.ts";
import { RepositoryIdentity } from "./environment.ts";
import {
  ApprovalRequestId,
  CheckpointRef,
  CommandId,
  EventId,
  GoalId,
  GoalTaskId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  NonNegativeNumber,
  ProjectId,
  ProviderItemId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const ORCHESTRATION_WS_METHODS = {
  dispatchCommand: "orchestration.dispatchCommand",
  getTurnDiff: "orchestration.getTurnDiff",
  getFullThreadDiff: "orchestration.getFullThreadDiff",
  replayEvents: "orchestration.replayEvents",
  getArchivedShellSnapshot: "orchestration.getArchivedShellSnapshot",
  subscribeShell: "orchestration.subscribeShell",
  subscribeThread: "orchestration.subscribeThread",
} as const;

export const ProviderApprovalPolicy = Schema.Literals([
  "untrusted",
  "on-failure",
  "on-request",
  "never",
]);
export type ProviderApprovalPolicy = typeof ProviderApprovalPolicy.Type;
export const ProviderSandboxMode = Schema.Literals([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
export type ProviderSandboxMode = typeof ProviderSandboxMode.Type;

/**
 * `ModelSelection` — selection of a model on a configured provider instance.
 *
 * The routing key is `instanceId` (a user-defined slug identifying one
 * configured provider instance). Drivers, credentials, working-directory
 * bindings, and any other per-instance state are recovered from the
 * runtime registry via the instance id.
 *
 * Wire legacy: persisted selections produced before the driver/instance
 * split carried a `provider: <driver-id>` field instead. The schema absorbs
 * that shape via a pre-decoding transform — `{provider, model}` is promoted
 * to `{instanceId: defaultInstanceIdForDriver(provider), model}`. No
 * post-decode compatibility code lives in the runtime; the transform is the
 * only compat surface.
 */
const ModelSelectionWire = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(ProviderOptionSelections),
});

// Source shape for persisted legacy payloads. Fields are typed as
// `Schema.Unknown` so malformed drafts still make it into the transform and
// fail validation through the target schema (with proper error messages)
// rather than at the source-struct layer where the error is less actionable.
const ModelSelectionSource = Schema.Struct({
  provider: Schema.optional(Schema.Unknown),
  instanceId: Schema.optional(Schema.Unknown),
  model: Schema.Unknown,
  options: Schema.optional(Schema.Unknown),
});

export const ModelSelection = ModelSelectionSource.pipe(
  Schema.decodeTo(
    ModelSelectionWire,
    SchemaTransformation.transformOrFail({
      decode: (raw) => {
        // Resolve the routing key: prefer an explicit `instanceId`; fall
        // back to promoting the legacy `provider` slug (the canonical
        // `defaultInstanceIdForDriver` mapping) so persisted rollout-era
        // payloads decode without data loss. The target schema brands the
        // string as `ProviderInstanceId`.
        const instanceIdSource =
          raw.instanceId !== undefined
            ? raw.instanceId
            : typeof raw.provider === "string"
              ? raw.provider
              : undefined;
        const base: Record<string, unknown> = {
          instanceId: instanceIdSource,
          model: raw.model,
        };
        if (raw.options !== undefined) base.options = raw.options;
        return Effect.succeed(base as typeof ModelSelectionWire.Encoded);
      },
      encode: (value) => {
        const base: Record<string, unknown> = {
          model: value.model,
          instanceId: value.instanceId,
        };
        if (value.options !== undefined) base.options = value.options;
        return Effect.succeed(base as typeof ModelSelectionSource.Encoded);
      },
    }),
  ),
);
export type ModelSelection = typeof ModelSelection.Type;

export const RuntimeMode = Schema.Literals([
  "approval-required",
  "auto-accept-edits",
  "full-access",
]);
export type RuntimeMode = typeof RuntimeMode.Type;
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
export const ProviderInteractionMode = Schema.Literals(["default", "plan"]);
export type ProviderInteractionMode = typeof ProviderInteractionMode.Type;
export const DEFAULT_PROVIDER_INTERACTION_MODE: ProviderInteractionMode = "default";

// Worktree isolation policy for a workstream sub-thread (worktree-isolation
// design §1). `isolated` = own worktree + `ws/…` branch, merged back on
// completion (fan-in); `shared` = runs in the parent's worktree (today's
// behaviour, no fan-in); `attached` = a gated reviewer that joins its gate
// target's worktree (never fans in itself). Decode-defaults to `shared` so
// root/pre-isolation threads keep today's behaviour.
export const ThreadIsolation = Schema.Literals(["isolated", "shared", "attached"]);
export type ThreadIsolation = typeof ThreadIsolation.Type;
export const DEFAULT_THREAD_ISOLATION: ThreadIsolation = "shared";

// Fan-in settlement of an isolated child's branch back into the parent branch
// (design §3). `none` = not applicable (shared/attached/root, or an isolated
// child that has not yet fanned in); `completed` = merged cleanly (releases
// dependents); `conflicted` = merge aborted, dependents stay blocked, the
// parent is woken with the notice. Projected from `thread.fanin-set` events.
export const ThreadFanInState = Schema.Literals(["none", "completed", "conflicted"]);
export type ThreadFanInState = typeof ThreadFanInState.Type;
export const DEFAULT_THREAD_FAN_IN_STATE: ThreadFanInState = "none";
// Axis 1 — plan lane (intent; the kanban board). The only "lifecycle" axis,
// deliberately small. `in_progress` is control-plane-only (set by the
// dispatcher at kickoff); agents/humans may set the others. `done` is the only
// lane that releases dependents; `cancelled` is terminal but does not.
// `yielded` (review-gates design §5) is control-plane-only too: a submit whose
// outcome matched no route parks the thread turn-over, parent-woken — neither
// terminal (the generation join does not count it) nor releasing. Any
// turn-start on a `yielded` thread reverts it to `in_progress`.
export const ThreadPlanLane = Schema.Literals([
  "planned",
  "ready",
  "in_progress",
  "yielded",
  "done",
  "cancelled",
]);
export type ThreadPlanLane = typeof ThreadPlanLane.Type;
// Schema decode-default for root/manual thread creation. Spawns choose `ready`
// explicitly (staging is the opt-in `planned`) — see the spawn endpoint.
export const DEFAULT_THREAD_PLAN_LANE: ThreadPlanLane = "planned";

// Axis 3 — attention (needs-a-human; the single notification surface). A set of
// reason-tagged flags that co-exist with any plan lane and bubble up. Only the
// non-derivable reasons are STORED on a thread (`error`, `awaiting_acceptance`,
// `needs_guidance`); `awaiting_approval`/`awaiting_input` are projected from
// open approval/input requests and never stored. `error` is server-only (the
// liveness sweep sets it); the decider rejects an agent-issued `error` raise
// and rejects the two projected reasons outright.
export const AttentionReason = Schema.Literals([
  "error",
  "awaiting_approval",
  "awaiting_input",
  "awaiting_acceptance",
  "needs_guidance",
]);
export type AttentionReason = typeof AttentionReason.Type;
export const ThreadAttention = Schema.Array(AttentionReason);
export type ThreadAttention = typeof ThreadAttention.Type;

// ---------------------------------------------------------------------------
// Review gates (docs/design/workstream-review-gates.md §4, §8).
// ---------------------------------------------------------------------------

/** Default loop-round cap for a review gate when the spawner sets none. */
export const DEFAULT_GATE_MAX_ROUNDS = 2;

/** Maximum accepted loop-round cap for a review gate. */
export const MAX_GATE_MAX_ROUNDS = 10;

/**
 * An outcome-predicated route edge on the thread that EMITS the outcomes (the
 * gate source, e.g. the reviewer). `loop` re-dispatches the counterpart named
 * by `to` (round-capped); `resolve` completes the gate (both parties `done`).
 * Outcomes matching no edge yield the thread to the live orchestrator.
 */
export const WorkstreamRoute = Schema.Struct({
  // Outcome tokens this edge matches (open strings — the generic primitive).
  on: Schema.Array(TrimmedNonEmptyString),
  kind: Schema.Literals(["loop", "resolve"]),
  // Loop target (required for kind=loop; unused for resolve).
  to: Schema.optional(ThreadId),
  // Loop only; defaults to DEFAULT_GATE_MAX_ROUNDS.
  maxRounds: Schema.optional(NonNegativeInt),
});
export type WorkstreamRoute = typeof WorkstreamRoute.Type;

/** The routing verdict the decider reached for a submitted outcome. */
export const WorkOutcomeDecision = Schema.Literals([
  "terminal",
  "loop",
  "resolve",
  "yield",
  "cap-breach",
  "attention",
]);
export type WorkOutcomeDecision = typeof WorkOutcomeDecision.Type;

/** Reviewer finding counts, opaque to routing — audit trail + UI verdict chip. */
export const WorkOutcomeCounts = Schema.Struct({
  mustFix: NonNegativeInt,
  niceToHave: NonNegativeInt,
});
export type WorkOutcomeCounts = typeof WorkOutcomeCounts.Type;

/**
 * Projected record of a thread's most recent submitted outcome (`lastOutcome`).
 * `recordedByEventId` is the id of the `thread.outcome-recorded` event that
 * produced it — the durable per-yield-episode key the dispatcher's wake rail
 * dedups on (design §6).
 */
export const WorkOutcomeRecord = Schema.Struct({
  outcome: TrimmedNonEmptyString,
  decision: WorkOutcomeDecision,
  round: NonNegativeInt,
  contested: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  counts: Schema.optional(WorkOutcomeCounts),
  recordedByEventId: EventId,
  at: IsoDateTime,
});
export type WorkOutcomeRecord = typeof WorkOutcomeRecord.Type;

// Migration-only (design §9): the pre-three-axis stored status. Retained solely
// so historical `thread.status-set` events still decode on replay and remap
// into planLane/attention in the projector. NEVER emitted by any live command
// path — the live surface is plan-lane.set + attention.raise/clear.
export const LegacyThreadStatus = Schema.Literals([
  "planned",
  "running",
  "blocked",
  "review",
  "done",
  "error",
]);
export type LegacyThreadStatus = typeof LegacyThreadStatus.Type;
export const ProviderRequestKind = Schema.Literals(["command", "file-read", "file-change"]);
export type ProviderRequestKind = typeof ProviderRequestKind.Type;
export const AssistantDeliveryMode = Schema.Literals(["buffered", "streaming"]);
export type AssistantDeliveryMode = typeof AssistantDeliveryMode.Type;
export const ProviderApprovalDecision = Schema.Literals([
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
]);
export type ProviderApprovalDecision = typeof ProviderApprovalDecision.Type;
export const ProviderUserInputAnswers = Schema.Record(Schema.String, Schema.Unknown);
export type ProviderUserInputAnswers = typeof ProviderUserInputAnswers.Type;

export const PROVIDER_SEND_TURN_MAX_INPUT_CHARS = 120_000;
export const PROVIDER_SEND_TURN_MAX_ATTACHMENTS = 8;
export const PROVIDER_SEND_TURN_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS = 14_000_000;
const CHAT_ATTACHMENT_ID_MAX_CHARS = 128;
// Correlation id is command id by design in this model.
export const CorrelationId = CommandId;
export type CorrelationId = typeof CorrelationId.Type;

const ChatAttachmentId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(CHAT_ATTACHMENT_ID_MAX_CHARS),
  Schema.isPattern(/^[a-z0-9_-]+$/i),
);
export type ChatAttachmentId = typeof ChatAttachmentId.Type;

export const ChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
});
export type ChatImageAttachment = typeof ChatImageAttachment.Type;

const UploadChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
  dataUrl: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS),
  ),
});
export type UploadChatImageAttachment = typeof UploadChatImageAttachment.Type;

export const ChatAttachment = Schema.Union([ChatImageAttachment]);
export type ChatAttachment = typeof ChatAttachment.Type;
const UploadChatAttachment = Schema.Union([UploadChatImageAttachment]);
export type UploadChatAttachment = typeof UploadChatAttachment.Type;

export const ProjectScriptIcon = Schema.Literals([
  "play",
  "test",
  "lint",
  "configure",
  "build",
  "debug",
]);
export type ProjectScriptIcon = typeof ProjectScriptIcon.Type;

export const ProjectScript = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  icon: ProjectScriptIcon,
  runOnWorktreeCreate: Schema.Boolean,
  /**
   * URL to open in the in-app browser preview when this script runs (or
   * when the user explicitly requests a preview). Optional; only honored on
   * the desktop build.
   */
  previewUrl: Schema.optional(TrimmedNonEmptyString),
  /**
   * When true, automatically open the preview panel pointed at `previewUrl`
   * the moment this script starts. Ignored without `previewUrl` or on web.
   */
  autoOpenPreview: Schema.optional(Schema.Boolean),
});
export type ProjectScript = typeof ProjectScript.Type;

export const OrchestrationProject = Schema.Struct({
  id: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationProject = typeof OrchestrationProject.Type;

export const OrchestrationMessageRole = Schema.Literals(["user", "assistant", "system"]);
export type OrchestrationMessageRole = typeof OrchestrationMessageRole.Type;

export const OrchestrationMessage = Schema.Struct({
  id: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  // Model reasoning/thinking trace for this (assistant) message, captured as a
  // parallel channel to `text` and rendered as a collapsible block above the
  // answer. Absent for messages without reasoning.
  reasoningText: Schema.optional(Schema.String),
  reasoningStreaming: Schema.optional(Schema.Boolean),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationMessage = typeof OrchestrationMessage.Type;

export const OrchestrationProposedPlanId = TrimmedNonEmptyString;
export type OrchestrationProposedPlanId = typeof OrchestrationProposedPlanId.Type;

export const OrchestrationProposedPlan = Schema.Struct({
  id: OrchestrationProposedPlanId,
  turnId: Schema.NullOr(TurnId),
  planMarkdown: TrimmedNonEmptyString,
  implementedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  implementationThreadId: Schema.NullOr(ThreadId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationProposedPlan = typeof OrchestrationProposedPlan.Type;

const SourceProposedPlanReference = Schema.Struct({
  threadId: ThreadId,
  planId: OrchestrationProposedPlanId,
});

export const OrchestrationSessionStatus = Schema.Literals([
  "idle",
  "starting",
  "running",
  "ready",
  "interrupted",
  "stopped",
  "error",
]);
export type OrchestrationSessionStatus = typeof OrchestrationSessionStatus.Type;

export const QueuedMessages = Schema.Struct({
  steering: Schema.Array(Schema.String),
  followUp: Schema.Array(Schema.String),
});
export type QueuedMessages = typeof QueuedMessages.Type;

export const OrchestrationSession = Schema.Struct({
  threadId: ThreadId,
  status: OrchestrationSessionStatus,
  providerName: Schema.NullOr(TrimmedNonEmptyString),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  activeTurnId: Schema.NullOr(TurnId),
  lastError: Schema.NullOr(TrimmedNonEmptyString),
  // Ephemeral live queue of pending messages (steer folds into the running
  // turn, followUp runs after). Optional with an empty default so DB-hydrated
  // sessions, which never persist it, decode cleanly and start with no queue.
  queuedMessages: QueuedMessages.pipe(
    Schema.withDecodingDefault(Effect.succeed({ steering: [], followUp: [] })),
  ),
  updatedAt: IsoDateTime,
});
export type OrchestrationSession = typeof OrchestrationSession.Type;

export const OrchestrationCheckpointFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: TrimmedNonEmptyString,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type OrchestrationCheckpointFile = typeof OrchestrationCheckpointFile.Type;

export const OrchestrationCheckpointStatus = Schema.Literals(["ready", "missing", "error"]);
export type OrchestrationCheckpointStatus = typeof OrchestrationCheckpointStatus.Type;

export const OrchestrationCheckpointSummary = Schema.Struct({
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type OrchestrationCheckpointSummary = typeof OrchestrationCheckpointSummary.Type;

export const OrchestrationThreadActivityTone = Schema.Literals([
  "info",
  "tool",
  "approval",
  "error",
]);
export type OrchestrationThreadActivityTone = typeof OrchestrationThreadActivityTone.Type;

export const OrchestrationThreadActivity = Schema.Struct({
  id: EventId,
  tone: OrchestrationThreadActivityTone,
  kind: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  payload: Schema.Unknown,
  turnId: Schema.NullOr(TurnId),
  sequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
});
export type OrchestrationThreadActivity = typeof OrchestrationThreadActivity.Type;

const OrchestrationLatestTurnState = Schema.Literals([
  "running",
  "interrupted",
  "completed",
  "error",
]);
export type OrchestrationLatestTurnState = typeof OrchestrationLatestTurnState.Type;

export const OrchestrationLatestTurn = Schema.Struct({
  turnId: TurnId,
  state: OrchestrationLatestTurnState,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  assistantMessageId: Schema.NullOr(MessageId),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
});
export type OrchestrationLatestTurn = typeof OrchestrationLatestTurn.Type;

export const OrchestrationThread = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  goalId: Schema.NullOr(GoalId),
  parentThreadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  role: Schema.NullOr(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  purpose: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  brief: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  planLane: ThreadPlanLane.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_THREAD_PLAN_LANE)),
  ),
  attention: ThreadAttention.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  blockedBy: Schema.Array(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  // D-notify: the spawn batch this sub-thread belongs to (the parent's turn id
  // at spawn time). Children sharing a (parentThreadId, spawnGeneration) form a
  // join barrier; the parent is woken once every member is terminal. Durable so
  // the join is recomputable from the read model after a restart.
  spawnGeneration: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  // D-notify: pointer to this thread's completion report markdown file (content
  // lives on disk, never in the event store). Null until the child reports.
  reportPath: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  // Review gates (design §8): outcome route edges + projected loop counters.
  // All decode-defaulted so pre-gate snapshots load.
  routes: Schema.Array(WorkstreamRoute).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  gateRounds: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  pendingRework: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  lastOutcome: Schema.NullOr(WorkOutcomeRecord).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  // Worktree isolation policy (design §1) + fan-in settlement (design §3).
  // Additive, decode-defaulted so pre-isolation snapshots load as today's
  // shared/no-fan-in behaviour.
  isolation: ThreadIsolation.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_THREAD_ISOLATION)),
  ),
  fanInState: ThreadFanInState.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_THREAD_FAN_IN_STATE)),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  // Cumulative dollar spend for THIS thread alone (sum of every assistant
  // message's `usage.cost.total`, folded from the durable activity log so it is
  // replay-safe). Additive/optional on the wire — absent (treated as 0) when the
  // provider reports no cost (e.g. non-pi adapters).
  cumulativeCostUsd: Schema.optional(NonNegativeNumber),
  // Latest context-window snapshot for THIS thread (newest
  // `context-window.updated` activity's running session totals). Null when
  // unknown (non-pi providers / no activity yet) — distinct from cost's 0-default
  // so the UI suppresses the chip rather than showing a misleading 0. Additive +
  // decode-default so older snapshots still decode.
  toolUses: Schema.NullOr(NonNegativeInt).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  usedTokens: Schema.NullOr(NonNegativeInt).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  maxTokens: Schema.NullOr(NonNegativeInt).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  deletedAt: Schema.NullOr(IsoDateTime),
  messages: Schema.Array(OrchestrationMessage),
  proposedPlans: Schema.Array(OrchestrationProposedPlan).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  activities: Schema.Array(OrchestrationThreadActivity),
  checkpoints: Schema.Array(OrchestrationCheckpointSummary),
  session: Schema.NullOr(OrchestrationSession),
});
export type OrchestrationThread = typeof OrchestrationThread.Type;

export interface OrchestrationGoalTask {
  readonly id: GoalTaskId;
  readonly goalId: GoalId;
  readonly parentTaskId: GoalTaskId | null;
  readonly text: string;
  readonly done: boolean;
  readonly position: number;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
  readonly deletedAt: IsoDateTime | null;
  readonly children: ReadonlyArray<OrchestrationGoalTask>;
}

interface OrchestrationGoalTaskEncoded {
  readonly id: string;
  readonly goalId: string;
  readonly parentTaskId: string | null;
  readonly text: string;
  readonly done: boolean;
  readonly position: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
  readonly children: ReadonlyArray<OrchestrationGoalTaskEncoded>;
}

export const OrchestrationGoalTask: Schema.Codec<
  OrchestrationGoalTask,
  OrchestrationGoalTaskEncoded
> = Schema.Struct({
  id: GoalTaskId,
  goalId: GoalId,
  parentTaskId: Schema.NullOr(GoalTaskId),
  text: TrimmedNonEmptyString,
  done: Schema.Boolean,
  position: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
  children: Schema.Array(
    Schema.suspend(
      (): Schema.Codec<OrchestrationGoalTask, OrchestrationGoalTaskEncoded> =>
        OrchestrationGoalTask,
    ),
  ),
});

export const OrchestrationGoal = Schema.Struct({
  id: GoalId,
  projectId: ProjectId,
  slug: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  description: Schema.String,
  tasks: Schema.Array(OrchestrationGoalTask),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationGoal = typeof OrchestrationGoal.Type;

export const OrchestrationGoalShell = Schema.Struct({
  id: GoalId,
  projectId: ProjectId,
  slug: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  description: Schema.String,
  tasks: Schema.Array(OrchestrationGoalTask),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationGoalShell = typeof OrchestrationGoalShell.Type;

export const OrchestrationReadModel = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProject),
  goals: Schema.Array(OrchestrationGoal),
  threads: Schema.Array(OrchestrationThread),
  updatedAt: IsoDateTime,
});
export type OrchestrationReadModel = typeof OrchestrationReadModel.Type;

export const OrchestrationProjectShell = Schema.Struct({
  id: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationProjectShell = typeof OrchestrationProjectShell.Type;

// consult_thread observability: an aggregated consult EDGE on the asker's
// shell — one entry per distinct target this thread has consulted. Lets the
// workstream graph draw consult edges from thread shells alone; the full
// question + answer of each individual consult lives on the
// `thread.consult-recorded` event, not here. `lastQuestionPreview` is a
// bounded shell-level preview (the full text is on the event).
export const OrchestrationThreadConsultSummary = Schema.Struct({
  targetThreadId: ThreadId,
  targetTitle: Schema.String,
  count: NonNegativeInt,
  lastConsultAt: IsoDateTime,
  lastQuestionPreview: Schema.String,
});
export type OrchestrationThreadConsultSummary = typeof OrchestrationThreadConsultSummary.Type;

export const OrchestrationThreadShell = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  goalId: Schema.NullOr(GoalId),
  parentThreadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  role: Schema.NullOr(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  purpose: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  brief: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  planLane: ThreadPlanLane.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_THREAD_PLAN_LANE)),
  ),
  attention: ThreadAttention.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  blockedBy: Schema.Array(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  spawnGeneration: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  reportPath: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  // Review gates (design §8): see OrchestrationThread.
  routes: Schema.Array(WorkstreamRoute).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  gateRounds: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  pendingRework: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  lastOutcome: Schema.NullOr(WorkOutcomeRecord).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  // Worktree isolation policy + fan-in settlement. See OrchestrationThread.
  isolation: ThreadIsolation.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_THREAD_ISOLATION)),
  ),
  fanInState: ThreadFanInState.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_THREAD_FAN_IN_STATE)),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  // Cumulative dollar spend for THIS thread alone. See OrchestrationThread.
  cumulativeCostUsd: Schema.optional(NonNegativeNumber),
  // Latest context-window snapshot for THIS thread. See OrchestrationThread.
  // Null when unknown so the UI can suppress the chip rather than show 0.
  toolUses: Schema.NullOr(NonNegativeInt).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  usedTokens: Schema.NullOr(NonNegativeInt).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  maxTokens: Schema.NullOr(NonNegativeInt).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  session: Schema.NullOr(OrchestrationSession),
  latestUserMessageAt: Schema.NullOr(IsoDateTime),
  hasPendingApprovals: Schema.Boolean,
  hasPendingUserInput: Schema.Boolean,
  hasActionableProposedPlan: Schema.Boolean,
  /**
   * Short human-readable description of the most recent activity for this
   * thread — the latest assistant-narration text, truncated to roughly one
   * line. Null when the thread has no assistant narration yet. Additive,
   * nullable projection field (decode-default null) so older snapshots load.
   */
  lastActivityPreview: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  // consult_thread observability: consult edges from THIS (asker) thread,
  // deduped by target. Additive, decode-defaulted so older snapshots load.
  consults: Schema.Array(OrchestrationThreadConsultSummary).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type OrchestrationThreadShell = typeof OrchestrationThreadShell.Type;

export const OrchestrationShellSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProjectShell),
  goals: Schema.Array(OrchestrationGoalShell),
  threads: Schema.Array(OrchestrationThreadShell),
  updatedAt: IsoDateTime,
});
export type OrchestrationShellSnapshot = typeof OrchestrationShellSnapshot.Type;

export const OrchestrationShellStreamEvent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("project-upserted"),
    sequence: NonNegativeInt,
    project: OrchestrationProjectShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("project-removed"),
    sequence: NonNegativeInt,
    projectId: ProjectId,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread-upserted"),
    sequence: NonNegativeInt,
    thread: OrchestrationThreadShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread-removed"),
    sequence: NonNegativeInt,
    threadId: ThreadId,
  }),
  Schema.Struct({
    kind: Schema.Literal("goal-upserted"),
    sequence: NonNegativeInt,
    goal: OrchestrationGoalShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("goal-removed"),
    sequence: NonNegativeInt,
    goalId: GoalId,
  }),
]);
export type OrchestrationShellStreamEvent = typeof OrchestrationShellStreamEvent.Type;

export const OrchestrationShellStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: OrchestrationShellSnapshot,
  }),
  OrchestrationShellStreamEvent,
]);
export type OrchestrationShellStreamItem = typeof OrchestrationShellStreamItem.Type;

export const OrchestrationSubscribeThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type OrchestrationSubscribeThreadInput = typeof OrchestrationSubscribeThreadInput.Type;

export const OrchestrationThreadDetailSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  thread: OrchestrationThread,
});
export type OrchestrationThreadDetailSnapshot = typeof OrchestrationThreadDetailSnapshot.Type;

export const ProjectCreateCommand = Schema.Struct({
  type: Schema.Literal("project.create"),
  commandId: CommandId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  createWorkspaceRootIfMissing: Schema.optional(Schema.Boolean),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  createdAt: IsoDateTime,
});

const ProjectMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("project.meta.update"),
  commandId: CommandId,
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
});

const ProjectDeleteCommand = Schema.Struct({
  type: Schema.Literal("project.delete"),
  commandId: CommandId,
  projectId: ProjectId,
  force: Schema.optional(Schema.Boolean),
});

const ThreadCreateCommand = Schema.Struct({
  type: Schema.Literal("thread.create"),
  commandId: CommandId,
  threadId: ThreadId,
  projectId: ProjectId,
  goalId: Schema.optional(Schema.NullOr(GoalId)),
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  role: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  purpose: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  brief: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  // Intrinsic run-condition carried at node creation: the dispatcher defers the
  // kick-off turn until every blockedBy thread is `done`. A dependency-bearing
  // create is validated at the decider boundary (self/root/dangling/cycle
  // rejected); only the runtime predicate stays permissive as a backstop.
  blockedBy: Schema.optional(Schema.Array(ThreadId)),
  // Review gates (design §4): outcome route edges declared at spawn (compiled
  // from the spawn `gate` sugar). Omitted ⇒ no routes.
  routes: Schema.optional(Schema.Array(WorkstreamRoute)),
  // Worktree isolation policy (design §1). Set by the spawn path from the
  // optional `isolation` param or the role-default table; omitted on
  // root/manual creation — defaults to `shared` via the read-model decode.
  isolation: Schema.optional(ThreadIsolation),
  // Initial plan lane. Spawns pass `ready` (runs once deps clear) or `planned`
  // (staged/held for the review-the-graph flow). Omitted on root/manual
  // creation — defaults to `planned` via the read-model decode default.
  planLane: Schema.optional(ThreadPlanLane),
  // D-notify: spawn-batch stamp (the parent's turn id at spawn). Set by the
  // spawn path so siblings of the same parent turn join into one wake.
  spawnGeneration: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});

const ThreadDeleteCommand = Schema.Struct({
  type: Schema.Literal("thread.delete"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadArchiveCommand = Schema.Struct({
  type: Schema.Literal("thread.archive"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadUnarchiveCommand = Schema.Struct({
  type: Schema.Literal("thread.unarchive"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("thread.meta.update"),
  commandId: CommandId,
  threadId: ThreadId,
  title: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  goalId: Schema.optional(Schema.NullOr(GoalId)),
  role: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  purpose: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});

const ThreadRuntimeModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.runtime-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  createdAt: IsoDateTime,
});

const ThreadInteractionModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.interaction-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode,
  createdAt: IsoDateTime,
});

// Axis 1 write (plan lane). Authorisation chokepoint lives in the decider:
// `in_progress` is control-plane-only (set atomically at kickoff), so an
// agent/client `in_progress` is rejected unless the commandId is `server:`-
// prefixed; `planned|ready|done|cancelled` are accepted from client/agent.
const ThreadPlanLaneSetCommand = Schema.Struct({
  type: Schema.Literal("thread.plan-lane.set"),
  commandId: CommandId,
  threadId: ThreadId,
  planLane: ThreadPlanLane,
  createdAt: IsoDateTime,
});

// Axis 3 write (raise attention). `error` is server-only; the two `awaiting_*`
// request reasons are projected from open requests and rejected outright. Only
// `awaiting_acceptance`/`needs_guidance` are agent-raisable (decider-enforced).
const ThreadAttentionRaiseCommand = Schema.Struct({
  type: Schema.Literal("thread.attention.raise"),
  commandId: CommandId,
  threadId: ThreadId,
  reason: AttentionReason,
  createdAt: IsoDateTime,
});

// Axis 3 write (clear attention). An omitted `reason` clears ALL stored
// attention (the lifecycle clear-all used by turn-start / plan-terminal
// transitions); a present `reason` clears just that flag (human/parent dismiss).
const ThreadAttentionClearCommand = Schema.Struct({
  type: Schema.Literal("thread.attention.clear"),
  commandId: CommandId,
  threadId: ThreadId,
  reason: Schema.optional(AttentionReason),
  createdAt: IsoDateTime,
});

const ThreadDependenciesSetCommand = Schema.Struct({
  type: Schema.Literal("thread.dependencies.set"),
  commandId: CommandId,
  threadId: ThreadId,
  blockedBy: Schema.Array(ThreadId),
  createdAt: IsoDateTime,
});

const ThreadTurnStartBootstrapCreateThread = Schema.Struct({
  projectId: ProjectId,
  goalId: Schema.optional(Schema.NullOr(GoalId)),
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  role: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  purpose: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  brief: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});

const ThreadTurnStartBootstrapPrepareWorktree = Schema.Struct({
  projectCwd: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  branch: Schema.optional(TrimmedNonEmptyString),
  startFromOrigin: Schema.optional(Schema.Boolean),
});

const ThreadTurnStartBootstrap = Schema.Struct({
  createThread: Schema.optional(ThreadTurnStartBootstrapCreateThread),
  prepareWorktree: Schema.optional(ThreadTurnStartBootstrapPrepareWorktree),
  runSetupScript: Schema.optional(Schema.Boolean),
});

export type ThreadTurnStartBootstrap = typeof ThreadTurnStartBootstrap.Type;

export const ThreadTurnStartCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.start"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(ChatAttachment),
  }),
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  bootstrap: Schema.optional(ThreadTurnStartBootstrap),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  // D-notify: server-only flag set by the WorkstreamDispatcher on parent wakes.
  // When true the turn-start is an atomic idle-gated injection: the serialized
  // command boundary skips it (without recording a rejection) unless the target
  // thread is idle (no pending turn-start, session not running, no active turn).
  // Never set by clients — normal user/agent turn-starts must remain unguarded
  // so steering and human send-while-running keep working.
  requireIdle: Schema.optional(Schema.Boolean),
  // D-notify (D-core kickoff): server-only flag set by the WorkstreamDispatcher
  // when it promotes a sub-thread. When true the decider emits a
  // `thread.plan-lane-set in_progress` event (plus an attention-clear-all) in
  // the SAME command as the turn-start, so the kickoff is one atomic engine
  // transaction that can never be half-applied by a crash between two
  // dispatches. Sticky-terminal: a turn-start on an already-`done`/`cancelled`
  // thread leaves the lane and attention untouched (runtime alone reflects the
  // re-engagement activity). Never set by clients — normal user/agent
  // turn-starts must not flip the plan lane.
  setInProgress: Schema.optional(Schema.Boolean),
  // Review gates (design §5.2): server-only flag set by the dispatcher's gate
  // pass when it loops work back to a coder whose round-0 `done` must be
  // reopened. The decider accepts it only on `server:`-prefixed command ids and
  // only from `done` (never `cancelled`), atomically reverting the lane to
  // `in_progress` in the same transaction. Contract-only until Phase 3 wires
  // the gate pass; nothing sets it before then.
  reopen: Schema.optional(Schema.Boolean),
  createdAt: IsoDateTime,
});

const ClientThreadTurnStartCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.start"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(UploadChatAttachment),
  }),
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  bootstrap: Schema.optional(ThreadTurnStartBootstrap),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

const ThreadTurnInterruptCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.interrupt"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadApprovalRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.approval.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
});

const ThreadUserInputRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.user-input.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  createdAt: IsoDateTime,
});

const ThreadCheckpointRevertCommand = Schema.Struct({
  type: Schema.Literal("thread.checkpoint.revert"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadSessionStopCommand = Schema.Struct({
  type: Schema.Literal("thread.session.stop"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

const GoalCreateCommand = Schema.Struct({
  type: Schema.Literal("goal.create"),
  commandId: CommandId,
  goalId: GoalId,
  projectId: ProjectId,
  slug: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  description: Schema.optional(Schema.String),
  createdAt: IsoDateTime,
});

const GoalMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("goal.meta.update"),
  commandId: CommandId,
  goalId: GoalId,
  slug: Schema.optional(TrimmedNonEmptyString),
  title: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(Schema.String),
});

const GoalArchiveCommand = Schema.Struct({
  type: Schema.Literal("goal.archive"),
  commandId: CommandId,
  goalId: GoalId,
});

const GoalUnarchiveCommand = Schema.Struct({
  type: Schema.Literal("goal.unarchive"),
  commandId: CommandId,
  goalId: GoalId,
});

const GoalDeleteCommand = Schema.Struct({
  type: Schema.Literal("goal.delete"),
  commandId: CommandId,
  goalId: GoalId,
});

const GoalTaskCreateCommand = Schema.Struct({
  type: Schema.Literal("goal.task.create"),
  commandId: CommandId,
  goalId: GoalId,
  taskId: GoalTaskId,
  parentTaskId: Schema.NullOr(GoalTaskId),
  text: TrimmedNonEmptyString,
  position: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
});

// Task reparenting is intentionally unsupported for MVP: there is no
// `parentTaskId` here, which removes the only path to a task-tree cycle.
const GoalTaskUpdateCommand = Schema.Struct({
  type: Schema.Literal("goal.task.update"),
  commandId: CommandId,
  goalId: GoalId,
  taskId: GoalTaskId,
  text: Schema.optional(TrimmedNonEmptyString),
  done: Schema.optional(Schema.Boolean),
  position: Schema.optional(NonNegativeInt),
});

const GoalTaskDeleteCommand = Schema.Struct({
  type: Schema.Literal("goal.task.delete"),
  commandId: CommandId,
  goalId: GoalId,
  taskId: GoalTaskId,
});

const DispatchableClientOrchestrationCommand = Schema.Union([
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
  GoalCreateCommand,
  GoalMetaUpdateCommand,
  GoalArchiveCommand,
  GoalUnarchiveCommand,
  GoalDeleteCommand,
  GoalTaskCreateCommand,
  GoalTaskUpdateCommand,
  GoalTaskDeleteCommand,
  ThreadCreateCommand,
  ThreadDeleteCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadMetaUpdateCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ThreadPlanLaneSetCommand,
  ThreadAttentionRaiseCommand,
  ThreadAttentionClearCommand,
  ThreadDependenciesSetCommand,
  ThreadTurnStartCommand,
  ThreadTurnInterruptCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadCheckpointRevertCommand,
  ThreadSessionStopCommand,
]);
export type DispatchableClientOrchestrationCommand =
  typeof DispatchableClientOrchestrationCommand.Type;

export const ClientOrchestrationCommand = Schema.Union([
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
  GoalCreateCommand,
  GoalMetaUpdateCommand,
  GoalArchiveCommand,
  GoalUnarchiveCommand,
  GoalDeleteCommand,
  GoalTaskCreateCommand,
  GoalTaskUpdateCommand,
  GoalTaskDeleteCommand,
  ThreadCreateCommand,
  ThreadDeleteCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadMetaUpdateCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ThreadPlanLaneSetCommand,
  ThreadAttentionRaiseCommand,
  ThreadAttentionClearCommand,
  ThreadDependenciesSetCommand,
  ClientThreadTurnStartCommand,
  ThreadTurnInterruptCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadCheckpointRevertCommand,
  ThreadSessionStopCommand,
]);
export type ClientOrchestrationCommand = typeof ClientOrchestrationCommand.Type;

const ThreadSessionSetCommand = Schema.Struct({
  type: Schema.Literal("thread.session.set"),
  commandId: CommandId,
  threadId: ThreadId,
  session: OrchestrationSession,
  createdAt: IsoDateTime,
});

const ThreadMessageAssistantDeltaCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.delta"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  delta: Schema.String,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadMessageAssistantCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

// v2 (ephemeral reasoning): streaming reasoning chunks are NOT persisted as
// domain events — they flow over the transient ReasoningStreamBus. The only
// durable reasoning command is the completion, which carries the full
// accumulated text and is dispatched once per assistant segment at
// finalization. The projector REPLACES `reasoningText` with this full text.
const ThreadMessageReasoningCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.message.reasoning.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  reasoningText: Schema.String,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadProposedPlanUpsertCommand = Schema.Struct({
  type: Schema.Literal("thread.proposed-plan.upsert"),
  commandId: CommandId,
  threadId: ThreadId,
  proposedPlan: OrchestrationProposedPlan,
  createdAt: IsoDateTime,
});

const ThreadTurnDiffCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.diff.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  completedAt: IsoDateTime,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.optional(MessageId),
  checkpointTurnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadActivityAppendCommand = Schema.Struct({
  type: Schema.Literal("thread.activity.append"),
  commandId: CommandId,
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
  createdAt: IsoDateTime,
});

// consult_thread observability: the server chokepoint records one resolved
// consult (asker → target). Aggregate = the asker thread; the decider derives
// the `thread.consult-recorded` event. `answer` is the FULL answer (no
// truncation/pointer); `forkSessionPath` points at the retained fork jsonl when
// retention succeeded.
const ThreadConsultRecordCommand = Schema.Struct({
  type: Schema.Literal("thread.consult.record"),
  commandId: CommandId,
  threadId: ThreadId,
  targetThreadId: ThreadId,
  targetTitle: TrimmedNonEmptyString,
  question: TrimmedNonEmptyString,
  answer: Schema.String,
  resolved: Schema.Boolean,
  durationMs: NonNegativeInt,
  forkSessionPath: Schema.optional(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});

const ThreadRevertCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.revert.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

// Review gates (design §3): the single terminal call. Carries the on-disk
// report pointer (the HTTP handler wrote the markdown) plus a structured
// outcome; the decider derives the report-set + outcome-recorded + lane events
// in ONE transaction. REPLACES the old `thread.report.set` command (the
// `thread.report-set` EVENT stays in the enum so history replays).
const ThreadWorkSubmitCommand = Schema.Struct({
  type: Schema.Literal("thread.work.submit"),
  commandId: CommandId,
  threadId: ThreadId,
  reportPath: TrimmedNonEmptyString,
  // Omitted ⇒ "done" (plain completion, exactly the old two-call semantics).
  outcome: Schema.optional(TrimmedNonEmptyString),
  contested: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  counts: Schema.optional(WorkOutcomeCounts),
  createdAt: IsoDateTime,
});

// D-notify Fix A: a provider turn-start failed before `turn.started` ever
// landed, so no `thread.session-set running` will arrive to clear the pending
// turn-start row. This command durably clears that row, so the idle gate stops
// treating the parent as permanently busy (which would otherwise strand a
// deferred dispatcher wake forever).
const ThreadTurnStartFailCommand = Schema.Struct({
  type: Schema.Literal("thread.turn-start.fail"),
  commandId: CommandId,
  threadId: ThreadId,
  detail: Schema.String,
  createdAt: IsoDateTime,
});

// Worktree isolation fan-in (design §3): the reactor records an isolated
// child's fan-in settlement after merging its branch back into the parent
// branch. `completed` releases dependents; `conflicted` keeps them blocked and
// wakes the parent. Conflict paths ride the child's activity log, not this
// command (the typed thread field stays minimal).
const ThreadFanInSetCommand = Schema.Struct({
  type: Schema.Literal("thread.fanin.set"),
  commandId: CommandId,
  threadId: ThreadId,
  fanInState: ThreadFanInState,
  createdAt: IsoDateTime,
});

const InternalOrchestrationCommand = Schema.Union([
  ThreadSessionSetCommand,
  ThreadFanInSetCommand,
  ThreadMessageAssistantDeltaCommand,
  ThreadMessageAssistantCompleteCommand,
  ThreadMessageReasoningCompleteCommand,
  ThreadProposedPlanUpsertCommand,
  ThreadTurnDiffCompleteCommand,
  ThreadActivityAppendCommand,
  ThreadConsultRecordCommand,
  ThreadRevertCompleteCommand,
  ThreadWorkSubmitCommand,
  ThreadTurnStartFailCommand,
]);
export type InternalOrchestrationCommand = typeof InternalOrchestrationCommand.Type;

export const OrchestrationCommand = Schema.Union([
  DispatchableClientOrchestrationCommand,
  InternalOrchestrationCommand,
]);
export type OrchestrationCommand = typeof OrchestrationCommand.Type;

export const OrchestrationEventType = Schema.Literals([
  "project.created",
  "project.meta-updated",
  "project.deleted",
  "goal.created",
  "goal.meta-updated",
  "goal.archived",
  "goal.unarchived",
  "goal.deleted",
  "goal.task-created",
  "goal.task-updated",
  "goal.task-deleted",
  "thread.created",
  "thread.deleted",
  "thread.archived",
  "thread.unarchived",
  "thread.meta-updated",
  "thread.runtime-mode-set",
  "thread.interaction-mode-set",
  // Live plan/attention events (three-axis model).
  "thread.plan-lane-set",
  "thread.attention-raised",
  "thread.attention-cleared",
  // Migration-only (design §9): historical event, still decoded + remapped on
  // replay, never emitted by a live command path.
  "thread.status-set",
  "thread.dependencies-set",
  "thread.message-sent",
  "thread.message-reasoning",
  "thread.turn-start-requested",
  "thread.turn-start-failed",
  "thread.turn-interrupt-requested",
  "thread.approval-response-requested",
  "thread.user-input-response-requested",
  "thread.checkpoint-revert-requested",
  "thread.reverted",
  "thread.session-stop-requested",
  "thread.session-set",
  "thread.proposed-plan-upserted",
  "thread.turn-diff-completed",
  "thread.activity-appended",
  // consult_thread observability: one resolved consult (asker → target). Full
  // question + answer live in the payload; the asker shell aggregates edges.
  "thread.consult-recorded",
  "thread.report-set",
  // Review gates (design §3.2/§4.3): the structured outcome audit trail and the
  // control-plane loop traversals.
  "thread.outcome-recorded",
  "thread.route-taken",
  // Worktree isolation (design §3): an isolated child's fan-in settlement.
  "thread.fanin-set",
]);
export type OrchestrationEventType = typeof OrchestrationEventType.Type;

export const OrchestrationAggregateKind = Schema.Literals(["project", "goal", "thread"]);
export type OrchestrationAggregateKind = typeof OrchestrationAggregateKind.Type;
export const OrchestrationActorKind = Schema.Literals(["client", "server", "provider"]);

export const ProjectCreatedPayload = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ProjectMetaUpdatedPayload = Schema.Struct({
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
  updatedAt: IsoDateTime,
});

export const ProjectDeletedPayload = Schema.Struct({
  projectId: ProjectId,
  deletedAt: IsoDateTime,
});

export const GoalCreatedPayload = Schema.Struct({
  goalId: GoalId,
  projectId: ProjectId,
  slug: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  description: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const GoalMetaUpdatedPayload = Schema.Struct({
  goalId: GoalId,
  slug: Schema.optional(TrimmedNonEmptyString),
  title: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(Schema.String),
  updatedAt: IsoDateTime,
});

export const GoalArchivedPayload = Schema.Struct({
  goalId: GoalId,
  archivedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const GoalUnarchivedPayload = Schema.Struct({
  goalId: GoalId,
  updatedAt: IsoDateTime,
});

export const GoalDeletedPayload = Schema.Struct({
  goalId: GoalId,
  deletedAt: IsoDateTime,
});

export const GoalTaskCreatedPayload = Schema.Struct({
  goalId: GoalId,
  taskId: GoalTaskId,
  parentTaskId: Schema.NullOr(GoalTaskId),
  text: TrimmedNonEmptyString,
  position: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const GoalTaskUpdatedPayload = Schema.Struct({
  goalId: GoalId,
  taskId: GoalTaskId,
  text: Schema.optional(TrimmedNonEmptyString),
  done: Schema.optional(Schema.Boolean),
  position: Schema.optional(NonNegativeInt),
  updatedAt: IsoDateTime,
});

export const GoalTaskDeletedPayload = Schema.Struct({
  goalId: GoalId,
  taskId: GoalTaskId,
  deletedAt: IsoDateTime,
});

export const ThreadCreatedPayload = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  goalId: Schema.optional(Schema.NullOr(GoalId)),
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  role: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  purpose: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  brief: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  planLane: Schema.optional(ThreadPlanLane),
  attention: Schema.optional(ThreadAttention),
  blockedBy: Schema.optional(Schema.Array(ThreadId)),
  routes: Schema.optional(Schema.Array(WorkstreamRoute)),
  isolation: Schema.optional(ThreadIsolation),
  spawnGeneration: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadDeletedPayload = Schema.Struct({
  threadId: ThreadId,
  deletedAt: IsoDateTime,
});

export const ThreadArchivedPayload = Schema.Struct({
  threadId: ThreadId,
  archivedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadUnarchivedPayload = Schema.Struct({
  threadId: ThreadId,
  updatedAt: IsoDateTime,
});

export const ThreadMetaUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  title: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  goalId: Schema.optional(Schema.NullOr(GoalId)),
  role: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  purpose: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  updatedAt: IsoDateTime,
});

export const ThreadRuntimeModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  updatedAt: IsoDateTime,
});

export const ThreadInteractionModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  updatedAt: IsoDateTime,
});

export const ThreadPlanLaneSetPayload = Schema.Struct({
  threadId: ThreadId,
  planLane: ThreadPlanLane,
  // Re-engagement epoch (review-gates design §5.2 exception): present only
  // when a terminal thread (done/cancelled) is reopened to ready/planned via
  // the lane-set path. The parent's one-shot generation wake is keyed
  // (parentId, spawnGeneration) with durable receipts, so the reopened re-run
  // must join a FRESH generation for its completion to fire a fresh wake.
  spawnGeneration: Schema.optional(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});

export const ThreadAttentionRaisedPayload = Schema.Struct({
  threadId: ThreadId,
  reason: AttentionReason,
  updatedAt: IsoDateTime,
});

// An omitted `reason` means clear ALL stored attention (lifecycle clear-all);
// a present `reason` clears just that flag.
export const ThreadAttentionClearedPayload = Schema.Struct({
  threadId: ThreadId,
  reason: Schema.optional(AttentionReason),
  updatedAt: IsoDateTime,
});

// Migration-only (design §9): decoded from the event store on replay and
// remapped into planLane/attention by the projector. Never emitted live.
export const ThreadStatusSetPayload = Schema.Struct({
  threadId: ThreadId,
  status: LegacyThreadStatus,
  updatedAt: IsoDateTime,
});

export const ThreadDependenciesSetPayload = Schema.Struct({
  threadId: ThreadId,
  blockedBy: Schema.Array(ThreadId),
  updatedAt: IsoDateTime,
});

export const ThreadMessageSentPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadMessageReasoningPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  turnId: Schema.NullOr(TurnId),
  // Full accumulated reasoning text for the segment. The projector REPLACES the
  // message's `reasoningText` with this value (not append) — see the v2 plan's
  // ordering contract. Persisted reasoning is always complete, so
  // `reasoningStreaming` is always false here.
  reasoningText: Schema.String,
  reasoningStreaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadTurnStartRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  modelSelection: Schema.optional(ModelSelection),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

export const ThreadTurnStartFailedPayload = Schema.Struct({
  threadId: ThreadId,
  detail: Schema.String,
  createdAt: IsoDateTime,
});

export const ThreadTurnInterruptRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

export const ThreadApprovalResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
});

const ThreadUserInputResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  createdAt: IsoDateTime,
});

export const ThreadCheckpointRevertRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

export const ThreadRevertedPayload = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
});

export const ThreadSessionStopRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

export const ThreadSessionSetPayload = Schema.Struct({
  threadId: ThreadId,
  session: OrchestrationSession,
});

export const ThreadProposedPlanUpsertedPayload = Schema.Struct({
  threadId: ThreadId,
  proposedPlan: OrchestrationProposedPlan,
});

export const ThreadTurnDiffCompletedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});

export const ThreadActivityAppendedPayload = Schema.Struct({
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
});

export const ThreadReportSetPayload = Schema.Struct({
  threadId: ThreadId,
  reportPath: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
});

// consult_thread observability: one resolved consult recorded on the asker
// thread. `answer` is the FULL answer (no truncation/pointer scheme).
// `forkSessionPath` is present when the read-only fork's jsonl was retained to
// userdata for deep inspection; absent when retention failed (best-effort).
export const ThreadConsultRecordedPayload = Schema.Struct({
  askerThreadId: ThreadId,
  targetThreadId: ThreadId,
  targetTitle: Schema.String,
  question: Schema.String,
  answer: Schema.String,
  resolved: Schema.Boolean,
  durationMs: NonNegativeInt,
  forkSessionPath: Schema.optional(Schema.String),
  createdAt: IsoDateTime,
});

// Review gates (design §3.2): one record per submit — the outcome token, the
// routing verdict the decider reached, and the loop round it applies to.
export const ThreadOutcomeRecordedPayload = Schema.Struct({
  threadId: ThreadId,
  outcome: TrimmedNonEmptyString,
  decision: WorkOutcomeDecision,
  round: NonNegativeInt,
  contested: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  counts: Schema.optional(WorkOutcomeCounts),
  updatedAt: IsoDateTime,
});

// Review gates (design §4.3): a control-plane loop traversal from `threadId`
// (the routing source) to `to`. The dispatcher's gate pass reacts to it;
// `gateRounds`/`pendingRework` are projected from it (Phase 3).
export const ThreadRouteTakenPayload = Schema.Struct({
  threadId: ThreadId,
  to: ThreadId,
  round: NonNegativeInt,
  updatedAt: IsoDateTime,
});

// Worktree isolation (design §3): the projected fan-in settlement for an
// isolated child. The projector sets `fanInState` from this.
export const ThreadFanInSetPayload = Schema.Struct({
  threadId: ThreadId,
  fanInState: ThreadFanInState,
  updatedAt: IsoDateTime,
});

export const OrchestrationEventMetadata = Schema.Struct({
  providerTurnId: Schema.optional(TrimmedNonEmptyString),
  providerItemId: Schema.optional(ProviderItemId),
  adapterKey: Schema.optional(TrimmedNonEmptyString),
  requestId: Schema.optional(ApprovalRequestId),
  ingestedAt: Schema.optional(IsoDateTime),
});
export type OrchestrationEventMetadata = typeof OrchestrationEventMetadata.Type;

const EventBaseFields = {
  sequence: NonNegativeInt,
  eventId: EventId,
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: Schema.Union([ProjectId, GoalId, ThreadId]),
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  metadata: OrchestrationEventMetadata,
} as const;

export const OrchestrationEvent = Schema.Union([
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.created"),
    payload: ProjectCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.meta-updated"),
    payload: ProjectMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.deleted"),
    payload: ProjectDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("goal.created"),
    payload: GoalCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("goal.meta-updated"),
    payload: GoalMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("goal.archived"),
    payload: GoalArchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("goal.unarchived"),
    payload: GoalUnarchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("goal.deleted"),
    payload: GoalDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("goal.task-created"),
    payload: GoalTaskCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("goal.task-updated"),
    payload: GoalTaskUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("goal.task-deleted"),
    payload: GoalTaskDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.created"),
    payload: ThreadCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.deleted"),
    payload: ThreadDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.archived"),
    payload: ThreadArchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unarchived"),
    payload: ThreadUnarchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.meta-updated"),
    payload: ThreadMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.runtime-mode-set"),
    payload: ThreadRuntimeModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.interaction-mode-set"),
    payload: ThreadInteractionModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.plan-lane-set"),
    payload: ThreadPlanLaneSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.attention-raised"),
    payload: ThreadAttentionRaisedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.attention-cleared"),
    payload: ThreadAttentionClearedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.status-set"),
    payload: ThreadStatusSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.dependencies-set"),
    payload: ThreadDependenciesSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.message-sent"),
    payload: ThreadMessageSentPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.message-reasoning"),
    payload: ThreadMessageReasoningPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-start-requested"),
    payload: ThreadTurnStartRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-start-failed"),
    payload: ThreadTurnStartFailedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-interrupt-requested"),
    payload: ThreadTurnInterruptRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.approval-response-requested"),
    payload: ThreadApprovalResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.user-input-response-requested"),
    payload: ThreadUserInputResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.checkpoint-revert-requested"),
    payload: ThreadCheckpointRevertRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.reverted"),
    payload: ThreadRevertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-stop-requested"),
    payload: ThreadSessionStopRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-set"),
    payload: ThreadSessionSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.proposed-plan-upserted"),
    payload: ThreadProposedPlanUpsertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-diff-completed"),
    payload: ThreadTurnDiffCompletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.activity-appended"),
    payload: ThreadActivityAppendedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.consult-recorded"),
    payload: ThreadConsultRecordedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.report-set"),
    payload: ThreadReportSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.outcome-recorded"),
    payload: ThreadOutcomeRecordedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.route-taken"),
    payload: ThreadRouteTakenPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.fanin-set"),
    payload: ThreadFanInSetPayload,
  }),
]);
export type OrchestrationEvent = typeof OrchestrationEvent.Type;

// Transient reasoning stream item (the ephemeral channel). These never hit the
// event store; they drive live "Thinking… ⟷ Thought for Xs" display only. The
// durable `thread.message-reasoning` event (REPLACE full text) is the source of
// truth on reload.
export const ReasoningStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("delta"),
    threadId: ThreadId,
    messageId: MessageId,
    turnId: Schema.NullOr(TurnId),
    text: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("complete"),
    threadId: ThreadId,
    messageId: MessageId,
    reasoningCompletedAt: IsoDateTime,
  }),
]);
export type ReasoningStreamItem = typeof ReasoningStreamItem.Type;

export const OrchestrationThreadStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: OrchestrationThreadDetailSnapshot,
  }),
  Schema.Struct({
    kind: Schema.Literal("event"),
    event: OrchestrationEvent,
  }),
  Schema.Struct({
    kind: Schema.Literal("reasoning-delta"),
    payload: ReasoningStreamItem,
  }),
]);
export type OrchestrationThreadStreamItem = typeof OrchestrationThreadStreamItem.Type;

export const OrchestrationCommandReceiptStatus = Schema.Literals(["accepted", "rejected"]);
export type OrchestrationCommandReceiptStatus = typeof OrchestrationCommandReceiptStatus.Type;

export const TurnCountRange = Schema.Struct({
  fromTurnCount: NonNegativeInt,
  toTurnCount: NonNegativeInt,
}).check(
  Schema.makeFilter(
    (input) =>
      input.fromTurnCount <= input.toTurnCount ||
      new SchemaIssue.InvalidValue(Option.some(input.fromTurnCount), {
        message: "fromTurnCount must be less than or equal to toTurnCount",
      }),
    { identifier: "OrchestrationTurnDiffRange" },
  ),
);

export const ThreadTurnDiff = TurnCountRange.mapFields(
  Struct.assign({
    threadId: ThreadId,
    diff: Schema.String,
  }),
  { unsafePreserveChecks: true },
);

export const ProviderSessionRuntimeStatus = Schema.Literals([
  "starting",
  "running",
  "stopped",
  "error",
]);
export type ProviderSessionRuntimeStatus = typeof ProviderSessionRuntimeStatus.Type;

const ProjectionThreadTurnStatus = Schema.Literals([
  "running",
  "completed",
  "interrupted",
  "error",
]);
export type ProjectionThreadTurnStatus = typeof ProjectionThreadTurnStatus.Type;

const ProjectionCheckpointRow = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type ProjectionCheckpointRow = typeof ProjectionCheckpointRow.Type;

export const ProjectionPendingApprovalStatus = Schema.Literals(["pending", "resolved"]);
export type ProjectionPendingApprovalStatus = typeof ProjectionPendingApprovalStatus.Type;

export const ProjectionPendingApprovalDecision = Schema.NullOr(ProviderApprovalDecision);
export type ProjectionPendingApprovalDecision = typeof ProjectionPendingApprovalDecision.Type;

export const DispatchResult = Schema.Struct({
  sequence: NonNegativeInt,
});
export type DispatchResult = typeof DispatchResult.Type;

export const OrchestrationGetTurnDiffInput = TurnCountRange.mapFields(
  Struct.assign({
    threadId: ThreadId,
    ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
  }),
  { unsafePreserveChecks: true },
);
export type OrchestrationGetTurnDiffInput = typeof OrchestrationGetTurnDiffInput.Type;

export const OrchestrationGetTurnDiffResult = ThreadTurnDiff;
export type OrchestrationGetTurnDiffResult = typeof OrchestrationGetTurnDiffResult.Type;

export const OrchestrationGetFullThreadDiffInput = Schema.Struct({
  threadId: ThreadId,
  toTurnCount: NonNegativeInt,
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
});
export type OrchestrationGetFullThreadDiffInput = typeof OrchestrationGetFullThreadDiffInput.Type;

export const OrchestrationGetFullThreadDiffResult = ThreadTurnDiff;
export type OrchestrationGetFullThreadDiffResult = typeof OrchestrationGetFullThreadDiffResult.Type;

export const OrchestrationReplayEventsInput = Schema.Struct({
  fromSequenceExclusive: NonNegativeInt,
});
export type OrchestrationReplayEventsInput = typeof OrchestrationReplayEventsInput.Type;

const OrchestrationReplayEventsResult = Schema.Array(OrchestrationEvent);
export type OrchestrationReplayEventsResult = typeof OrchestrationReplayEventsResult.Type;

export const OrchestrationRpcSchemas = {
  dispatchCommand: {
    input: ClientOrchestrationCommand,
    output: DispatchResult,
  },
  getTurnDiff: {
    input: OrchestrationGetTurnDiffInput,
    output: OrchestrationGetTurnDiffResult,
  },
  getFullThreadDiff: {
    input: OrchestrationGetFullThreadDiffInput,
    output: OrchestrationGetFullThreadDiffResult,
  },
  replayEvents: {
    input: OrchestrationReplayEventsInput,
    output: OrchestrationReplayEventsResult,
  },
  getArchivedShellSnapshot: {
    input: Schema.Struct({}),
    output: OrchestrationShellSnapshot,
  },
  subscribeThread: {
    input: OrchestrationSubscribeThreadInput,
    output: OrchestrationThreadStreamItem,
  },
  subscribeShell: {
    input: Schema.Struct({}),
    output: OrchestrationShellStreamItem,
  },
} as const;

export class OrchestrationGetSnapshotError extends Schema.TaggedErrorClass<OrchestrationGetSnapshotError>()(
  "OrchestrationGetSnapshotError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationDispatchCommandError extends Schema.TaggedErrorClass<OrchestrationDispatchCommandError>()(
  "OrchestrationDispatchCommandError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationGetTurnDiffError extends Schema.TaggedErrorClass<OrchestrationGetTurnDiffError>()(
  "OrchestrationGetTurnDiffError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationGetFullThreadDiffError extends Schema.TaggedErrorClass<OrchestrationGetFullThreadDiffError>()(
  "OrchestrationGetFullThreadDiffError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationReplayEventsError extends Schema.TaggedErrorClass<OrchestrationReplayEventsError>()(
  "OrchestrationReplayEventsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
