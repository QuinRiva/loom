// Loom's WebSocket RPCs (Pull 9 Phase 3, seam 21), spliced into `WsRpcGroup`
// by ONE marked line in `rpc.ts`; the handlers are `apps/server/src/loom/wsMethods.ts`
// and the scopes a marked block in `auth/RpcAuthorization.ts`.
//
// Seam 21 (integrated): 3b's drafter methods (`loom.handoffDraft` / `loom.retroDraft`,
// typed by `HandoffDraft*` / `RetroDraft*` in `server.ts`), 3d's goal methods and
// seam 11's two spend reads served by 3c's `LoomUsageLedger` (DL-432/433/438).
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  EventId,
  GoalId,
  GoalTaskId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  LoomGoalShell,
  LoomOutcome,
  LoomRouteKind,
  WorkOutcomeRecord,
} from "./orchestrationV2.loom.ts";
import { OrchestrationV2ThreadShell } from "./orchestrationV2.ts";
import {
  UsageLimitSourceError,
  UsageLimitSourceLoginFinishInput,
  UsageLimitSourceLoginFinishResult,
  UsageLimitSourceLoginStartInput,
  UsageLimitSourceLoginStartResult,
} from "./providerUsageLimits.ts";
import { ReviewDiffFileContentsInput, ReviewDiffFileContentsResult } from "./review.ts";
import {
  DocumentQueryAuthorInput,
  DocumentQueryAuthorResult,
  DocumentQueryInput,
  DocumentQueryPromoteInput,
  DocumentQueryPromoteResult,
  DocumentQueryResult,
  HandoffDraftInput,
  HandoffDraftResult,
  RetroDraftInput,
  RetroDraftResult,
} from "./server.ts";

export const LOOM_WS_METHODS = {
  goalUpdate: "loom.goal.update",
  goalTaskRewrite: "loom.goal.task.rewrite",
  // 3b — the drafters.
  handoffDraft: "loom.handoffDraft",
  retroDraft: "loom.retroDraft",
  // Query threads: ask the document's author's read-only fork; promote an exchange to it.
  documentQuery: "loom.documentQuery",
  documentQueryAuthor: "loom.documentQueryAuthor",
  documentQueryPromote: "loom.documentQueryPromote",
  // 3d-4 — seam 11's spend reads (DL-438).
  threadSpend: "loom.threadSpend",
  topSpend: "loom.topSpend",
  // QA fixes — the node timeline's event history (V1's lifecycle pull).
  threadHistory: "loom.threadHistory",
  // The consult card's Stop: ends one running consult, never the asker's turn.
  consultCancel: "loom.consult.cancel",
  // The workstream surface's Prompt button: where a thread's captured system prompt is.
  promptCapture: "loom.promptCapture",
  // Thread search: the shell of a thread the shell stream does not carry (an archived root).
  threadShell: "loom.threadShell",
  // The hub login reminder's Log in… dialog: cliproxy's OAuth flow, run by the server.
  usageLimitSourceLoginStart: "usageLimitSource.login.start",
  usageLimitSourceLoginFinish: "usageLimitSource.login.finish",
  // Change review (plans/change-review/plan.mdx §5): the snapshot intervals of a thread.
  reviewIntervals: "loom.review.intervals",
  reviewDiff: "loom.review.diff",
  reviewFileContents: "loom.review.fileContents",
} as const;

/** Every Loom ws method fails with this (plus the group's authorization error). */
export class LoomWsMethodError extends Schema.TaggedError<LoomWsMethodError>()(
  "LoomWsMethodError",
  {
    method: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const LoomWsError = Schema.Union([LoomWsMethodError, EnvironmentAuthorizationError]);

/** Every goal write answers with the goal as it now stands (also published on the goal stream). */
export const LoomGoalWriteResult = Schema.Struct({ goal: LoomGoalShell });
export type LoomGoalWriteResult = typeof LoomGoalWriteResult.Type;

/** `loom.goal.update`: at least one field; an empty `description` clears it. */
export const LoomGoalUpdateInput = Schema.Struct({
  goalId: GoalId,
  title: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(Schema.String),
  slug: Schema.optional(TrimmedNonEmptyString),
});
export type LoomGoalUpdateInput = typeof LoomGoalUpdateInput.Type;

/** One submitted task: an existing `id` keeps its identity; a missing one is minted. */
export interface LoomGoalTaskRewriteNode {
  readonly id?: GoalTaskId | undefined;
  readonly text: string;
  readonly done: boolean;
  readonly children: ReadonlyArray<LoomGoalTaskRewriteNode>;
}
interface LoomGoalTaskRewriteNodeEncoded {
  readonly id?: string | undefined;
  readonly text: string;
  readonly done: boolean;
  readonly children: ReadonlyArray<LoomGoalTaskRewriteNodeEncoded>;
}
export const LoomGoalTaskRewriteNode: Schema.Codec<
  LoomGoalTaskRewriteNode,
  LoomGoalTaskRewriteNodeEncoded
> = Schema.Struct({
  id: Schema.optional(GoalTaskId),
  text: TrimmedNonEmptyString,
  done: Schema.Boolean,
  children: Schema.Array(
    Schema.suspend(
      (): Schema.Codec<LoomGoalTaskRewriteNode, LoomGoalTaskRewriteNodeEncoded> =>
        LoomGoalTaskRewriteNode,
    ),
  ),
});

/**
 * `loom.goal.task.rewrite`: the submitted tree IS the result (declarative
 * replace, as `mcp__t3-code__goal_tasks_rewrite`). `branchTaskId` null = the whole tree;
 * set = an anchored branch: `tasks` is exactly one root carrying that id,
 * spliced in place of the branch, the rest of the tree untouched.
 */
export const LoomGoalTaskRewriteInput = Schema.Struct({
  goalId: GoalId,
  branchTaskId: Schema.NullOr(GoalTaskId),
  tasks: Schema.Array(LoomGoalTaskRewriteNode),
});
export type LoomGoalTaskRewriteInput = typeof LoomGoalTaskRewriteInput.Type;

/** One thread's spend from the usage ledger (seam 11; `cachedTokens` = cache read + write). */
export const LoomThreadSpend = Schema.Struct({
  costUsd: Schema.Number,
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cachedTokens: Schema.Number,
});
export type LoomThreadSpend = typeof LoomThreadSpend.Type;

/** `loom.threadSpend`: lifetime spend for a batch of threads (the workstream surface's and chips' lookup). */
export const LoomThreadSpendInput = Schema.Struct({
  threadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(200)),
});
export type LoomThreadSpendInput = typeof LoomThreadSpendInput.Type;

/** A thread with no ledger rows is absent from `spend`. */
export const LoomThreadSpendResult = Schema.Struct({
  spend: Schema.Record(ThreadId, LoomThreadSpend),
});
export type LoomThreadSpendResult = typeof LoomThreadSpendResult.Type;

/** `loom.topSpend`: the `limit` costliest threads since `since`, most expensive first. */
export const LoomTopSpendInput = Schema.Struct({
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(100)),
  since: IsoDateTime,
});
export type LoomTopSpendInput = typeof LoomTopSpendInput.Type;

export const LoomTopSpendRow = Schema.Struct({ threadId: ThreadId, ...LoomThreadSpend.fields });
export type LoomTopSpendRow = typeof LoomTopSpendRow.Type;

export const LoomTopSpendResult = Schema.Struct({ threads: Schema.Array(LoomTopSpendRow) });
export type LoomTopSpendResult = typeof LoomTopSpendResult.Type;

/**
 * One submitted outcome and the report that submit wrote (each `thread.report-set`
 * immediately precedes its `thread.outcome-recorded`); `reportPath` is null when
 * the submit set none.
 */
export const LoomThreadOutcome = Schema.Struct({
  ...WorkOutcomeRecord.fields,
  reportPath: Schema.NullOr(TrimmedNonEmptyString),
});
export type LoomThreadOutcome = typeof LoomThreadOutcome.Type;

const historyEvent = { eventId: EventId, at: IsoDateTime } as const;

/**
 * One entry of a thread's event history: each submitted outcome, flag raised
 * and cleared (a yield is the `awaiting_orchestrator` flag, its resume the
 * clear), gate route taken or rework round accepted, and plan outcome set or
 * cleared. Reasons stay strings: V1-imported events carry V1's reasons.
 */
export const LoomThreadHistoryEntry = Schema.Union([
  Schema.Struct({ type: Schema.Literal("outcome"), ...LoomThreadOutcome.fields }),
  Schema.Struct({
    type: Schema.Literal("attention-raised"),
    ...historyEvent,
    reason: TrimmedNonEmptyString,
  }),
  /** A null `reason` cleared every flag. */
  Schema.Struct({
    type: Schema.Literal("attention-cleared"),
    ...historyEvent,
    reason: Schema.NullOr(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("route-taken"),
    ...historyEvent,
    to: ThreadId,
    round: NonNegativeInt,
    kind: LoomRouteKind,
  }),
  Schema.Struct({
    type: Schema.Literal("rework-accepted"),
    ...historyEvent,
    sourceThreadId: ThreadId,
    round: NonNegativeInt,
  }),
  /** A null `outcome` reopened the thread. */
  Schema.Struct({
    type: Schema.Literal("outcome-set"),
    ...historyEvent,
    outcome: Schema.NullOr(LoomOutcome),
  }),
]);
export type LoomThreadHistoryEntry = typeof LoomThreadHistoryEntry.Type;

/** `loom.threadHistory`: a thread's event history, oldest first. */
export const LoomThreadHistoryInput = Schema.Struct({ threadId: ThreadId });
export type LoomThreadHistoryInput = typeof LoomThreadHistoryInput.Type;

export const LoomThreadHistoryResult = Schema.Struct({
  entries: Schema.Array(LoomThreadHistoryEntry),
});
export type LoomThreadHistoryResult = typeof LoomThreadHistoryResult.Type;

/** `loom.consult.cancel`: `stopped` is false when the consult had already ended. */
export const LoomConsultCancelInput = Schema.Struct({ consultId: Schema.String });
export type LoomConsultCancelInput = typeof LoomConsultCancelInput.Type;
export const LoomConsultCancelResult = Schema.Struct({ stopped: Schema.Boolean });
export type LoomConsultCancelResult = typeof LoomConsultCancelResult.Type;

/**
 * `loom.promptCapture`: the absolute paths of a thread's captured system prompt
 * (`latest`, rewritten at every agent start; `first`, the kickoff). Each is null
 * while no such capture exists. Asked on demand, never carried on the shell.
 */
export const LoomPromptCaptureInput = Schema.Struct({ threadId: ThreadId });
export type LoomPromptCaptureInput = typeof LoomPromptCaptureInput.Type;
export const LoomPromptCaptureResult = Schema.Struct({
  latest: Schema.NullOr(Schema.String),
  first: Schema.NullOr(Schema.String),
});
export type LoomPromptCaptureResult = typeof LoomPromptCaptureResult.Type;

/**
 * `loom.threadShell`: one thread's shell, archived included, or null when it
 * does not exist. The shell stream drops archived threads, so a client opening
 * an archived root from thread search asks for its shell here.
 */
export const LoomThreadShellInput = Schema.Struct({ threadId: ThreadId });
export type LoomThreadShellInput = typeof LoomThreadShellInput.Type;
export const LoomThreadShellResult = Schema.Struct({
  thread: Schema.NullOr(OrchestrationV2ThreadShell),
});
export type LoomThreadShellResult = typeof LoomThreadShellResult.Type;

/** `repo` (the worktree's own git) · `nested_repo` (a repository inside it) · `artifact_path` (a declared ignored folder). */
export const LoomReviewSourceKind = Schema.Literals(["repo", "nested_repo", "artifact_path"]);
export type LoomReviewSourceKind = typeof LoomReviewSourceKind.Type;

/** A review source of the thread's worktree; `prefix` maps its paths onto worktree-relative ones. */
export const LoomReviewSource = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: LoomReviewSourceKind,
  /** `Repo` · `workbench/` · `.artifacts/` */
  title: TrimmedNonEmptyString,
  /** Worktree-relative root with a trailing `/` (a nested repo), else empty. */
  prefix: Schema.String,
});
export type LoomReviewSource = typeof LoomReviewSource.Type;

/** Files a closed interval changed per source kind, git imports excluded. */
export const LoomReviewChangeCounts = Schema.Struct({
  repo: NonNegativeInt,
  nested_repo: NonNegativeInt,
  artifact_path: NonNegativeInt,
});
export type LoomReviewChangeCounts = typeof LoomReviewChangeCounts.Type;

/**
 * The span between a human message's snapshot and the next one's (closed), or now (`live`).
 * `id` is the closing message id, or `"live"`; `sender` is null for the user's own message and
 * the name of a reply relayed from Slack (its `[Slack reply from <name>]` first line) otherwise.
 */
export const LoomReviewInterval = Schema.Struct({
  id: TrimmedNonEmptyString,
  from: Schema.Struct({
    messageId: MessageId,
    at: IsoDateTime,
    firstLine: Schema.String,
    sender: Schema.NullOr(Schema.String),
  }),
  to: Schema.NullOr(Schema.Struct({ messageId: MessageId, at: IsoDateTime })),
  /** Null for the live interval, which is counted only when its diff is read. */
  changedBySource: Schema.NullOr(LoomReviewChangeCounts),
});
export type LoomReviewInterval = typeof LoomReviewInterval.Type;

/** `loom.review.intervals`: newest first, the live interval leading once the thread has a snapshot. */
export const LoomReviewIntervalsInput = Schema.Struct({ threadId: ThreadId });
export type LoomReviewIntervalsInput = typeof LoomReviewIntervalsInput.Type;
export const LoomReviewIntervalsResult = Schema.Struct({
  intervals: Schema.Array(LoomReviewInterval),
  sources: Schema.Array(LoomReviewSource),
});
export type LoomReviewIntervalsResult = typeof LoomReviewIntervalsResult.Type;

export const LoomReviewFileStat = Schema.Struct({
  /** Worktree-relative (the source's prefix applied). */
  path: Schema.String,
  previousPath: Schema.NullOr(Schema.String),
  additions: Schema.Number,
  deletions: Schema.Number,
  status: Schema.Literals(["added", "modified", "deleted", "renamed"]),
  /** Blob sizes, null on the side the file is absent from; known before anything is highlighted. */
  oldBytes: Schema.NullOr(Schema.Number),
  newBytes: Schema.NullOr(Schema.Number),
});
export type LoomReviewFileStat = typeof LoomReviewFileStat.Type;

/** One source's patch over an interval, bounded like `review.getDiffPreview`'s; paths carry the prefix. */
export const LoomReviewChangeSource = Schema.Struct({
  ...LoomReviewSource.fields,
  fromCommit: TrimmedNonEmptyString,
  toCommit: TrimmedNonEmptyString,
  diff: Schema.String,
  diffHash: TrimmedNonEmptyString,
  truncated: Schema.Boolean,
  files: Schema.Array(LoomReviewFileStat),
});
export type LoomReviewChangeSource = typeof LoomReviewChangeSource.Type;

/** `loom.review.diff`: `intervalId` `"live"` captures the worktree first; `file` narrows to one path. */
export const LoomReviewDiffInput = Schema.Struct({
  threadId: ThreadId,
  intervalId: TrimmedNonEmptyString,
  sourceKinds: Schema.Array(LoomReviewSourceKind),
  ignoreWhitespace: Schema.Boolean,
  file: Schema.optionalKey(
    Schema.Struct({ path: Schema.NonEmptyString, previousPath: Schema.NullOr(Schema.String) }),
  ),
});
export type LoomReviewDiffInput = typeof LoomReviewDiffInput.Type;
export const LoomReviewDiffResult = Schema.Struct({
  generatedAt: Schema.DateTimeUtc,
  sources: Schema.Array(LoomReviewChangeSource),
});
export type LoomReviewDiffResult = typeof LoomReviewDiffResult.Type;

/**
 * `loom.review.fileContents`: both sides of one file, read from the two snapshot commits a
 * `loom.review.diff` source named, so they match the patch exactly. Paths are worktree-relative.
 */
export const LoomReviewFileContentsInput = Schema.Struct({
  threadId: ThreadId,
  sourceId: TrimmedNonEmptyString,
  fromCommit: TrimmedNonEmptyString,
  toCommit: TrimmedNonEmptyString,
  changeType: ReviewDiffFileContentsInput.fields.changeType,
  oldPath: TrimmedNonEmptyString,
  newPath: TrimmedNonEmptyString,
});
export type LoomReviewFileContentsInput = typeof LoomReviewFileContentsInput.Type;

const goalRpc = <Tag extends string, Payload extends Schema.Top>(tag: Tag, payload: Payload) =>
  Rpc.make(tag, { payload, success: LoomGoalWriteResult, error: LoomWsError });

/** The members `rpc.ts` spreads into `WsRpcGroup`. */
export const LoomWsRpcs = [
  goalRpc(LOOM_WS_METHODS.goalUpdate, LoomGoalUpdateInput),
  goalRpc(LOOM_WS_METHODS.goalTaskRewrite, LoomGoalTaskRewriteInput),
  // 3b — the drafters.
  Rpc.make(LOOM_WS_METHODS.handoffDraft, {
    payload: HandoffDraftInput,
    success: HandoffDraftResult,
    error: LoomWsError,
  }),
  Rpc.make(LOOM_WS_METHODS.retroDraft, {
    payload: RetroDraftInput,
    success: RetroDraftResult,
    error: LoomWsError,
  }),
  Rpc.make(LOOM_WS_METHODS.documentQuery, {
    payload: DocumentQueryInput,
    success: DocumentQueryResult,
    error: LoomWsError,
  }),
  Rpc.make(LOOM_WS_METHODS.documentQueryAuthor, {
    payload: DocumentQueryAuthorInput,
    success: DocumentQueryAuthorResult,
    error: LoomWsError,
  }),
  Rpc.make(LOOM_WS_METHODS.documentQueryPromote, {
    payload: DocumentQueryPromoteInput,
    success: DocumentQueryPromoteResult,
    error: LoomWsError,
  }),
  // 3d-4 — seam 11 (DL-438).
  Rpc.make(LOOM_WS_METHODS.threadSpend, {
    payload: LoomThreadSpendInput,
    success: LoomThreadSpendResult,
    error: LoomWsError,
  }),
  Rpc.make(LOOM_WS_METHODS.topSpend, {
    payload: LoomTopSpendInput,
    success: LoomTopSpendResult,
    error: LoomWsError,
  }),
  Rpc.make(LOOM_WS_METHODS.threadHistory, {
    payload: LoomThreadHistoryInput,
    success: LoomThreadHistoryResult,
    error: LoomWsError,
  }),
  Rpc.make(LOOM_WS_METHODS.consultCancel, {
    payload: LoomConsultCancelInput,
    success: LoomConsultCancelResult,
    error: LoomWsError,
  }),
  Rpc.make(LOOM_WS_METHODS.promptCapture, {
    payload: LoomPromptCaptureInput,
    success: LoomPromptCaptureResult,
    error: LoomWsError,
  }),
  Rpc.make(LOOM_WS_METHODS.threadShell, {
    payload: LoomThreadShellInput,
    success: LoomThreadShellResult,
    error: LoomWsError,
  }),
  Rpc.make(LOOM_WS_METHODS.reviewIntervals, {
    payload: LoomReviewIntervalsInput,
    success: LoomReviewIntervalsResult,
    error: LoomWsError,
  }),
  Rpc.make(LOOM_WS_METHODS.reviewDiff, {
    payload: LoomReviewDiffInput,
    success: LoomReviewDiffResult,
    error: LoomWsError,
  }),
  Rpc.make(LOOM_WS_METHODS.reviewFileContents, {
    payload: LoomReviewFileContentsInput,
    success: ReviewDiffFileContentsResult,
    error: LoomWsError,
  }),
  // The hub's own error text reaches the dialog, so these fail with the source's error.
  Rpc.make(LOOM_WS_METHODS.usageLimitSourceLoginStart, {
    payload: UsageLimitSourceLoginStartInput,
    success: UsageLimitSourceLoginStartResult,
    error: Schema.Union([UsageLimitSourceError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(LOOM_WS_METHODS.usageLimitSourceLoginFinish, {
    payload: UsageLimitSourceLoginFinishInput,
    success: UsageLimitSourceLoginFinishResult,
    error: Schema.Union([UsageLimitSourceError, EnvironmentAuthorizationError]),
  }),
] as const;
