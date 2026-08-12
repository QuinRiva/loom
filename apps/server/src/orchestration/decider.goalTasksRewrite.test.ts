/**
 * `goal.tasks.rewrite` — the declarative whole-tree replace (see
 * `plans/goal-task-tree-redesign/plan.mdx`). Colocated decider/projector tests
 * are justified here because this is the replay-deterministic core: a wrong
 * projector silently corrupts every goal on the next boot, and the read model
 * is rebuilt by folding the whole event log from sequence 0 on every start.
 */
import {
  CommandId,
  EventId,
  GoalId,
  GoalTaskId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { renderGoalTaskTree } from "./goalTaskRender.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const later = "2026-02-02T00:00:00.000Z";
const projectId = ProjectId.make("project-tasks-rewrite");
const goalId = GoalId.make("goal-tasks-rewrite");
const task = (suffix: string): GoalTaskId => GoalTaskId.make(`task-${suffix}`);

const event = (
  sequence: number,
  type: string,
  payload: unknown,
  occurredAt = now,
): OrchestrationEvent =>
  ({
    sequence,
    eventId: EventId.make(`evt-${sequence}`),
    aggregateKind: "goal",
    aggregateId: goalId,
    type,
    occurredAt,
    commandId: CommandId.make(`cmd-${sequence}`),
    causationEventId: null,
    correlationId: CommandId.make(`cmd-${sequence}`),
    metadata: {},
    payload,
  }) as OrchestrationEvent;

const fold = Effect.fnUntraced(function* (events: ReadonlyArray<OrchestrationEvent>) {
  let readModel = createEmptyReadModel(now);
  for (const next of events) readModel = yield* projectEvent(readModel, next);
  return readModel;
});

const seedEvents: ReadonlyArray<OrchestrationEvent> = [
  event(1, "project.created", {
    projectId,
    title: "Tasks Rewrite",
    workspaceRoot: "/tmp/tasks-rewrite",
    defaultModelSelection: null,
    defaultStartFromOrigin: null,
    scripts: [],
    createdAt: now,
    updatedAt: now,
  }),
  event(2, "goal.created", {
    goalId,
    projectId,
    slug: "tasks-rewrite",
    title: "Tasks Rewrite",
    description: "",
    createdAt: now,
    updatedAt: now,
  }),
];

const taskCreated = (sequence: number, id: GoalTaskId, position: number, text: string) =>
  event(sequence, "goal.task-created", {
    goalId,
    taskId: id,
    parentTaskId: null,
    text,
    position,
    createdAt: now,
    updatedAt: now,
  });

/** Flat 3-item tree — the degraded shape a rewrite is meant to restructure. */
const flatTreeEvents: ReadonlyArray<OrchestrationEvent> = [
  ...seedEvents,
  taskCreated(3, task("a"), 0, "Ship the parser"),
  taskCreated(4, task("b"), 1, "Ship the tool"),
  taskCreated(5, task("c"), 2, "Write the guidance"),
  event(6, "goal.task-updated", { goalId, taskId: task("a"), done: true, updatedAt: now }),
];

const rewrite = (
  tasks: ReadonlyArray<{
    readonly taskId: GoalTaskId;
    readonly parentTaskId: GoalTaskId | null;
    readonly text: string;
    readonly done: boolean;
    readonly position: number;
    readonly createdAt: string;
  }>,
): OrchestrationCommand =>
  ({
    type: "goal.tasks.rewrite",
    commandId: CommandId.make("server:goal-tasks-rewrite:1"),
    goalId,
    tasks,
    createdAt: later,
  }) as OrchestrationCommand;

const decide = (command: OrchestrationCommand, readModel: OrchestrationReadModel) =>
  decideOrchestrationCommand({ command, readModel }).pipe(
    Effect.map((decided) => (Array.isArray(decided) ? decided : [decided])),
  );

const rejectionDetail = (command: OrchestrationCommand, readModel: OrchestrationReadModel) =>
  decideOrchestrationCommand({ command, readModel }).pipe(
    Effect.flip,
    Effect.map((error) =>
      error._tag === "OrchestrationCommandInvariantError" ? error.detail : `unexpected: ${error}`,
    ),
  );

const goalOf = (readModel: OrchestrationReadModel) => readModel.goals.find((g) => g.id === goalId)!;

it.layer(NodeServices.layer)("goal.tasks.rewrite", (it) => {
  it.effect("restructures a flat tree into nested themes in one command", () =>
    Effect.gen(function* () {
      const readModel = yield* fold(flatTreeEvents);

      // Theme parent is new (fresh id, createdAt now); the two retained tasks
      // keep their ids, done-state and original createdAt; task-c is dropped.
      const events = yield* decide(
        rewrite([
          {
            taskId: task("theme"),
            parentTaskId: null,
            text: "Delivery",
            done: false,
            position: 0,
            createdAt: later,
          },
          {
            taskId: task("a"),
            parentTaskId: task("theme"),
            text: "Ship the parser",
            done: true,
            position: 0,
            createdAt: now,
          },
          {
            taskId: task("b"),
            parentTaskId: task("theme"),
            text: "Ship the tool",
            done: false,
            position: 1,
            createdAt: now,
          },
        ]),
        readModel,
      );

      expect(events.map((e) => e.type)).toEqual(["goal.tasks-rewritten"]);

      const projected = yield* projectEvent(readModel, {
        ...events[0]!,
        sequence: 7,
      } as OrchestrationEvent);
      expect(renderGoalTaskTree(goalOf(projected).tasks)).toBe(
        [
          "- [ ] Delivery (task-theme)",
          "  - [x] Ship the parser (task-a)",
          "  - [ ] Ship the tool (task-b)",
          "",
        ].join("\n"),
      );
      // Retained tasks keep createdAt; the rewrite restates updatedAt.
      const retained = goalOf(projected).tasks[0]!.children[0]!;
      expect(retained.createdAt).toBe(now);
      expect(retained.updatedAt).toBe(later);
    }),
  );

  it.effect("resubmitting the current tree unchanged is a no-op", () =>
    Effect.gen(function* () {
      const readModel = yield* fold(flatTreeEvents);
      const before = goalOf(readModel).tasks;

      const events = yield* decide(
        rewrite(
          before.map((current, index) => ({
            taskId: current.id,
            parentTaskId: null,
            text: current.text,
            done: current.done,
            position: index,
            createdAt: current.createdAt,
          })),
        ),
        readModel,
      );
      const projected = yield* projectEvent(readModel, {
        ...events[0]!,
        sequence: 7,
      } as OrchestrationEvent);

      expect(renderGoalTaskTree(goalOf(projected).tasks)).toBe(renderGoalTaskTree(before));
    }),
  );

  it.effect("rejects an empty submission, duplicate ids, and a forward parent reference", () =>
    Effect.gen(function* () {
      const readModel = yield* fold(flatTreeEvents);
      const entry = (id: GoalTaskId, parentTaskId: GoalTaskId | null, position: number) => ({
        taskId: id,
        parentTaskId,
        text: "Ship it",
        done: false,
        position,
        createdAt: now,
      });

      expect(yield* rejectionDetail(rewrite([]), readModel)).toContain("submitted no tasks");
      expect(
        yield* rejectionDetail(
          rewrite([entry(task("a"), null, 0), entry(task("a"), null, 1)]),
          readModel,
        ),
      ).toContain("more than once");
      // Child listed before its parent: the topological order that makes a
      // cycle unrepresentable is enforced, not assumed.
      expect(
        yield* rejectionDetail(
          rewrite([entry(task("a"), task("theme"), 0), entry(task("theme"), null, 1)]),
          readModel,
        ),
      ).toContain("not an earlier task in the submission");
    }),
  );

  it.effect("an archived goal rejects the rewrite", () =>
    Effect.gen(function* () {
      const readModel = yield* fold([
        ...flatTreeEvents,
        event(7, "goal.archived", { goalId, archivedAt: later, updatedAt: later }),
      ]);
      expect(
        yield* rejectionDetail(
          rewrite([
            {
              taskId: task("a"),
              parentTaskId: null,
              text: "Ship the parser",
              done: true,
              position: 0,
              createdAt: now,
            },
          ]),
          readModel,
        ),
      ).toContain("is archived");
    }),
  );

  // REPLAY: `goal.task-deleted` has no producer any more (the rewrite replaced
  // the per-task delete command), but 42 historical events exist in the live
  // store and the read model is rebuilt from sequence 0 on every boot.
  it.effect("replays a legacy stream containing goal.task-deleted, then rewrites on top", () =>
    Effect.gen(function* () {
      const legacy = yield* fold([
        ...seedEvents,
        taskCreated(3, task("a"), 0, "Legacy A"),
        taskCreated(4, task("b"), 1, "Legacy B"),
        event(5, "goal.task-created", {
          goalId,
          taskId: task("b-child"),
          parentTaskId: task("b"),
          text: "Legacy B child",
          position: 0,
          createdAt: now,
          updatedAt: now,
        }),
        // Deleting B takes its subtree with it (the historical semantics).
        event(6, "goal.task-deleted", { goalId, taskId: task("b"), deletedAt: later }),
      ]);

      expect(renderGoalTaskTree(goalOf(legacy).tasks)).toBe("- [ ] Legacy A (task-a)\n");

      const events = yield* decide(
        rewrite([
          {
            taskId: task("a"),
            parentTaskId: null,
            text: "Legacy A",
            done: true,
            position: 0,
            createdAt: now,
          },
        ]),
        legacy,
      );
      const projected = yield* projectEvent(legacy, {
        ...events[0]!,
        sequence: 7,
      } as OrchestrationEvent);
      expect(renderGoalTaskTree(goalOf(projected).tasks)).toBe("- [x] Legacy A (task-a)\n");
    }),
  );
});
