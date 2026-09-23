/**
 * LOOM-ONLY dev check for task-tree branch scoping
 * (plans/task-tree-branch-scoping/plan.mdx): renders every agent-facing tree
 * surface against a SEEDED read model — the three injection variants, the four
 * echo shapes, and the two `goal_task_list` scopes — and prints each one with
 * its size, so the shapes and their token cost can be eyeballed on real data.
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
import { GoalTaskId, type OrchestrationGoalTask, ThreadId } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";

import * as ServerConfig from "../config.ts";
import { goalTaskSpine, resolveThreadAnchor } from "../orchestration/goalTaskAnchor.loom.ts";
import {
  renderGoalPulse,
  renderGoalTaskBranch,
  renderGoalTaskEcho,
  renderGoalTaskOverview,
  renderGoalTaskTree,
  renderOpenGoalTaskTree,
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

  // The seeded goal is small (5 tasks), so the same surfaces are also rendered
  // against a tree with the retrospective's dimensions (96 tasks, 9 phases, 82
  // done) — the profile the plan's token targets are quoted against.
  const referenceGoal = { ...goalWithTasks, tasks: referenceTree };
  const referenceAnchor = referenceTree[5]!.id;
  yield* Console.log("\n\n########## REFERENCE TREE (96 tasks, 9 phases, 82 done) ##########");
  // Tree renderings alone, so the per-surface ratio is readable independently of
  // the static guidance each injection variant carries.
  const anchorTask = referenceTree[5]!;
  for (const [label, body] of [
    ["whole tree", renderGoalTaskTree(referenceTree).trimEnd()],
    ["open plan (root + unbound echo)", renderOpenGoalTaskTree(referenceTree).trimEnd()],
    ["overview (unbound injection)", renderGoalTaskOverview(referenceTree)],
    [
      "branch + pulse (bound)",
      `${renderGoalTaskBranch(anchorTask, goalTaskSpine(referenceTree, anchorTask.id))}\n\n${renderGoalPulse(referenceTree, anchorTask)}`,
    ],
  ] as const) {
    yield* Console.log(
      `tree-only · ${label}: ${body.length} chars ≈ ${Math.round(body.length / 4)} tokens (${(body.length / renderGoalTaskTree(referenceTree).trimEnd().length).toFixed(2)}× the whole tree)`,
    );
  }
  yield* show(
    "BASELINE · whole tree (today's injection and echo)",
    renderGoalTaskTree(referenceTree).trimEnd(),
  );
  yield* show("INJECTION · root (open plan)", activeGoalContextInstruction(referenceGoal));
  yield* show(
    "INJECTION · bound child (anchor = Phase 6)",
    activeGoalContextInstruction(referenceGoal, {
      asChildBackground: true,
      anchorTaskId: referenceAnchor,
    }),
  );
  yield* show(
    "INJECTION · unbound child (overview)",
    activeGoalContextInstruction(referenceGoal, { asChildBackground: true, anchorTaskId: null }),
  );
  yield* show(
    "ECHO · bound child (branch + pulse)",
    renderGoalTaskEcho({
      summary: "Added task 8a2d40ff: Handle the zero-usage provider rows in the chip",
      tasks: referenceTree,
      anchorTaskId: referenceAnchor,
      isChild: true,
    }),
  );
  yield* show(
    "ECHO · unbound child / root (open plan)",
    renderGoalTaskEcho({
      summary: "Added task …",
      tasks: referenceTree,
      anchorTaskId: null,
      isChild: true,
    }),
  );
});

/** A fabricated tree with the cost retrospective's dimensions. */
const referenceTree = ((): ReadonlyArray<OrchestrationGoalTask> => {
  let seq = 0;
  const task = (
    text: string,
    done: boolean,
    children: ReadonlyArray<OrchestrationGoalTask> = [],
  ): OrchestrationGoalTask =>
    ({
      id: GoalTaskId.make(`0000000${seq}-0000-4000-8000-${String(seq++).padStart(12, "0")}`),
      goalId: "reference",
      parentTaskId: null,
      text,
      done,
      position: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
      children,
    }) as unknown as OrchestrationGoalTask;
  const kids = (count: number, label: string, open: number) =>
    Array.from({ length: count }, (_, index) =>
      task(`${label} work item ${index + 1} of the phase`, index >= open),
    );
  return [
    task("Phase 1: Audit the existing usage pipeline", true, kids(12, "Audit", 0)),
    task("Phase 2: Fix the projection layer", true, kids(14, "Projection", 0)),
    task("Phase 3: Backfill historic usage rows", true, kids(9, "Backfill", 0)),
    task("Phase 4: Per-model price table", true, kids(8, "Pricing", 0)),
    task("Phase 5: Server aggregation endpoints", true, kids(11, "Aggregation", 0)),
    task("Phase 6: Surface usage on the thread screen", false, kids(4, "Thread screen", 3)),
    task("Phase 7: Goal-level rollups", false, kids(8, "Rollup", 3)),
    task("Phase 8: Alerting on runaway threads", true, kids(7, "Alerting", 0)),
    task("Phase 9: Docs and retro", false, kids(2, "Docs", 2)),
  ];
})();

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
