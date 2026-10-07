/**
 * mcp__t3-code__goal_handoff, mcp__t3-code__goal_continue, mcp__t3-code__thread_fork and mcp__t3-code__set_thread_title on V2's real
 * orchestrator. The launch service is a stub that records what it was asked
 * and dispatches the initial message as the real one would, so the test sees
 * the ordering that matters: the thread carries its goal BEFORE its first
 * message, and that message is the brief. `held` is written by exactly the two
 * staged-root tools, never by the handoff.
 */
import { assert, it } from "@effect/vitest";
import { CheckpointId, CommandId, EventId, GoalId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as GitWorkflowService from "../../../../git/GitWorkflowService.ts";
import { buildHandoffDraftTurnStart } from "../../../../loom/handoff/handoffDraft.ts";
import { LoomStoreV2 } from "../../../../loom/projection/LoomStore.ts";
import {
  completeSeededRun,
  seededRunIds,
  seedRunningRun,
  seedThread,
  writeEvents,
} from "../../../../loom/testkit/loomOrchestratorLayer.ts";
import { LoomThreadConsult } from "../../../../loom/workstream/consult.ts";
import * as Orchestrator from "../../../../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../../../../orchestration-v2/ThreadLaunchService.ts";
import { callAs, makeHandlerTestLayer } from "./handlers.testkit.ts";

const projectId = ProjectId.make("project:loom-test");

/** What each stubbed launch saw: its input and whether the thread already carried a goal. */
const launches: Array<{
  readonly input: ThreadLaunchService.ThreadLaunchInput;
  readonly goalAtLaunch: GoalId | null;
}> = [];

const LaunchStub = Layer.effect(
  ThreadLaunchService.ThreadLaunchService,
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const store = yield* LoomStoreV2;
    return ThreadLaunchService.ThreadLaunchService.of({
      launch: (input) =>
        Effect.gen(function* () {
          const threadId = input.threadId!;
          launches.push({
            input,
            goalAtLaunch: (yield* store.getWorkstream(threadId))?.goalId ?? null,
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`${input.commandId}:initial-message`),
            threadId,
            messageId: `message:${input.commandId}` as never,
            text: input.initialMessage!.text,
            attachments: [],
            createdBy: input.createdBy,
            creationSource: input.creationSource,
            dispatchMode: { type: "queue_after_active" },
          });
          return {
            threadId,
            projection: yield* orchestrator.getThreadProjection(threadId),
            resumed: false,
          };
        }).pipe(Effect.orDie),
      retryPreparation: () => Effect.die("unused"),
    });
  }),
);

const TestLayer = makeHandlerTestLayer(
  Layer.mergeAll(
    LaunchStub,
    Layer.mock(LoomThreadConsult)({}),
    Layer.mock(GitWorkflowService.GitWorkflowService)({
      localStatus: () => Effect.succeed({ refName: "main" } as never),
    }),
  ),
);

const goalRoot = Effect.fn("stagedRootsTest.goalRoot")(function* (name: string) {
  const root = ThreadId.make(`${name}-root`);
  const goalId = GoalId.make(`goal:${name}`);
  yield* seedThread({ threadId: root, title: `Root ${name}` });
  yield* (yield* LoomStoreV2).goals.upsert({
    id: goalId,
    projectId,
    slug: name,
    title: `Goal ${name}`,
    description: "",
  });
  yield* (yield* Orchestrator.OrchestratorV2).dispatch({
    type: "thread.goal.set",
    commandId: CommandId.make(`command:${name}:goal-set`),
    threadId: root,
    createdAt: DateTime.formatIso(yield* DateTime.now),
    goalId,
  });
  return { root, goalId };
});

const messagesOf = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    Effect.map(orchestrator.getThreadRecords(threadId, ["messages"]), ({ messages }) => messages),
  );

it.layer(TestLayer)("staged roots, handoff and title", (it) => {
  it.effect("goal_handoff: thread created, goal set, then the brief is its first message", () =>
    Effect.gen(function* () {
      const store = yield* LoomStoreV2;
      const { root: caller } = yield* goalRoot("handoff");
      const result = yield* callAs(caller, "goal_handoff", {
        title: "Usage rollups",
        description: "Roll usage up to the goal.",
        brief: "Build the goal-level usage rollup.",
      });
      assert.isFalse(result.isError, result.text);
      assert.include(result.text, "is starting on your brief in a fresh worktree");

      assert.lengthOf(launches, 1);
      const { input, goalAtLaunch } = launches[0]!;
      const threadId = input.threadId!;
      assert.isTrue(input.reuseExistingThread);
      assert.deepEqual(input.workspaceStrategy, {
        type: "worktree",
        baseRef: "main",
        startFromOrigin: true,
      });
      assert.equal(input.initialMessage?.text, "Build the goal-level usage rollup.");
      assert.equal(input.initialMessage?.senderThreadId, caller);

      // The goal was on the thread before the launch dispatched its first message.
      const row = (yield* store.getWorkstream(threadId))!;
      assert.isNotNull(goalAtLaunch);
      assert.equal(row.goalId, goalAtLaunch);
      assert.isTrue(row.goalId!.startsWith("goal:"));
      assert.isNull(row.parentThreadId);
      assert.isFalse(row.held);
      const goal = (yield* store.goals.get(row.goalId!))!;
      assert.deepEqual(
        [goal.title, goal.slug, goal.projectId],
        ["Usage rollups", "usage-rollups", projectId],
      );

      const messages = yield* messagesOf(threadId);
      assert.lengthOf(messages, 1);
      assert.equal(messages[0]!.text, "Build the goal-level usage rollup.");
      assert.equal(messages[0]!.createdBy, "agent");

      assert.deepEqual(
        (yield* store.getWorkstream(caller))!.handoffDestinations.map((entry) => entry.threadId),
        [threadId],
      );
    }),
  );

  it.effect(
    "mcp__t3-code__goal_handoff from a /handoff drafter points at its fork and records on the forkFromThreadId source",
    () =>
      Effect.gen(function* () {
        const store = yield* LoomStoreV2;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const { root: source } = yield* goalRoot("drafted");
        const drafter = ThreadId.make("drafted-drafter");
        // The drafter's row exactly as `/handoff` spawns it (3b, DL-384): a root with forkFromThreadId.
        const [spawn] = buildHandoffDraftTurnStart({
          source: (yield* orchestrator.getThreadShell(source))!,
          sourceGoalId: null,
          drafterThreadId: drafter,
          createdAt: DateTime.formatIso(yield* DateTime.now),
          explanation: "split the importer",
        });
        yield* orchestrator.dispatch(spawn!);

        const result = yield* callAs(drafter, "goal_handoff", {
          title: "Importer split",
          description: "Split the importer.",
          brief: "Split the importer into two stages.",
        });
        assert.isFalse(result.isError, result.text);
        const { input } = launches.at(-1)!;
        assert.include(input.initialMessage!.text, `thread ${drafter} holds a frozen fork`);
        for (const on of [drafter, source])
          assert.deepEqual(
            (yield* store.getWorkstream(on))!.handoffDestinations.map((entry) => entry.threadId),
            [input.threadId!],
          );
      }),
  );

  it.effect("goal_continue: a held sibling root on the same goal, carrying the brief", () =>
    Effect.gen(function* () {
      const store = yield* LoomStoreV2;
      const { root, goalId } = yield* goalRoot("continue");
      const result = yield* callAs(root, "goal_continue", { brief: "Pick up at step 3." });
      const threadId = ThreadId.make(result.text.match(/^Staged continuation session (\S+) /)![1]!);
      const row = (yield* store.getWorkstream(threadId))!;
      assert.isTrue(row.held);
      assert.equal(row.goalId, goalId);
      assert.isNull(row.parentThreadId);
      assert.equal(row.continuesThreadId, root);
      assert.isNull(row.kickoffAt);
      const brief = yield* (yield* FileSystem.FileSystem).readFileString(row.kickoffBriefPath!);
      assert.include(brief, "Pick up at step 3.");
      assert.include(brief, `hands off from thread ${root}`);
      assert.equal(
        (yield* (yield* Orchestrator.OrchestratorV2).getThreadShell(threadId))!.title,
        "Goal continue (continued)",
      );
      assert.lengthOf(yield* messagesOf(threadId), 0);
    }),
  );

  it.effect("thread_fork: upstream fork transfer, goal set and held — a root in Loom's graph", () =>
    Effect.gen(function* () {
      const store = yield* LoomStoreV2;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { root, goalId } = yield* goalRoot("fork");

      // A thread on its first turn has nothing stable to fork.
      yield* seedRunningRun({ threadId: root });
      const early = yield* callAs(root, "thread_fork", {});
      assert.isTrue(early.isError);
      assert.include(early.text, "no completed turn yet");

      yield* completeSeededRun({ threadId: root });
      const run = (yield* orchestrator.getThreadProjection(root)).runs[0]!;
      yield* writeEvents([
        {
          id: EventId.make("event:fork-test:checkpoint"),
          type: "run.updated",
          threadId: root,
          runId: seededRunIds(root).runId,
          occurredAt: yield* DateTime.now,
          payload: { ...run, checkpointId: CheckpointId.make("checkpoint:fork-test") },
        },
      ]);
      // The caller is mid-turn again when it calls the tool; that does not refuse it.
      yield* seedRunningRun({ threadId: root, ordinal: 2 });
      const result = yield* callAs(root, "thread_fork", { threadTitle: "Alternative" });
      assert.isFalse(result.isError, result.text);
      const fork = ThreadId.make(result.text.match(/staged session (\S+) /)![1]!);

      const row = (yield* store.getWorkstream(fork))!;
      assert.isTrue(row.held);
      assert.equal(row.goalId, goalId);
      assert.isNull(row.parentThreadId);
      assert.equal(row.rootThreadId, fork);
      assert.deepEqual(
        (yield* store.listChildren(root)).map((child) => child.threadId),
        [],
      );
      const { thread, contextTransfers } = yield* orchestrator.getThreadRecords(fork, [
        "contextTransfers",
      ]);
      assert.equal(thread.title, "Alternative");
      assert.equal(thread.lineage.relationshipToParent, "fork");
      const [transfer] = contextTransfers;
      assert.equal(transfer?.type, "fork");
      assert.equal(transfer?.status, "pending");
      assert.equal(transfer?.sourcePoint.runId, run.id);
    }),
  );

  it.effect("mcp__t3-code__set_thread_title renames the calling thread", () =>
    Effect.gen(function* () {
      const self = ThreadId.make("title-self");
      yield* seedThread({ threadId: self });
      const result = yield* callAs(self, "set_thread_title", { title: "  Sharper title " });
      assert.equal(result.text, `Set this thread's title to "Sharper title".`);
      assert.equal(
        (yield* (yield* Orchestrator.OrchestratorV2).getThreadShell(self))!.title,
        "Sharper title",
      );
    }),
  );
});
