/**
 * LOOM-ONLY dev check for task-tree branch scoping
 * (plans/task-tree-branch-scoping/plan.mdx): renders every agent-facing tree
 * surface against a SEEDED read model — the three injection variants, the four
 * echo shapes, and the two `goal_task_list` scopes — and prints each one with
 * its size, so the shapes and their token cost can be eyeballed on real data.
 * (The plan's token ratios were measured against a fabricated 96-task tree; that
 * one-shot scaffolding is recorded in the implementation report, not kept here.)
 *
 * Run: `T3CODE_HOME=<scratch> node apps/server/src/dev/verifyBranchScoping.ts`
 * (after `seedWorkstream.ts` against the same home).
 *
 * @module dev/verifyBranchScoping
 */
// Dev-only fixture tooling (not shipped); see seedWorkstream.ts.
// @effect-diagnostics globalErrorInEffectFailure:off preferSchemaOverJson:off
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { GoalTaskId, ThreadId } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";

import * as ServerConfig from "../config.ts";
import { goalTaskSpine, resolveThreadAnchor } from "../orchestration/goalTaskAnchor.loom.ts";
import {
  renderGoalTaskBranch,
  renderGoalTaskEcho,
  renderGoalTaskTree,
} from "../orchestration/goalTaskRender.ts";
import { activeGoalContextInstruction } from "../orchestration/Layers/ProviderCommandReactor.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { buildSeedConfig } from "./seedConfig.ts";

const ORCHESTRATOR_ID = ThreadId.make("seed-thread-orchestrator");
const BOUND_ID = ThreadId.make("seed-thread-coder-alpha");
const UNBOUND_ID = ThreadId.make("seed-thread-coder-beta");

const show = (label: string, body: string) =>
  Console.log(
    `\n===== ${label} — ${body.length} chars ≈ ${Math.round(body.length / 4)} tokens =====\n${body}`,
  );

const program = Effect.gen(function* () {
  const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const snapshot = yield* query.getSnapshot();
  const goal = snapshot.goals.find((entry) => entry.tasks.length > 0)!;
  const threadOf = (id: ThreadId) => snapshot.threads.find((thread) => thread.id === id)!;
  const bound = threadOf(BOUND_ID);
  const anchor = resolveThreadAnchor(goal.tasks, bound.anchorTaskId)!;
  const goalWithTasks = {
    ...goal,
    tasks: (yield* query.getGoalById(goal.id)).pipe(
      Option.map((value) => value.tasks),
      Option.getOrElse(() => goal.tasks),
    ),
  };

  yield* Console.log(
    `goal ${goal.id} (${goal.slug}) · bound thread ${bound.id} anchored to ${anchor.id} ("${anchor.text}")`,
  );

  yield* show("INJECTION · root (open plan)", activeGoalContextInstruction(goalWithTasks));
  yield* show(
    "INJECTION · bound child (spine + branch + pulse)",
    activeGoalContextInstruction(goalWithTasks, {
      asChildBackground: true,
      anchorTaskId: bound.anchorTaskId,
    }),
  );
  yield* show(
    "INJECTION · unbound child (overview)",
    activeGoalContextInstruction(goalWithTasks, {
      asChildBackground: true,
      anchorTaskId: threadOf(UNBOUND_ID).anchorTaskId,
    }),
  );

  yield* show(
    "LIST · scope branch (bound thread)",
    renderGoalTaskBranch(anchor, goalTaskSpine(goal.tasks, anchor.id)),
  );
  yield* show(
    "LIST · scope tree (complete, the root's rewrite source)",
    renderGoalTaskTree(goal.tasks).trimEnd(),
  );

  const echo = (input: Parameters<typeof renderGoalTaskEcho>[0]) => renderGoalTaskEcho(input);
  yield* show(
    "ECHO · bound child, in-branch update",
    echo({
      summary: `Updated task ${anchor.id}.`,
      tasks: goal.tasks,
      anchorTaskId: bound.anchorTaskId,
      isChild: true,
    }),
  );
  yield* show(
    "ECHO · bound child, out-of-branch add (placement spine)",
    echo({
      summary: `Added task 00000000-0000-4000-8000-000000000001: Capture real turn checkpoints for the diff scope`,
      tasks: goal.tasks,
      anchorTaskId: bound.anchorTaskId,
      isChild: true,
      placedTaskId: GoalTaskId.make("00000000-0000-4000-8000-000000000001"),
    }),
  );
  yield* show(
    "ECHO · unbound child (open plan)",
    echo({ summary: "Added task …", tasks: goal.tasks, anchorTaskId: null, isChild: true }),
  );
  yield* show(
    "ECHO · root (open plan + not-rewrite-input footer)",
    echo({
      summary: "Rewrote the task tree: 1 edited.",
      tasks: goal.tasks,
      anchorTaskId: null,
      isChild: false,
    }),
  );
  yield* show(
    "BASELINE · whole tree, as every surface rendered it before",
    renderGoalTaskTree(goal.tasks).trimEnd(),
  );
});

const main = Effect.gen(function* () {
  const config = yield* buildSeedConfig;
  yield* program.pipe(
    Effect.provide(
      OrchestrationLayerLive.pipe(
        Layer.provideMerge(RepositoryIdentityResolver.layer),
        Layer.provideMerge(SqlitePersistenceLayerLive),
        Layer.provideMerge(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error")),
      ),
    ),
  );
}).pipe(Effect.provide(NodeServices.layer));

if (import.meta.main) {
  NodeRuntime.runMain(main);
}
