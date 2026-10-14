/**
 * The emergent goal (P3-16) on the real orchestrator with a stub generator: a
 * goal-less root gets `goal:emergent:<threadId>` (published, attached under
 * `server:loom:emergent-goal:<threadId>`) once; run 1 needs a confident answer,
 * a forced derivation (run 2, or a goal tool) takes the best guess; a child or a `/retro`
 * reviewer never derives one; a goal set while the generation runs is never overwritten.
 */
import { assert, it } from "@effect/vitest";
import { CommandId, GoalId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";

import { CommandReceiptStoreV2 } from "../../orchestration-v2/CommandReceiptStore.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { RETRO_REVIEWER_ROLE } from "../handoff/retroDraft.ts";
import * as LoomGoalBroadcast from "../projection/LoomGoalBroadcast.ts";
import { LoomStoreV2 } from "../projection/LoomStore.ts";
import {
  dispatch,
  LoomOrchestratorTestLayer,
  seedThread,
  spawnChild,
} from "../testkit/loomOrchestratorLayer.ts";
import {
  deriveEmergentGoal,
  EmergentGoalGenerator,
  emergentGoalCommandId,
  emergentGoalId,
} from "./EmergentGoalReactor.ts";

let confidence: "high" | "low" = "high";
const prompts: Array<string> = [];
/** Runs inside the stub generation: a writer racing the model call. */
let duringGeneration: Effect.Effect<void> = Effect.void;
const generatorLayer = Layer.succeed(EmergentGoalGenerator, {
  generate: (input) =>
    Effect.sync(() => prompts.push(input.prompt)).pipe(
      Effect.andThen(Effect.suspend(() => duringGeneration)),
      Effect.as({
        goal: { title: "Fix the flaky login test", description: "Make login CI green." },
        confidence,
      }),
    ),
});
const TestLayer = Layer.mergeAll(LoomGoalBroadcast.layer, generatorLayer).pipe(
  Layer.provideMerge(LoomOrchestratorTestLayer),
);

const talk = (threadId: ThreadId) =>
  dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`emergent-talk:${threadId}`),
    threadId,
    messageId: MessageId.make(`message:emergent-talk:${threadId}`),
    text: "The login test fails one run in five; find out why and fix it.",
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
    createdBy: "user",
    creationSource: "web",
  });

it.layer(TestLayer)("Loom emergent goal", (it) => {
  it.effect("a goal-less root gets one emergent goal; children and later runs never do", () =>
    Effect.gen(function* () {
      const store = yield* LoomStoreV2;
      const receipts = yield* CommandReceiptStoreV2;
      const broadcast = yield* LoomGoalBroadcast.LoomGoalBroadcast;
      const published = yield* broadcast.subscribe;

      const root = ThreadId.make("emergent-root");
      yield* seedThread({ threadId: root });
      yield* talk(root);

      // Run 1 needs a confident answer.
      confidence = "low";
      yield* deriveEmergentGoal({ threadId: root, force: false });
      assert.isNull(yield* store.goals.get(emergentGoalId(root)));
      assert.include(prompts[0], "The login test fails one run in five");

      // Run 2 takes the best guess.
      yield* deriveEmergentGoal({ threadId: root, force: true });
      const goal = (yield* store.goals.get(emergentGoalId(root)))!;
      assert.deepInclude(goal, {
        slug: "fix-the-flaky-login-test",
        title: "Fix the flaky login test",
        description: "Make login CI green.",
      });
      assert.equal((yield* store.getWorkstream(root))!.goalId, goal.id);
      const receipt = yield* receipts.getByCommandId(emergentGoalCommandId(root));
      assert.equal(Option.getOrThrow(receipt).status, "accepted");
      const item = yield* PubSub.take(published);
      assert.equal(item.kind === "goal.updated" ? item.goal.id : null, goal.id);

      // At most once: a goal is never re-derived.
      yield* deriveEmergentGoal({ threadId: root, force: true });
      assert.lengthOf(prompts, 2);

      // A child inherits its parent's goal.
      confidence = "high";
      const child = ThreadId.make("emergent-child");
      yield* spawnChild({ parentThreadId: root, threadId: child });
      yield* deriveEmergentGoal({ threadId: child, force: true });
      assert.lengthOf(prompts, 2);
      assert.isNull(yield* store.goals.get(emergentGoalId(child)));

      // A `/retro` reviewer root is goal-less by design, forced or not.
      const reviewer = ThreadId.make("emergent-retro");
      yield* spawnChild({ parentThreadId: null, threadId: reviewer, role: RETRO_REVIEWER_ROLE });
      yield* talk(reviewer);
      yield* deriveEmergentGoal({ threadId: reviewer, force: true });
      assert.lengthOf(prompts, 2);
      assert.isNull((yield* store.getWorkstream(reviewer))!.goalId);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "never overwrites a goal set while the generation runs, and writes no orphan goal",
    () =>
      Effect.gen(function* () {
        const store = yield* LoomStoreV2;
        const orchestrator = yield* OrchestratorV2;
        const root = ThreadId.make("emergent-raced-root");
        yield* seedThread({ threadId: root });
        yield* talk(root);
        const chosen = yield* store.goals.upsert({
          id: GoalId.make("goal:chosen-meanwhile"),
          projectId: ProjectId.make("project:loom-test"),
          slug: "chosen-meanwhile",
          title: "Chosen meanwhile",
          description: "",
        });
        const setChosen = orchestrator
          .dispatch({
            type: "thread.goal.set",
            commandId: CommandId.make(`goal-set-meanwhile:${root}`),
            threadId: root,
            createdAt: DateTime.formatIso(yield* DateTime.now),
            goalId: chosen.id,
          })
          .pipe(Effect.orDie, Effect.asVoid);
        duringGeneration = setChosen;
        yield* deriveEmergentGoal({ threadId: root, force: true }).pipe(
          Effect.ensuring(Effect.sync(() => (duringGeneration = Effect.void))),
        );
        assert.equal((yield* store.getWorkstream(root))!.goalId, chosen.id);
        assert.isNull(yield* store.goals.get(emergentGoalId(root)));

        // The orchestrator's own guard: an emergent set on a thread with a goal is a no-op.
        yield* store.goals.upsert({
          id: emergentGoalId(root),
          projectId: ProjectId.make("project:loom-test"),
          slug: "late-emergent",
          title: "Late emergent",
          description: "",
        });
        yield* dispatch({
          type: "thread.goal.set",
          commandId: emergentGoalCommandId(root),
          threadId: root,
          createdAt: DateTime.formatIso(yield* DateTime.now),
          goalId: emergentGoalId(root),
        });
        assert.equal((yield* store.getWorkstream(root))!.goalId, chosen.id);
      }),
  );
});
