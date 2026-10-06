/**
 * Loom's WebSocket RPC handlers (Pull 9 Phase 3, seam 21), spliced into
 * `ws.ts`'s RPC group by ONE marked line (`...(yield* makeLoomWsHandlers)`);
 * the Rpc members are `packages/contracts/src/rpc.loom.ts`, the scopes a marked
 * block in `auth/RpcAuthorization.ts`.
 *
 * STUB FILE — 3b is seam 21's first lander. Track 3b's `loom.handoffDraft` /
 * `loom.retroDraft` merge in at integration and replace the two stubs at the
 * bottom (they fail naming the method, DL-433). The goal methods are 3d's:
 * each writes `LoomStoreV2` and publishes the goal on `LoomGoalBroadcast`,
 * exactly as the goal tool handlers do (DL-219: publish when the write moved
 * the goal — every write here stamps `updatedAt`).
 *
 * @module loom/wsMethods
 */
import {
  type GoalId,
  GoalTaskId,
  LOOM_WS_METHODS,
  type LoomGoal,
  type LoomGoalTask,
  type LoomGoalTaskRewriteInput,
  type LoomGoalTaskRewriteNode,
  type LoomGoalUpdateInput,
  LoomWsMethodError,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Struct from "effect/Struct";

import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import { goalShellItem, LoomGoalBroadcast } from "./projection/LoomGoalBroadcast.ts";
import { type LoomGoalTaskInput, type LoomStoreError, LoomStoreV2 } from "./projection/LoomStore.ts";

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
  nodes.flatMap((node) => [...(node.id === undefined ? [] : [node.id]), ...collectIds(node.children)]);

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
        node.id === branchId ? input.tasks[0]! : { ...toRewriteNode(node), children: splice(node.children) },
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
        Effect.catchTag("LoomStoreError", (cause) =>
          Effect.fail(fail(method, `${method} failed.`, cause)),
        ),
      ),
      { "rpc.aggregate": "loom" },
    );

  /** 3b's drafter methods until integration (see the module header). */
  const notWired = (method: string) =>
    observeRpcEffect(
      method,
      Effect.fail(
        fail(method, `${method} is not wired on this server yet (track 3b lands the drafter).`),
      ),
    );

  return {
    [LOOM_WS_METHODS.goalUpdate]: (input: LoomGoalUpdateInput) =>
      goalWrite(LOOM_WS_METHODS.goalUpdate, input.goalId, (goal) =>
        input.title === undefined && input.description === undefined && input.slug === undefined
          ? Effect.fail(
              fail(LOOM_WS_METHODS.goalUpdate, "Provide at least one of title, description or slug."),
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
          const fresh = (yield* Effect.forEach(idlessNodes(tree), () => crypto.randomUUIDv4.pipe(Effect.orDie)))[
            Symbol.iterator
          ]();
          return yield* loomStore.tasks.replaceTree(
            goal.id,
            flattenTree(tree, null, () => GoalTaskId.make(fresh.next().value!)),
          );
        }),
      ),
    // 3b's, stubbed until integration.
    [LOOM_WS_METHODS.handoffDraft]: (_input: unknown) => notWired(LOOM_WS_METHODS.handoffDraft),
    [LOOM_WS_METHODS.retroDraft]: (_input: unknown) => notWired(LOOM_WS_METHODS.retroDraft),
    // 3d-4 slot: loom.threadSpend / loom.topSpend handlers go here.
  };
});

/** The nodes that need a minted id (one UUID each). */
const idlessNodes = (nodes: ReadonlyArray<TaskNode>): ReadonlyArray<TaskNode> =>
  nodes.flatMap((node) => [...(node.id === undefined ? [node] : []), ...idlessNodes(node.children)]);
