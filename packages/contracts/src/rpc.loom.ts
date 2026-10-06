// Loom's WebSocket RPCs (Pull 9 Phase 3, seam 21), spliced into `WsRpcGroup`
// by ONE marked line in `rpc.ts`; the handlers are `apps/server/src/loom/wsMethods.ts`
// and the scopes a marked block in `auth/RpcAuthorization.ts`.
//
// STUB FILE — 3b is seam 21's first lander. Track 3b's `loom.handoffDraft` /
// `loom.retroDraft` merge in at integration: the two members below carry the
// contract shapes (`HandoffDraft*` / `RetroDraft*` in `server.ts`) so the web
// intercepts (3d-3) compile and reach the server today; their handlers in
// `wsMethods.ts` are stubs that fail naming the method (DL-433). Integration
// keeps 3b's definitions and deletes these. Everything else here is 3d's —
// including seam 11's two spend reads (3d-4), served by 3c's `LoomUsageLedger`
// (a fixture layer until integration, DL-438).
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
import { LoomGoalShell } from "./orchestrationV2.loom.ts";
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
  // 3b (stubbed until integration, see header).
  handoffDraft: "loom.handoffDraft",
  retroDraft: "loom.retroDraft",
  // 3d-4 — seam 11's spend reads (DL-438).
  threadSpend: "loom.threadSpend",
  topSpend: "loom.topSpend",
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
 * replace, as `goal_tasks_rewrite`). `branchTaskId` null = the whole tree;
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

const goalRpc = <Tag extends string, Payload extends Schema.Top>(tag: Tag, payload: Payload) =>
  Rpc.make(tag, { payload, success: LoomGoalWriteResult, error: LoomWsError });

/** The members `rpc.ts` spreads into `WsRpcGroup`. */
export const LoomWsRpcs = [
  goalRpc(LOOM_WS_METHODS.goalUpdate, LoomGoalUpdateInput),
  goalRpc(LOOM_WS_METHODS.goalArchive, LoomGoalRefInput),
  goalRpc(LOOM_WS_METHODS.goalUnarchive, LoomGoalRefInput),
  goalRpc(LOOM_WS_METHODS.goalTaskRewrite, LoomGoalTaskRewriteInput),
  // 3b's, stubbed (see header).
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
] as const;
