/**
 * `t3 goal` end to end through the real CLI against a temp home: a goal
 * created on a project, a task added and ticked, the tree rewritten from the
 * markdown `show` prints — all landing in `LoomStoreV2`.
 */
// @effect-diagnostics nodeBuiltinImport:off - CLI integration uses temporary Node paths.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { GoalId } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { Command } from "effect/cli";

import { cli } from "../binCli.ts";
import * as ServerConfig from "../config.ts";
import { renderGoalTaskTree } from "../loom/goals/goalTaskRender.ts";
import { flattenGoalTasks } from "../loom/goals/goalTaskTree.ts";
import * as LoomStore from "../loom/projection/LoomStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";

const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer)),
  );

/** Every goal in the home's database, read back through the store. */
const readGoals = (baseDir: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* LoomStore.LoomStoreV2;
    const ids = yield* sql<{ readonly id: GoalId }>`SELECT goal_id AS id FROM loom_goals`;
    return yield* Effect.forEach(ids, ({ id }) => store.goals.get(id));
  }).pipe(
    Effect.provide(
      LoomStore.layer.pipe(
        Layer.provideMerge(SqlitePersistence.layerConfig),
        Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );

it.effect("t3 goal create / task add / task done / task rewrite land in LoomStoreV2", () =>
  Effect.gen(function* () {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-loom-goal-cli-"));
    const workspaceRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-loom-goal-ws-"));
    const at = ["--base-dir", baseDir];
    yield* runCli(["project", "add", workspaceRoot, "--title", "Alpha", ...at]);
    yield* runCli(
      ["goal", "create", "--project", workspaceRoot, "--slug", "rollups"].concat([
        "--title",
        "Usage rollups",
        ...at,
      ]),
    );
    yield* runCli(["goal", "task", "add", "rollups", "Design the query", ...at]);
    const [created] = yield* readGoals(baseDir);
    assert.equal(created?.title, "Usage rollups");
    const [task] = flattenGoalTasks(created!.tasks);
    assert.equal(task?.text, "Design the query");

    yield* runCli(["goal", "task", "done", "rollups", task!.id, ...at]);
    const [ticked] = yield* readGoals(baseDir);
    assert.isTrue(flattenGoalTasks(ticked!.tasks)[0]?.done);

    const file = NodePath.join(baseDir, "tree.md");
    NodeFS.writeFileSync(file, `${renderGoalTaskTree(ticked!.tasks)}  - [ ] Ship it\n`);
    yield* runCli(["goal", "task", "rewrite", "rollups", "--file", file, ...at]);
    const [rewritten] = yield* readGoals(baseDir);
    assert.deepEqual(
      flattenGoalTasks(rewritten!.tasks).map((entry) => [entry.text, entry.parentTaskId]),
      [
        ["Design the query", null],
        ["Ship it", task!.id],
      ],
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
