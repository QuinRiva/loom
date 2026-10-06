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
  GoalId,
  GoalTaskId,
  IsoDateTime,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { LoomGoalShell, WorkOutcomeRecord } from "./orchestrationV2.loom.ts";
import {
  HandoffDraftInput,
  HandoffDraftResult,
  RetroDraftInput,
  RetroDraftResult,
} from "./server.ts";

export const LOOM_WS_METHODS = {
  goalUpdate: "loom.goal.update",
  goalArchive: "loom.goal.archive",
  goalUnarchive: "loom.goal.unarchive",
  goalTaskRewrite: "loom.goal.task.rewrite",
  // 3b — the drafters.
  handoffDraft: "loom.handoffDraft",
  retroDraft: "loom.retroDraft",
  // 3d-4 — seam 11's spend reads (DL-438).
  threadSpend: "loom.threadSpend",
  topSpend: "loom.topSpend",
  // QA fix — the timeline's per-round report links (V1's lifecycle pull, outcomes only).
  threadOutcomes: "loom.threadOutcomes",
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

export const LoomGoalRefInput = Schema.Struct({ goalId: GoalId });
export type LoomGoalRefInput = typeof LoomGoalRefInput.Type;

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

/** `loom.threadSpend`: lifetime spend for a batch of threads (the board's and chips' lookup). */
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

/** `loom.threadOutcomes`: every outcome a thread submitted, oldest first. */
export const LoomThreadOutcomesInput = Schema.Struct({ threadId: ThreadId });
export type LoomThreadOutcomesInput = typeof LoomThreadOutcomesInput.Type;

export const LoomThreadOutcomesResult = Schema.Struct({
  outcomes: Schema.Array(LoomThreadOutcome),
});
export type LoomThreadOutcomesResult = typeof LoomThreadOutcomesResult.Type;

const goalRpc = <Tag extends string, Payload extends Schema.Top>(tag: Tag, payload: Payload) =>
  Rpc.make(tag, { payload, success: LoomGoalWriteResult, error: LoomWsError });

/** The members `rpc.ts` spreads into `WsRpcGroup`. */
export const LoomWsRpcs = [
  goalRpc(LOOM_WS_METHODS.goalUpdate, LoomGoalUpdateInput),
  goalRpc(LOOM_WS_METHODS.goalArchive, LoomGoalRefInput),
  goalRpc(LOOM_WS_METHODS.goalUnarchive, LoomGoalRefInput),
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
  Rpc.make(LOOM_WS_METHODS.threadOutcomes, {
    payload: LoomThreadOutcomesInput,
    success: LoomThreadOutcomesResult,
    error: LoomWsError,
  }),
] as const;
