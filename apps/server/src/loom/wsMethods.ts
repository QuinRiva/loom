/**
 * Loom's WebSocket RPC handlers (Pull 9 Phase 3, seam 21), spliced into
 * `ws.ts`'s RPC group by ONE marked line (`...(yield* makeLoomWsHandlers)`);
 * the Rpc members are `packages/contracts/src/rpc.loom.ts`, the scopes a marked
 * block in `auth/RpcAuthorization.ts`.
 *
 * Seam 21 (integrated): 3b's drafter methods, 3d's goal methods (each writes
 * `LoomStoreV2` and publishes the goal on `LoomGoalBroadcast`, DL-219) and
 * seam 11's two spend reads over 3c's `LoomUsageLedger` (DL-432/433/438), and
 * the timeline's outcome history (DL-620).
 *
 * @module loom/wsMethods
 */
import {
  type GoalId,
  GoalTaskId,
  type HandoffDraftInput,
  LOOM_WS_METHODS,
  type LoomGoal,
  type LoomGoalTask,
  type LoomGoalTaskRewriteInput,
  type LoomGoalTaskRewriteNode,
  type LoomGoalUpdateInput,
  type LoomThreadHistoryInput,
  type LoomThreadSpendInput,
  type LoomTopSpendInput,
  LoomWsMethodError,
  type RetroDraftInput,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Struct from "effect/Struct";

import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import { LoomUsageLedger } from "./economics/LoomUsageLedger.ts";
import { buildHandoffDraftTurnStart, launchDraftFork } from "./handoff/handoffDraft.ts";
import { buildRetroDraftTurnStart } from "./handoff/retroDraft.ts";
import { goalShellItem, LoomGoalBroadcast } from "./projection/LoomGoalBroadcast.ts";
import {
  type LoomGoalTaskInput,
  type LoomStoreError,
  LoomStoreV2,
} from "./projection/LoomStore.ts";

const toRewriteNode = (task: LoomGoalTask): LoomGoalTaskRewriteNode => ({
  id: task.id,
  text: task.text,
  done: task.done,
  children: task.children.map(toRewriteNode),
});

interface TaskNode {
  readonly id?: string | undefined;
  readonly children: ReadonlyArray<TaskNode>;
}

const collectIds = (nodes: ReadonlyArray<TaskNode>): string[] =>
  nodes.flatMap((node) => [
    ...(node.id === undefined ? [] : [node.id]),
    ...collectIds(node.children),
  ]);

/**
 * The full submitted tree: the submission itself, or (for a branch) the current
 * tree with the branch node replaced by the single submitted root. Returns an
 * error message when the submission is not a legal rewrite of `goal`.
 */
export const resolveTaskRewrite = (
  goal: Pick<LoomGoal, "tasks">,
  input: Pick<LoomGoalTaskRewriteInput, "branchTaskId" | "tasks">,
): ReadonlyArray<LoomGoalTaskRewriteNode> | string => {
  const known = new Set(collectIds(goal.tasks));
  const submittedIds = collectIds(input.tasks);
  const unknown = submittedIds.find((id) => !known.has(id));
  if (unknown !== undefined) return `Task ${unknown} is not a task in this goal.`;
  let tree: ReadonlyArray<LoomGoalTaskRewriteNode> = input.tasks;
  if (input.branchTaskId !== null) {
    const branchId = input.branchTaskId;
    if (!known.has(branchId)) return `Branch ${branchId} is not a task in this goal.`;
    if (input.tasks.length !== 1 || input.tasks[0]!.id !== branchId) {
      return `A branch rewrite submits exactly one root task, the branch ${branchId}.`;
    }
    const splice = (nodes: ReadonlyArray<LoomGoalTask>): LoomGoalTaskRewriteNode[] =>
      nodes.map((node) =>
        node.id === branchId
          ? input.tasks[0]!
          : { ...toRewriteNode(node), children: splice(node.children) },
      );
    tree = splice(goal.tasks);
  }
  const ids = collectIds(tree);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  return duplicate === undefined ? tree : `Task ${duplicate} appears more than once.`;
};

const flattenTree = (
  nodes: ReadonlyArray<LoomGoalTaskRewriteNode>,
  parentTaskId: GoalTaskId | null,
  mint: () => GoalTaskId,
): LoomGoalTaskInput[] =>
  nodes.flatMap((node, position) => {
    const id = node.id ?? mint();
    return [
      { id, parentTaskId, text: node.text, done: node.done, position },
      ...flattenTree(node.children, id, mint),
    ];
  });

export const makeLoomWsHandlers = Effect.gen(function* () {
  const loomStore = yield* LoomStoreV2;
  const broadcast = yield* LoomGoalBroadcast;
  const crypto = yield* Crypto.Crypto;
  const usageLedger = yield* LoomUsageLedger;
  const draftServices = yield* Effect.context<OrchestratorV2 | LoomStoreV2 | Crypto.Crypto>();

  const fail = (method: string, message: string, cause?: unknown) =>
    new LoomWsMethodError({ method, message, ...(cause === undefined ? {} : { cause }) });

  /** Load the live goal, apply `write`, publish the result, answer it. */
  const goalWrite = (
    method: string,
    goalId: GoalId,
    write: (goal: LoomGoal) => Effect.Effect<unknown, LoomStoreError | LoomWsMethodError>,
  ) =>
    observeRpcEffect(
      method,
      Effect.gen(function* () {
        const current = yield* loomStore.goals.get(goalId);
        if (current === null || current.deletedAt !== null) {
          return yield* fail(method, `Goal ${goalId} was not found.`);
        }
        yield* write(current);
        const goal = (yield* loomStore.goals.get(goalId))!;
        yield* broadcast.publish(goalShellItem(goal));
        return { goal: Struct.omit(goal, ["deletedAt"]) };
      }).pipe(
        Effect.catchTags({
          LoomStoreError: (cause) => Effect.fail(fail(method, `${method} failed.`, cause)),
        }),
      ),
      { "rpc.aggregate": "loom" },
    );

  return {
    [LOOM_WS_METHODS.goalUpdate]: (input: LoomGoalUpdateInput) =>
      goalWrite(LOOM_WS_METHODS.goalUpdate, input.goalId, (goal) =>
        input.title === undefined && input.description === undefined && input.slug === undefined
          ? Effect.fail(
              fail(
                LOOM_WS_METHODS.goalUpdate,
                "Provide at least one of title, description or slug.",
              ),
            )
          : loomStore.goals.upsert({
              id: goal.id,
              projectId: goal.projectId,
              slug: input.slug ?? goal.slug,
              title: input.title ?? goal.title,
              description: input.description ?? goal.description,
            }),
      ),
    [LOOM_WS_METHODS.goalArchive]: (input: { readonly goalId: GoalId }) =>
      goalWrite(LOOM_WS_METHODS.goalArchive, input.goalId, (goal) =>
        loomStore.goals.archive(goal.id),
      ),
    [LOOM_WS_METHODS.goalUnarchive]: (input: { readonly goalId: GoalId }) =>
      goalWrite(LOOM_WS_METHODS.goalUnarchive, input.goalId, (goal) =>
        loomStore.goals.unarchive(goal.id),
      ),
    [LOOM_WS_METHODS.goalTaskRewrite]: (input: LoomGoalTaskRewriteInput) =>
      goalWrite(LOOM_WS_METHODS.goalTaskRewrite, input.goalId, (goal) =>
        Effect.gen(function* () {
          const tree = resolveTaskRewrite(goal, input);
          if (typeof tree === "string") return yield* fail(LOOM_WS_METHODS.goalTaskRewrite, tree);
          const fresh = (yield* Effect.forEach(idlessNodes(tree), () =>
            crypto.randomUUIDv4.pipe(Effect.orDie),
          ))[Symbol.iterator]();
          return yield* loomStore.tasks.replaceTree(
            goal.id,
            flattenTree(tree, null, () => GoalTaskId.make(fresh.next().value!)),
          );
        }),
      ),
    // `/handoff`: a hidden `handoff-drafter` fork of the source, kicked off on the explanation.
    [LOOM_WS_METHODS.handoffDraft]: (input: HandoffDraftInput) =>
      observeRpcEffect(
        LOOM_WS_METHODS.handoffDraft,
        launchDraftFork({
          method: LOOM_WS_METHODS.handoffDraft,
          verb: "handed off",
          sourceThreadId: input.sourceThreadId,
          build: (fork) => buildHandoffDraftTurnStart({ ...fork, explanation: input.explanation }),
        }).pipe(
          Effect.map((drafterThreadId) => ({ drafterThreadId })),
          Effect.provideContext(draftServices),
        ),
        { "rpc.aggregate": "loom" },
      ),
    // `/retro`: a visible `retro-reviewer` fork of the source, kicked off on the retro brief.
    [LOOM_WS_METHODS.retroDraft]: (input: RetroDraftInput) =>
      observeRpcEffect(
        LOOM_WS_METHODS.retroDraft,
        launchDraftFork({
          method: LOOM_WS_METHODS.retroDraft,
          verb: "reviewed",
          sourceThreadId: input.sourceThreadId,
          build: (fork, source) =>
            buildRetroDraftTurnStart({ ...fork, sourceTitle: source.title, focus: input.focus }),
        }).pipe(
          Effect.map((reviewerThreadId) => ({ reviewerThreadId })),
          Effect.provideContext(draftServices),
        ),
        { "rpc.aggregate": "loom" },
      ),
    // 3d-4 — seam 11's spend reads.
    [LOOM_WS_METHODS.threadSpend]: (input: LoomThreadSpendInput) =>
      observeRpcEffect(
        LOOM_WS_METHODS.threadSpend,
        usageLedger
          .threadSpend(input.threadIds)
          .pipe(Effect.map((spend) => ({ spend: Object.fromEntries(spend) }))),
        { "rpc.aggregate": "loom" },
      ),
    [LOOM_WS_METHODS.topSpend]: (input: LoomTopSpendInput) =>
      observeRpcEffect(
        LOOM_WS_METHODS.topSpend,
        usageLedger.topSpend(input.limit, input.since).pipe(Effect.map((threads) => ({ threads }))),
        { "rpc.aggregate": "loom" },
      ),
    // The node timeline's event history (outcomes with their reports, flags, routes).
    [LOOM_WS_METHODS.threadHistory]: (input: LoomThreadHistoryInput) =>
      observeRpcEffect(
        LOOM_WS_METHODS.threadHistory,
        loomStore.history(input.threadId).pipe(
          Effect.map((entries) => ({ entries })),
          Effect.mapError((cause) =>
            fail(LOOM_WS_METHODS.threadHistory, `${LOOM_WS_METHODS.threadHistory} failed.`, cause),
          ),
        ),
        { "rpc.aggregate": "loom" },
      ),
  };
});

/** The nodes that need a minted id (one UUID each). */
const idlessNodes = (nodes: ReadonlyArray<TaskNode>): ReadonlyArray<TaskNode> =>
  nodes.flatMap((node) => [
    ...(node.id === undefined ? [node] : []),
    ...idlessNodes(node.children),
  ]);
