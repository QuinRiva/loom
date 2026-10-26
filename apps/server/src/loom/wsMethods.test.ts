import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { GoalId, GoalTaskId, LOOM_WS_METHODS, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerConfig from "../config.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { WorkspaceFileSystem } from "../workspace/WorkspaceFileSystem.ts";
import * as LoomUsageLedger from "./economics/LoomUsageLedger.ts";
import * as LoomGoalBroadcast from "./projection/LoomGoalBroadcast.ts";
import * as LoomStore from "./projection/LoomStore.ts";
import { UsageLimitSources } from "../usage/UsageLimitSources.ts";
import { ReviewSnapshotService } from "./review/ReviewSnapshotService.ts";
import { LoomThreadConsult } from "./workstream/consult.ts";
import { makeLoomWsHandlers } from "./wsMethods.ts";

const TestLayer = Layer.mergeAll(
  LoomStore.layer,
  LoomGoalBroadcast.layer,
  LoomUsageLedger.layer,
  Layer.mock(LoomThreadConsult)({}),
  Layer.mock(UsageLimitSources)({}),
  Layer.mock(ReviewSnapshotService)({}),
  // The drafter handlers capture the orchestrator; these tests never call them.
  Layer.succeed(OrchestratorV2, {} as never),
  Layer.mock(ProjectStoreV2)({}),
  Layer.mock(WorkspaceFileSystem)({}),
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-loom-ws-" }),
).pipe(Layer.provideMerge(SqlitePersistence.layerMemory), Layer.provideMerge(NodeServices.layer));
const goalId = GoalId.make("goal:ws");
const task = (id: string) => GoalTaskId.make(id);

const seedGoal = Effect.gen(function* () {
  const store = yield* LoomStore.LoomStoreV2;
  yield* store.goals.upsert({
    id: goalId,
    projectId: ProjectId.make("project:ws"),
    slug: "ws",
    title: "Goal",
    description: "",
  });
  yield* store.tasks.replaceTree(goalId, [
    { id: task("a"), parentTaskId: null, text: "A", done: false, position: 0 },
    { id: task("a1"), parentTaskId: task("a"), text: "A1", done: false, position: 0 },
    { id: task("b"), parentTaskId: null, text: "B", done: false, position: 1 },
  ]);
});

it.layer(TestLayer)("loom ws goal methods", (it) => {
  it.effect("write the store and publish the goal on the broadcast", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* seedGoal;
        const handlers = yield* makeLoomWsHandlers;
        const subscription = yield* (yield* LoomGoalBroadcast.LoomGoalBroadcast).subscribe;

        const renamed = yield* handlers[LOOM_WS_METHODS.goalUpdate]({ goalId, title: "Renamed" });
        assert.strictEqual(renamed.goal.title, "Renamed");

        // Branch rewrite: tick A1 and add a child under A; B is untouched.
        const branch = yield* handlers[LOOM_WS_METHODS.goalTaskRewrite]({
          goalId,
          branchTaskId: task("a"),
          tasks: [
            {
              id: task("a"),
              text: "A",
              done: false,
              children: [
                { id: task("a1"), text: "A1", done: true, children: [] },
                { text: "A2", done: false, children: [] },
              ],
            },
          ],
        });
        const [a, b] = branch.goal.tasks;
        assert.deepStrictEqual(
          a!.children.map((child) => [child.text, child.done]),
          [
            ["A1", true],
            ["A2", false],
          ],
        );
        assert.strictEqual(b!.id, task("b"));

        const published = yield* PubSub.takeAll(subscription);
        assert.deepStrictEqual(
          published.map((item) => (item.kind === "goal.updated" ? item.goal.title : item.kind)),
          ["Renamed", "Renamed"],
        );
        assert.strictEqual(
          (published.at(-1) as { goal: { tasks: ReadonlyArray<unknown> } }).goal.tasks.length,
          2,
        );
      }),
    ),
  );

  it.effect("reads one goal off the snapshot, null once it is gone", () =>
    Effect.gen(function* () {
      const store = yield* LoomStore.LoomStoreV2;
      const id = GoalId.make("goal:ws-get");
      yield* store.goals.upsert({
        id,
        projectId: ProjectId.make("project:ws"),
        slug: "ws-get",
        title: "Get",
        description: "",
      });
      yield* store.tasks.replaceTree(id, [
        { id: task("get-a"), parentTaskId: null, text: "A", done: false, position: 0 },
      ]);
      const handlers = yield* makeLoomWsHandlers;
      const read = (goalId: GoalId) => handlers[LOOM_WS_METHODS.goalGet]({ goalId });
      const { goal } = yield* read(id);
      assert.deepStrictEqual(
        goal?.tasks.map((node) => node.id),
        [task("get-a")],
      );
      assert.notProperty(goal, "deletedAt");
      assert.isNull((yield* read(GoalId.make("goal:unknown"))).goal);
      yield* store.goals.softDelete(id);
      assert.isNull((yield* read(id)).goal);
    }),
  );

  it.effect("refuses an illegal rewrite and the stubbed drafter methods by name", () =>
    Effect.gen(function* () {
      yield* seedGoal;
      const handlers = yield* makeLoomWsHandlers;
      const wrongRoot = yield* Effect.exit(
        handlers[LOOM_WS_METHODS.goalTaskRewrite]({
          goalId,
          branchTaskId: task("a"),
          tasks: [{ id: task("b"), text: "B", done: false, children: [] }],
        }),
      );
      assert.isTrue(Exit.isFailure(wrongRoot));
      const duplicate = yield* Effect.exit(
        handlers[LOOM_WS_METHODS.goalTaskRewrite]({
          goalId,
          branchTaskId: task("a"),
          tasks: [
            {
              id: task("a"),
              text: "A",
              done: false,
              children: [{ id: task("b"), text: "B", done: false, children: [] }],
            },
          ],
        }),
      );
      assert.isTrue(Exit.isFailure(duplicate));
    }),
  );
});
