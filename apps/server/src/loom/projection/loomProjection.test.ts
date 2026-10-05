import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  GoalId,
  GoalTaskId,
  MessageId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionMaintenance from "../../orchestration-v2/ProjectionMaintenance.ts";
import {
  LoomOrchestratorTestLayer,
  loomEvent,
  seedThread,
  writeEvents,
} from "../testkit/loomOrchestratorLayer.ts";
import * as LoomGoalBroadcast from "./LoomGoalBroadcast.ts";
import { LoomStoreV2 } from "./LoomStore.ts";

const TestLayer = LoomGoalBroadcast.layerWithReactor.pipe(
  Layer.provideMerge(LoomOrchestratorTestLayer),
);
const projectId = ProjectId.make("project:loom-test");
// Distinct event times, as a live server has them (the goal cascades are time-judged).
const tick = TestClock.adjust("1 second");

const created = (
  threadId: ThreadId,
  parentThreadId: ThreadId | null,
  goalId: GoalId | null = null,
) =>
  loomEvent("thread.workstream-created", threadId, {
    parentThreadId,
    rootThreadId: parentThreadId ?? threadId,
    projectId,
    goalId,
    anchorTaskId: null,
    role: "coder",
    purpose: "Purpose",
    graphKey: null,
    kickoffBriefPath: null,
    held: true,
    blockedBy: [],
    routes: [],
    spawnGeneration: null,
    forkFromThreadId: null,
    continuesThreadId: null,
  });

const dispatch = Effect.fn("test.dispatch")(function* (
  command: Parameters<Orchestrator.OrchestratorV2["Service"]["dispatch"]>[0],
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  return yield* orchestrator.dispatch(command);
});

it.layer(TestLayer)("Loom projector", (it) => {
  it.effect("folds Loom events into the sidecar row, replay-safely", () =>
    Effect.gen(function* () {
      const store = yield* LoomStoreV2;
      const threadId = ThreadId.make("fold-child");
      yield* seedThread({ threadId });
      yield* writeEvents([yield* created(threadId, ThreadId.make("fold-parent"))]);
      const initial = (yield* store.getWorkstream(threadId))!;
      assert.isTrue(initial.held);
      assert.isNotNull(initial.heldSince);
      assert.equal(initial.rootThreadId, "fold-parent");

      // A replayed create changes nothing.
      const replayed = yield* created(threadId, null);
      yield* writeEvents([replayed]);
      assert.equal((yield* store.getWorkstream(threadId))?.parentThreadId, "fold-parent");

      const raise = yield* loomEvent("thread.attention-raised", threadId, {
        reason: "awaiting_acceptance",
      });
      yield* writeEvents([
        yield* loomEvent("thread.held-set", threadId, { held: false }),
        raise,
        yield* loomEvent("thread.attention-raised", threadId, { reason: "error" }),
        yield* loomEvent("thread.dependencies-set", threadId, { blockedBy: [ThreadId.make("x")] }),
        yield* loomEvent("thread.kickoff-brief-set", threadId, { kickoffBriefPath: "/brief.md" }),
        yield* loomEvent("thread.kickoff-recorded", threadId, {
          kickoffAt: "2026-01-01T00:00:00.000Z",
          messageId: MessageId.make("m1"),
          origin: "kickoff",
        }),
        yield* loomEvent("thread.kickoff-recorded", threadId, {
          kickoffAt: "2026-02-02T00:00:00.000Z",
          messageId: MessageId.make("m2"),
          origin: "user",
        }),
        yield* loomEvent("thread.gate-rework-accepted", threadId, {
          sourceThreadId: ThreadId.make("reviewer"),
          round: 1,
        }),
      ]);
      const mid = (yield* store.getWorkstream(threadId))!;
      assert.isFalse(mid.held);
      assert.isNull(mid.heldSince);
      assert.deepEqual(mid.attention, ["awaiting_acceptance", "error"]);
      assert.equal(mid.attentionEpisodes.awaiting_acceptance, raise.id);
      assert.deepEqual(mid.blockedBy, [ThreadId.make("x")]);
      assert.isNotNull(mid.dependenciesSince);
      assert.equal(mid.kickoffBriefPath, "/brief.md");
      assert.equal(mid.kickoffAt, "2026-01-01T00:00:00.000Z"); // first write wins
      assert.isTrue(mid.pendingRework);

      const outcome = yield* loomEvent("thread.outcome-set", threadId, {
        outcome: "done",
        cause: "submit",
      });
      const recorded = yield* loomEvent("thread.outcome-recorded", threadId, {
        outcome: "done",
        decision: "terminal",
        round: 0,
      });
      const loopBack = yield* loomEvent("thread.route-taken", threadId, {
        to: ThreadId.make("reviewer"),
        round: 1,
        kind: "loop-back",
      });
      yield* writeEvents([
        yield* loomEvent("thread.attention-cleared", threadId, { reason: "error" }),
        outcome,
        recorded,
        loopBack,
        yield* loomEvent("thread.report-set", threadId, { reportPath: "/report.md" }),
      ]);
      const done = (yield* store.getWorkstream(threadId))!;
      assert.deepEqual(done.attention, ["awaiting_acceptance"]);
      assert.deepEqual(Object.keys(done.attentionEpisodes), ["awaiting_acceptance"]);
      assert.equal(done.outcome, "done");
      assert.equal(done.outcomeEventId, outcome.id);
      assert.equal(done.lastOutcome?.eventId, recorded.id);
      assert.deepEqual(done.lastRoute, {
        to: ThreadId.make("reviewer"),
        round: 1,
        kind: "loop-back",
        eventId: loopBack.id,
      });
      assert.isFalse(done.pendingRework);
      assert.equal(done.reportPath, "/report.md");

      yield* writeEvents([
        yield* loomEvent("thread.attention-cleared", threadId, {}),
        yield* loomEvent("thread.route-taken", threadId, {
          to: ThreadId.make("coder"),
          round: 2,
          kind: "loop",
        }),
      ]);
      const cleared = (yield* store.getWorkstream(threadId))!;
      assert.deepEqual(cleared.attention, []);
      assert.deepEqual(cleared.attentionEpisodes, {});
      assert.equal(cleared.gateRounds, 2);
    }),
  );

  it.effect("records consult and peer-message edges and appends the send log once", () =>
    Effect.gen(function* () {
      const store = yield* LoomStoreV2;
      const sender = ThreadId.make("edge-sender");
      const target = ThreadId.make("edge-target");
      yield* seedThread({ threadId: sender });
      yield* writeEvents([yield* created(sender, null)]);
      const now = DateTime.formatIso(yield* DateTime.now);
      const consult = yield* loomEvent("thread.consult-recorded", sender, {
        askerThreadId: sender,
        targetThreadId: target,
        targetTitle: "Target",
        question: `  What   is ${"x".repeat(200)}`,
        answer: "42",
        resolved: true,
        durationMs: 5,
        createdAt: now,
      });
      const recorded = yield* loomEvent("thread.peer-message-recorded", sender, {
        senderThreadId: sender,
        recordId: "record-1",
        targetThreadId: target,
        targetTitle: "Target",
        message: "hello",
        framedMessage: "[from sender] hello",
        createdAt: now,
      });
      yield* writeEvents([consult, recorded]);
      // A second event for the same record: no second row, no second log entry.
      yield* writeEvents([{ ...recorded, id: EventId.make("event:record-1-again") }]);

      const ws = (yield* store.getWorkstream(sender))!;
      assert.deepEqual(ws.notifySendLog, [{ targetThreadId: target, at: now }]);
      const [summary] = yield* store.consults.listByAsker(sender);
      assert.equal(summary?.count, 1);
      assert.isTrue(summary!.lastQuestionPreview.startsWith("What is x"));
      assert.lengthOf(summary!.lastQuestionPreview, 140);
      assert.deepEqual(
        (yield* store.peerMessages.listPending(target)).map((row) => row.recordId),
        ["record-1"],
      );
      const fields = (yield* store.shellFields([sender])).get(sender)!;
      assert.equal(fields.peerMessages[0]?.pendingCount, 1);
      assert.equal(fields.consults[0]?.targetThreadId, target);

      yield* writeEvents([
        yield* loomEvent("thread.peer-message-delivered", sender, {
          senderThreadId: sender,
          recordId: "record-1",
          updatedAt: now,
        }),
        yield* loomEvent("thread.handoff-recorded", sender, {
          threadId: sender,
          drafterThreadId: null,
          destinationGoalId: GoalId.make("goal:handoff"),
          destinationThreadId: ThreadId.make("handoff-root"),
          createdAt: now,
        }),
      ]);
      assert.deepEqual(yield* store.peerMessages.listPending(target), []);
      assert.deepEqual((yield* store.getWorkstream(sender))?.handoffDestinations, [
        {
          goalId: GoalId.make("goal:handoff"),
          threadId: ThreadId.make("handoff-root"),
          drafterThreadId: sender,
          createdAt: now,
        },
      ]);
    }),
  );

  it.effect("goal-set creates a goal-less root's row from its V2 thread", () =>
    Effect.gen(function* () {
      const store = yield* LoomStoreV2;
      const threadId = ThreadId.make("goalset-root");
      yield* seedThread({ threadId });
      yield* writeEvents([
        yield* loomEvent("thread.goal-set", threadId, {
          goalId: GoalId.make("goal:set"),
          anchorTaskId: GoalTaskId.make("task:anchor"),
        }),
      ]);
      const row = (yield* store.getWorkstream(threadId))!;
      assert.equal(row.projectId, projectId);
      assert.isNull(row.parentThreadId);
      assert.equal(row.rootThreadId, threadId);
      assert.equal(row.anchorTaskId, "task:anchor");
      // Same goal, anchor omitted: the anchor stays.
      yield* writeEvents([
        yield* loomEvent("thread.goal-set", threadId, { goalId: GoalId.make("goal:set") }),
      ]);
      assert.equal((yield* store.getWorkstream(threadId))?.anchorTaskId, "task:anchor");
    }),
  );

  it.effect(
    "mirrors upstream archive / unarchive / rename / delete and runs the goal cascades",
    () =>
      Effect.gen(function* () {
        const store = yield* LoomStoreV2;
        const broadcast = yield* LoomGoalBroadcast.LoomGoalBroadcast;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const subscription = yield* broadcast.subscribe;
        const goalId = GoalId.make("goal:cascade");
        yield* store.goals.upsert({
          id: goalId,
          projectId,
          slug: "cascade",
          title: "Original",
          description: "",
        });
        const a = ThreadId.make("cascade-a");
        const b = ThreadId.make("cascade-b");
        const plain = ThreadId.make("cascade-plain");
        yield* seedThread({ threadId: a });
        yield* seedThread({ threadId: b });
        yield* seedThread({ threadId: plain });
        yield* writeEvents([yield* created(a, null, goalId), yield* created(b, null, goalId)]);
        const nextItem = Stream.fromSubscription(subscription).pipe(Stream.take(1), Stream.runHead);

        // Renaming one of two live threads leaves the goal alone.
        yield* tick;
        yield* dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("rename-a"),
          threadId: a,
          title: "Renamed A",
        });
        assert.equal((yield* store.goals.get(goalId))?.title, "Original");

        yield* tick;
        yield* dispatch({
          type: "thread.archive",
          commandId: CommandId.make("archive-a"),
          threadId: a,
        });
        const archivedA = (yield* store.getWorkstream(a))!;
        assert.isNotNull(archivedA.archivedAt);
        assert.isNull((yield* store.goals.get(goalId))?.archivedAt);

        // b is now the sole live thread: a rename follows into the goal and is broadcast.
        yield* tick;
        yield* dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("rename-b"),
          threadId: b,
          title: "Renamed B",
        });
        assert.equal((yield* store.goals.get(goalId))?.title, "Renamed B");
        const renamed = yield* nextItem;
        assert.equal(renamed._tag === "Some" && renamed.value.kind, "goal.updated");

        // Archiving the last live thread archives the goal.
        yield* tick;
        yield* dispatch({
          type: "thread.archive",
          commandId: CommandId.make("archive-b"),
          threadId: b,
        });
        assert.isNotNull((yield* store.goals.get(goalId))?.archivedAt);
        const archived = yield* nextItem;
        assert.isTrue(
          archived._tag === "Some" &&
            archived.value.kind === "goal.updated" &&
            archived.value.goal.archivedAt !== null,
        );

        // Unarchiving resurfaces the goal and stamps the episode.
        yield* tick;
        const stored = yield* orchestrator.dispatch({
          type: "thread.unarchive",
          commandId: CommandId.make("unarchive-a"),
          threadId: a,
        });
        const unarchivedA = (yield* store.getWorkstream(a))!;
        assert.isNull(unarchivedA.archivedAt);
        assert.isNotNull(unarchivedA.unarchivedAt);
        assert.equal(
          unarchivedA.unarchivedEventId,
          stored.storedEvents.find((event) => event.event.type === "thread.unarchived")?.event.id,
        );
        assert.isNull((yield* store.goals.get(goalId))?.archivedAt);

        yield* tick;
        yield* dispatch({
          type: "thread.delete",
          commandId: CommandId.make("delete-a"),
          threadId: a,
        });
        assert.isNotNull((yield* store.getWorkstream(a))?.deletedAt);

        // A thread with no sidecar row is untouched by the mirror.
        yield* tick;
        yield* dispatch({
          type: "thread.archive",
          commandId: CommandId.make("archive-plain"),
          threadId: plain,
        });
        assert.isNull(yield* store.getWorkstream(plain));
      }),
  );

  it.effect("joins shell.workstream onto Loom threads only", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const loomThread = ThreadId.make("join-loom");
      const plain = ThreadId.make("join-plain");
      yield* seedThread({ threadId: loomThread });
      yield* seedThread({ threadId: plain });
      yield* writeEvents([
        yield* created(loomThread, null),
        yield* loomEvent("thread.attention-raised", loomThread, { reason: "needs_guidance" }),
      ]);
      const shell = (yield* orchestrator.getThreadShell(loomThread))!;
      assert.deepEqual(shell.workstream?.attention, ["needs_guidance"]);
      assert.deepEqual(shell.workstream?.consults, []);
      assert.notProperty(shell.workstream, "attentionEpisodes");
      assert.notProperty(shell.workstream, "notifySendLog");
      assert.notProperty(yield* orchestrator.getThreadShell(plain), "workstream");
      const snapshot = yield* orchestrator.getShellSnapshot();
      assert.isDefined(snapshot.threads.find((entry) => entry.id === loomThread)?.workstream);
      assert.isUndefined(snapshot.threads.find((entry) => entry.id === plain)?.workstream);
    }),
  );

  it.effect("a full projection rebuild replays the log over the Loom tables without drift", () =>
    Effect.gen(function* () {
      const store = yield* LoomStoreV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const before = yield* store.listReDriveInput();
      const goalsBefore = yield* store.goals.listByProject(projectId, { includeDeleted: true });
      const verification = yield* maintenance.rebuild;
      assert.isTrue(verification.valid);
      assert.deepEqual(yield* store.listReDriveInput(), before);
      assert.deepEqual(
        yield* store.goals.listByProject(projectId, { includeDeleted: true }),
        goalsBefore,
      );
    }),
  );

  it.effect("goal surface: nothing without loom: true; snapshot goals and items with it", () =>
    Effect.gen(function* () {
      const store = yield* LoomStoreV2;
      const broadcast = yield* LoomGoalBroadcast.LoomGoalBroadcast;
      const goal = yield* store.goals.upsert({
        id: GoalId.make("goal:surface"),
        projectId: ProjectId.make("project:surface"),
        slug: "surface",
        title: "Surface",
        description: "",
      });
      const project = { id: goal.projectId } as never;

      const plain = yield* LoomGoalBroadcast.loomShellGoals({});
      const opted = yield* LoomGoalBroadcast.loomShellGoals({ loom: true });
      yield* broadcast.publish(LoomGoalBroadcast.goalShellItem(goal));

      assert.deepEqual(yield* plain.snapshotGoals([project]), {});
      assert.deepEqual(yield* Stream.runCollect(plain.items), []);
      const snapshot = yield* opted.snapshotGoals([project]);
      assert.deepEqual("goals" in snapshot ? snapshot.goals.map((entry) => entry.id) : [], [
        goal.id,
      ]);
      assert.notProperty("goals" in snapshot ? snapshot.goals[0] : {}, "deletedAt");
      const item = yield* Stream.runHead(opted.items);
      assert.equal(item._tag === "Some" && item.value.kind, "goal.updated");
    }).pipe(Effect.scoped),
  );
});
