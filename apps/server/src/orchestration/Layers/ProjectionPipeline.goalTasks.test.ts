/**
 * SQL projection of the goal task tree: the declarative whole-tree rewrite
 * (`goal.tasks-rewritten`) and the retired-but-replayed per-task delete
 * (`goal.task-deleted`). This projection is what the web `GoalTasksPanel`
 * reads, and it is rebuilt by replaying the log, so both cases have to keep
 * landing the same rows. See `plans/goal-task-tree-redesign/plan.mdx`.
 */
import {
  CommandId,
  EventId,
  GoalId,
  GoalTaskId,
  type OrchestrationEvent,
  ProjectId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ServerConfig } from "../../config.ts";

const TestLayer = OrchestrationProjectionPipelineLive.pipe(
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-goal-tasks-test-" })),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const now = "2026-01-01T00:00:00.000Z";
const rewrittenAt = "2026-02-02T00:00:00.000Z";
const projectId = ProjectId.make("project-goal-tasks");
const goalId = GoalId.make("goal-goal-tasks");
const task = (suffix: string): GoalTaskId => GoalTaskId.make(`task-${suffix}`);

type AppendedEvent = Omit<OrchestrationEvent, "sequence">;

const append = (index: number, type: string, payload: unknown, occurredAt = now): AppendedEvent =>
  ({
    type,
    eventId: EventId.make(`evt-${index}`),
    aggregateKind: "goal",
    aggregateId: goalId,
    occurredAt,
    commandId: CommandId.make(`cmd-${index}`),
    causationEventId: null,
    correlationId: CommandId.make(`cmd-${index}`),
    metadata: {},
    payload,
  }) as AppendedEvent;

const taskCreated = (
  index: number,
  id: GoalTaskId,
  parentTaskId: GoalTaskId | null,
  text: string,
) =>
  append(index, "goal.task-created", {
    goalId,
    taskId: id,
    parentTaskId,
    text,
    position: 0,
    createdAt: now,
    updatedAt: now,
  });

interface TaskRow {
  readonly taskId: string;
  readonly parentTaskId: string | null;
  readonly position: number;
  readonly text: string;
  readonly done: number;
  readonly createdAt: string;
  readonly deletedAt: string | null;
}

it.layer(TestLayer)("goal task projection", (it) => {
  it.effect("a rewrite upserts the submission and tombstones everything absent from it", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;

      yield* eventStore.append({
        type: "project.created",
        eventId: EventId.make("evt-project"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: now,
        commandId: CommandId.make("cmd-project"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project"),
        metadata: {},
        payload: {
          projectId,
          title: "Goal Tasks",
          workspaceRoot: "/tmp/goal-tasks",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* eventStore.append(
        append(1, "goal.created", {
          goalId,
          projectId,
          slug: "goal-tasks",
          title: "Goal Tasks",
          description: "",
          createdAt: now,
          updatedAt: now,
        }),
      );
      yield* eventStore.append(taskCreated(2, task("a"), null, "Legacy A"));
      yield* eventStore.append(taskCreated(3, task("b"), null, "Legacy B"));
      yield* eventStore.append(taskCreated(4, task("b-child"), task("b"), "Legacy B child"));
      // Retired command, still replayed: delete takes the subtree with it.
      yield* eventStore.append(
        append(5, "goal.task-deleted", { goalId, taskId: task("b"), deletedAt: now }),
      );
      yield* projectionPipeline.bootstrap;

      const live = () =>
        sql<TaskRow>`
          SELECT
            task_id AS "taskId",
            parent_task_id AS "parentTaskId",
            position,
            text,
            done,
            created_at AS "createdAt",
            deleted_at AS "deletedAt"
          FROM projection_goal_tasks
          WHERE deleted_at IS NULL
          ORDER BY task_id ASC
        `;

      assert.deepEqual(
        (yield* live()).map((row) => row.taskId),
        ["task-a"],
      );

      yield* eventStore.append(
        append(
          6,
          "goal.tasks-rewritten",
          {
            goalId,
            tasks: [
              {
                taskId: task("theme"),
                parentTaskId: null,
                text: "Delivery",
                done: false,
                position: 0,
                createdAt: rewrittenAt,
              },
              {
                taskId: task("a"),
                parentTaskId: task("theme"),
                text: "Legacy A",
                done: true,
                position: 0,
                createdAt: now,
              },
            ],
            rewrittenAt,
          },
          rewrittenAt,
        ),
      );
      yield* projectionPipeline.bootstrap;

      // Retained task reparented + done, with its original createdAt; the new
      // theme inserted; nothing else live.
      assert.deepEqual(yield* live(), [
        {
          taskId: "task-a",
          parentTaskId: "task-theme",
          position: 0,
          text: "Legacy A",
          done: 1,
          createdAt: now,
          deletedAt: null,
        },
        {
          taskId: "task-theme",
          parentTaskId: null,
          position: 0,
          text: "Delivery",
          done: 0,
          createdAt: rewrittenAt,
          deletedAt: null,
        },
      ]);

      // A task dropped from the submission is tombstoned, not hard-deleted.
      const dropped = yield* sql<{
        readonly deletedAt: string | null;
      }>`SELECT deleted_at AS "deletedAt" FROM projection_goal_tasks WHERE task_id = 'task-b-child'`;
      assert.deepEqual(dropped, [{ deletedAt: now }]);
    }),
  );
});
