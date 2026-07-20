import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  GoalId,
  type OrchestrationEvent,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asGoalId = (value: string): GoalId => GoalId.make(value);

const now = "2026-01-01T00:00:00.000Z";
const projectId = asProjectId("project-goal-cascade");
const goalId = asGoalId("goal-cascade");

const seedThread = (
  readModel: Parameters<typeof projectEvent>[0],
  sequence: number,
  id: string,
  parentThreadId: string | null,
  threadGoalId: GoalId | null = goalId,
) =>
  projectEvent(readModel, {
    sequence,
    eventId: asEventId(`evt-thread-${id}`),
    aggregateKind: "thread",
    aggregateId: asThreadId(id),
    type: "thread.created",
    occurredAt: now,
    commandId: asCommandId(`cmd-thread-${id}`),
    causationEventId: null,
    correlationId: asCommandId(`cmd-thread-${id}`),
    metadata: {},
    payload: {
      threadId: asThreadId(id),
      projectId,
      goalId: threadGoalId,
      parentThreadId: parentThreadId === null ? null : asThreadId(parentThreadId),
      title: `Thread ${id}`,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    },
  });

// Project + goal, then: root → {child, grandchild(under child)} all on the goal.
const seedReadModel = Effect.gen(function* () {
  let readModel = yield* projectEvent(createEmptyReadModel(now), {
    sequence: 1,
    eventId: asEventId("evt-project"),
    aggregateKind: "project",
    aggregateId: projectId,
    type: "project.created",
    occurredAt: now,
    commandId: asCommandId("cmd-project"),
    causationEventId: null,
    correlationId: asCommandId("cmd-project"),
    metadata: {},
    payload: {
      projectId,
      title: "Goal Cascade",
      workspaceRoot: "/tmp/goal-cascade",
      defaultModelSelection: null,
      defaultStartFromOrigin: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });
  readModel = yield* projectEvent(readModel, {
    sequence: 2,
    eventId: asEventId("evt-goal"),
    aggregateKind: "goal",
    aggregateId: goalId,
    type: "goal.created",
    occurredAt: now,
    commandId: asCommandId("cmd-goal"),
    causationEventId: null,
    correlationId: asCommandId("cmd-goal"),
    metadata: {},
    payload: {
      goalId,
      projectId,
      slug: "goal-cascade",
      title: "Goal Cascade",
      description: "",
      createdAt: now,
      updatedAt: now,
    },
  });
  readModel = yield* seedThread(readModel, 3, "root", null);
  readModel = yield* seedThread(readModel, 4, "child", "root");
  readModel = yield* seedThread(readModel, 5, "grandchild", "child");
  return readModel;
});

const applyEvents = Effect.fnUntraced(function* (
  readModel: Parameters<typeof projectEvent>[0],
  events: ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
) {
  let projected = readModel;
  let sequence = readModel.snapshotSequence;
  for (const event of events) {
    sequence += 1;
    projected = yield* projectEvent(projected, { ...event, sequence } as OrchestrationEvent);
  }
  return projected;
});

const decideEvents = Effect.fnUntraced(function* (
  readModel: Parameters<typeof projectEvent>[0],
  command: Parameters<typeof decideOrchestrationCommand>[0]["command"],
) {
  const decided = yield* decideOrchestrationCommand({ command, readModel });
  return Array.isArray(decided) ? decided : [decided];
});

const threadIdsOf = (
  events: ReadonlyArray<{ type: string; payload: unknown }>,
  type: string,
): Set<ThreadId> =>
  new Set(
    events
      .filter((event) => event.type === type)
      .map((event) => (event.payload as { threadId: ThreadId }).threadId),
  );

it.layer(NodeServices.layer)("decider goal archive/delete cascades", (it) => {
  it.effect("archiving a root archives its whole subtree and the emptied goal", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const events = yield* decideEvents(readModel, {
        type: "thread.archive",
        commandId: asCommandId("cmd-archive-root"),
        threadId: asThreadId("root"),
      });

      expect(threadIdsOf(events, "thread.archived")).toEqual(
        new Set(["root", "child", "grandchild"].map(asThreadId)),
      );
      expect(events.filter((event) => event.type === "goal.archived")).toHaveLength(1);

      const projected = yield* applyEvents(readModel, events);
      projected.threads.forEach((thread) => expect(thread.archivedAt).not.toBeNull());
      expect(projected.goals[0]?.archivedAt).not.toBeNull();
    }),
  );

  it.effect("archiving one root of a multi-root goal keeps the goal active", () =>
    Effect.gen(function* () {
      let readModel = yield* seedReadModel;
      readModel = yield* seedThread(readModel, 6, "root2", null);
      const events = yield* decideEvents(readModel, {
        type: "thread.archive",
        commandId: asCommandId("cmd-archive-root"),
        threadId: asThreadId("root"),
      });

      expect(threadIdsOf(events, "thread.archived")).toEqual(
        new Set(["root", "child", "grandchild"].map(asThreadId)),
      );
      expect(events.some((event) => event.type === "goal.archived")).toBe(false);
    }),
  );

  it.effect("unarchiving a root restores its subtree and the goal", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const archived = yield* applyEvents(
        readModel,
        yield* decideEvents(readModel, {
          type: "thread.archive",
          commandId: asCommandId("cmd-archive-root"),
          threadId: asThreadId("root"),
        }),
      );

      const events = yield* decideEvents(archived, {
        type: "thread.unarchive",
        commandId: asCommandId("cmd-unarchive-root"),
        threadId: asThreadId("root"),
      });
      expect(threadIdsOf(events, "thread.unarchived")).toEqual(
        new Set(["root", "child", "grandchild"].map(asThreadId)),
      );
      expect(events.filter((event) => event.type === "goal.unarchived")).toHaveLength(1);

      const projected = yield* applyEvents(archived, events);
      projected.threads.forEach((thread) => expect(thread.archivedAt).toBeNull());
      expect(projected.goals[0]?.archivedAt).toBeNull();
    }),
  );

  it.effect("goal.archive routes through thread.archive without double-archiving children", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const events = yield* decideEvents(readModel, {
        type: "goal.archive",
        commandId: asCommandId("cmd-archive-goal"),
        goalId,
      });

      expect(threadIdsOf(events, "thread.archived")).toEqual(
        new Set(["root", "child", "grandchild"].map(asThreadId)),
      );
      expect(events.filter((event) => event.type === "thread.archived")).toHaveLength(3);
      expect(events.filter((event) => event.type === "goal.archived")).toHaveLength(1);
    }),
  );

  it.effect("deleting a goal's last live root deletes the subtree and the goal", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const events = yield* decideEvents(readModel, {
        type: "thread.delete",
        commandId: asCommandId("cmd-delete-root"),
        threadId: asThreadId("root"),
      });

      expect(threadIdsOf(events, "thread.deleted")).toEqual(
        new Set(["root", "child", "grandchild"].map(asThreadId)),
      );
      expect(events.filter((event) => event.type === "goal.deleted")).toHaveLength(1);

      const projected = yield* applyEvents(readModel, events);
      expect(projected.goals[0]?.deletedAt).not.toBeNull();
    }),
  );

  it.effect("deleting one root of a multi-root goal keeps the goal", () =>
    Effect.gen(function* () {
      let readModel = yield* seedReadModel;
      readModel = yield* seedThread(readModel, 6, "root2", null);
      const events = yield* decideEvents(readModel, {
        type: "thread.delete",
        commandId: asCommandId("cmd-delete-root"),
        threadId: asThreadId("root"),
      });
      expect(events.some((event) => event.type === "goal.deleted")).toBe(false);
    }),
  );

  it.effect("deleting a goalless thread cascades its subtree and emits no goal event", () =>
    Effect.gen(function* () {
      let readModel = yield* seedReadModel;
      readModel = yield* seedThread(readModel, 6, "loose", null, null);
      readModel = yield* seedThread(readModel, 7, "looseChild", "loose", null);
      const events = yield* decideEvents(readModel, {
        type: "thread.delete",
        commandId: asCommandId("cmd-delete-loose"),
        threadId: asThreadId("loose"),
      });
      expect(threadIdsOf(events, "thread.deleted")).toEqual(
        new Set(["loose", "looseChild"].map(asThreadId)),
      );
      expect(events.some((event) => event.type.startsWith("goal."))).toBe(false);
    }),
  );

  it.effect("goal.delete cascades every subtree then deletes the goal exactly once", () =>
    Effect.gen(function* () {
      let readModel = yield* seedReadModel;
      readModel = yield* seedThread(readModel, 6, "root2", null);
      const events = yield* decideEvents(readModel, {
        type: "goal.delete",
        commandId: asCommandId("cmd-delete-goal"),
        goalId,
      });

      expect(threadIdsOf(events, "thread.deleted")).toEqual(
        new Set(["root", "child", "grandchild", "root2"].map(asThreadId)),
      );
      expect(events.filter((event) => event.type === "goal.deleted")).toHaveLength(1);
    }),
  );
});
