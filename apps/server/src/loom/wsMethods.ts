/**
 * Loom's WebSocket RPC handlers, spliced into `ws.ts`'s RPC group by ONE marked line
 * (`...(yield* makeLoomWsHandlers)`). The Rpc members are `packages/contracts/src/rpc.loom.ts`, the
 * scopes a marked block in `auth/RpcAuthorization.ts`. Goal writes publish on `LoomGoalBroadcast`.
 */
import {
  type GoalId,
  GoalTaskId,
  type HandoffDraftInput,
  LOOM_WS_METHODS,
  type LoomConsultCancelInput,
  type LoomGoal,
  type LoomGoalTask,
  type LoomGoalTaskRewriteInput,
  type LoomGoalTaskRewriteNode,
  type LoomGoalUpdateInput,
  type LoomPromptCaptureInput,
  type LoomReviewDiffInput,
  type LoomReviewFileContentsInput,
  type LoomReviewIntervalsInput,
  type LoomThreadHistoryInput,
  type LoomThreadShellInput,
  type LoomThreadSpendInput,
  type LoomTopSpendInput,
  LoomWsMethodError,
  type RetroDraftInput,
  type UsageLimitSourceLoginFinishInput,
  type UsageLimitSourceLoginStartInput,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Struct from "effect/Struct";

import { ServerConfig } from "../config.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { LoomUsageLedger } from "./economics/LoomUsageLedger.ts";
import { buildHandoffDraftTurnStart, launchDraftFork } from "./handoff/handoffDraft.ts";
import { launchRetro, RETRO_RUNS_DIR } from "./handoff/retroDraft.ts";
import { goalShellItem, LoomGoalBroadcast } from "./projection/LoomGoalBroadcast.ts";
import { promptCapturePathsOf } from "./loomPaths.ts";
import { LoomThreadConsult } from "./workstream/consult.ts";
import { ReviewSnapshotService } from "./review/ReviewSnapshotService.ts";
import { UsageLimitSources } from "../usage/UsageLimitSources.ts";
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
  const consult = yield* LoomThreadConsult;
  const usageLimitSources = yield* UsageLimitSources;
  const reviewSnapshots = yield* ReviewSnapshotService;
  const orchestrator = yield* OrchestratorV2;
  const draftServices = yield* Effect.context<OrchestratorV2 | LoomStoreV2 | Crypto.Crypto>();

  const fail = (method: string, message: string, cause?: unknown) =>
    new LoomWsMethodError({ method, message, ...(cause === undefined ? {} : { cause }) });

  /** Load the live goal, apply `write`, publish the result, answer it. */
  const goalWrite = Effect.fn("wsMethods.goalWrite")(
    function* (
      method: string,
      goalId: GoalId,
      write: (goal: LoomGoal) => Effect.Effect<unknown, LoomStoreError | LoomWsMethodError>,
    ) {
      const current = yield* loomStore.goals.get(goalId);
      if (current === null || current.deletedAt !== null) {
        return yield* fail(method, `Goal ${goalId} was not found.`);
      }
      yield* write(current);
      const goal = (yield* loomStore.goals.get(goalId))!;
      yield* broadcast.publish(goalShellItem(goal));
      return { goal: Struct.omit(goal, ["deletedAt"]) };
    },
    (effect, method, goalId, write) =>
      effect.pipe(
        Effect.catchTags({
          LoomStoreError: (cause) => Effect.fail(fail(method, `${method} failed.`, cause)),
        }),
      ),
  );

  const reviewRead =
    (method: string) =>
    <A, E extends { readonly message: string }>(effect: Effect.Effect<A, E>) =>
      effect.pipe(Effect.mapError((cause) => fail(method, cause.message, cause)));

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
    [LOOM_WS_METHODS.goalTaskRewrite]: (input: LoomGoalTaskRewriteInput) =>
      goalWrite(LOOM_WS_METHODS.goalTaskRewrite, input.goalId, (goal) =>
        Effect.gen(function* () {
          const tree = resolveTaskRewrite(goal, input);
          if (typeof tree === "string") return yield* fail(LOOM_WS_METHODS.goalTaskRewrite, tree);
          const fresh = (yield* Effect.forEach(idlessNodes(tree), () =>
            crypto.randomUUIDv4().pipe(Effect.orDie),
          ))[Symbol.iterator]();
          return yield* loomStore.tasks.replaceTree(
            goal.id,
            flattenTree(tree, null, () => GoalTaskId.make(fresh.next().value!)),
          );
        }),
      ),
    // `/handoff`: a hidden `handoff-drafter` fork of the source, kicked off on the explanation.
    [LOOM_WS_METHODS.handoffDraft]: (input: HandoffDraftInput) =>
      launchDraftFork({
        method: LOOM_WS_METHODS.handoffDraft,
        verb: "handed off",
        sourceThreadId: input.sourceThreadId,
        build: (fork) => buildHandoffDraftTurnStart({ ...fork, explanation: input.explanation }),
      }).pipe(
        Effect.map((drafterThreadId) => ({ drafterThreadId })),
        Effect.provideContext(draftServices),
      ),
    // `/retro`: a fresh, visible `retro-reviewer` root over the source's whole tree.
    [LOOM_WS_METHODS.retroDraft]: (input: RetroDraftInput) =>
      launchRetro({
        sourceThreadId: input.sourceThreadId,
        focus: input.focus,
        runsDir: RETRO_RUNS_DIR,
      }).pipe(
        Effect.map((reviewerThreadId) => ({ reviewerThreadId })),
        Effect.provideContext(draftServices),
      ),
    // 3d-4 — seam 11's spend reads.
    [LOOM_WS_METHODS.threadSpend]: (input: LoomThreadSpendInput) =>
      usageLedger
        .threadSpend(input.threadIds)
        .pipe(Effect.map((spend) => ({ spend: Object.fromEntries(spend) }))),
    [LOOM_WS_METHODS.topSpend]: (input: LoomTopSpendInput) =>
      usageLedger.topSpend(input.limit, input.since).pipe(Effect.map((threads) => ({ threads }))),
    // The node timeline's event history (outcomes with their reports, flags, routes).
    [LOOM_WS_METHODS.threadHistory]: (input: LoomThreadHistoryInput) =>
      loomStore.history(input.threadId).pipe(
        Effect.map((entries) => ({ entries })),
        Effect.mapError((cause) =>
          fail(LOOM_WS_METHODS.threadHistory, `${LOOM_WS_METHODS.threadHistory} failed.`, cause),
        ),
      ),
    // The consult card's Stop: the asker's tool call fails with the stop sentence and carries on.
    [LOOM_WS_METHODS.consultCancel]: (input: LoomConsultCancelInput) =>
      consult.cancel(input.consultId).pipe(Effect.map((stopped) => ({ stopped }))),
    // The Prompt button: each captured-prompt path, or null while that file is absent.
    [LOOM_WS_METHODS.promptCapture]: Effect.fn("wsMethods.promptCapture")(function* (
      input: LoomPromptCaptureInput,
    ) {
      const fileSystem = yield* FileSystem.FileSystem;
      const { latest, first } = promptCapturePathsOf(yield* ServerConfig, input.threadId);
      const present = (path: string) =>
        fileSystem.exists(path).pipe(
          Effect.orElseSucceed(() => false),
          Effect.map((exists) => (exists ? path : null)),
        );
      return { latest: yield* present(latest), first: yield* present(first) };
    }),
    // Thread search opens an archived root, which the shell stream does not carry.
    [LOOM_WS_METHODS.threadShell]: (input: LoomThreadShellInput) =>
      orchestrator.getThreadShell(input.threadId).pipe(
        Effect.map((thread) => ({ thread })),
        Effect.mapError((cause) =>
          fail(LOOM_WS_METHODS.threadShell, `${LOOM_WS_METHODS.threadShell} failed.`, cause),
        ),
      ),
    // The hub login reminder's Log in… dialog.
    [LOOM_WS_METHODS.usageLimitSourceLoginStart]: (input: UsageLimitSourceLoginStartInput) =>
      usageLimitSources.loginStart(input),
    [LOOM_WS_METHODS.usageLimitSourceLoginFinish]: (input: UsageLimitSourceLoginFinishInput) =>
      usageLimitSources.loginFinish(input),
    // Change review: the Diff panel's "Since your message" and "Earlier" entries.
    [LOOM_WS_METHODS.reviewIntervals]: (input: LoomReviewIntervalsInput) =>
      reviewRead(LOOM_WS_METHODS.reviewIntervals)(reviewSnapshots.listIntervals(input.threadId)),
    [LOOM_WS_METHODS.reviewDiff]: (input: LoomReviewDiffInput) =>
      reviewRead(LOOM_WS_METHODS.reviewDiff)(reviewSnapshots.diff(input)),
    [LOOM_WS_METHODS.reviewFileContents]: (input: LoomReviewFileContentsInput) =>
      reviewRead(LOOM_WS_METHODS.reviewFileContents)(reviewSnapshots.fileContents(input)),
  };
});

/** The nodes that need a minted id (one UUID each). */
const idlessNodes = (nodes: ReadonlyArray<TaskNode>): ReadonlyArray<TaskNode> =>
  nodes.flatMap((node) => [
    ...(node.id === undefined ? [node] : []),
    ...idlessNodes(node.children),
  ]);
