/**
 * The goal tools on V2's real orchestrator and `LoomStoreV2`: anchored branch
 * scoping (read, add, tick, rewrite), restoring deleted tasks by resubmission,
 * the unanchored child's rewrite refusal, the owner-only goal_update,
 * and exactly one `goal.updated` on the broadcast per write — none for a
 * refusal or a no-change rewrite.
 */
import { assert, it } from "@effect/vitest";
import { CommandId, GoalId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";

import { flattenGoalTasks } from "../../../../loom/goals/goalTaskTree.ts";
import { LoomGoalBroadcast } from "../../../../loom/projection/LoomGoalBroadcast.ts";
import { LoomStoreV2 } from "../../../../loom/projection/LoomStore.ts";
import { seedThread } from "../../../../loom/testkit/loomOrchestratorLayer.ts";
import * as Orchestrator from "../../../../orchestration-v2/Orchestrator.ts";
import { callAs, HandlerTestLayer, spawnedId } from "./handlers.testkit.ts";

const projectId = ProjectId.make("project:loom-test");

/** A root on a fresh goal, with the broadcast subscribed before any write. */
const goalRoot = Effect.fn("goalTasksTest.goalRoot")(function* (name: string) {
  const root = ThreadId.make(`${name}-root`);
  const goalId = GoalId.make(`goal:${name}`);
  yield* seedThread({ threadId: root });
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
  const subscription = yield* (yield* LoomGoalBroadcast).subscribe;
  /** The goal items published since the last call. */
  const published = PubSub.takeUpTo(subscription, 100);
  return { root, goalId, published };
});

const taskIdOf = (text: string) => text.match(/^Added task (\S+):/)![1]!;

it.layer(HandlerTestLayer)("goal task tools", (it) => {
  it.effect("the owner adds, ticks and rewrites the whole tree; one goal.updated per write", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { root, goalId, published } = yield* goalRoot("owner");
        const phase = taskIdOf((yield* callAs(root, "goal_task_add", { text: "Phase one" })).text);
        const step = taskIdOf(
          (yield* callAs(root, "goal_task_add", { text: "Step", parentTaskId: phase })).text,
        );
        const items = yield* published;
        assert.lengthOf(items, 2);
        assert.isTrue(items.every((item) => item.kind === "goal.updated"));

        const ticked = yield* callAs(root, "goal_task_update", { taskId: step, done: true });
        assert.include(ticked.text, `Updated task ${step}.`);
        assert.lengthOf(yield* published, 1);

        // The listed tree resubmitted verbatim writes (and publishes) nothing.
        const listed = (yield* callAs(root, "goal_task_list", {})).text;
        const same = yield* callAs(root, "goal_tasks_rewrite", { markdown: listed });
        assert.include(same.text, "no changes");
        assert.lengthOf(yield* published, 0);

        const rewritten = yield* callAs(root, "goal_tasks_rewrite", {
          markdown: `${listed}\n- [ ] Phase two`,
        });
        assert.include(rewritten.text, "1 added");
        const [item] = yield* published;
        assert.equal(item?.kind, "goal.updated");
        assert.deepEqual(
          item?.kind === "goal.updated" ? flattenGoalTasks(item.goal.tasks).map((t) => t.text) : [],
          ["Phase one", "Step", "Phase two"],
        );
        assert.lengthOf((yield* (yield* LoomStoreV2).goals.get(goalId))!.tasks, 2);
      }),
    ),
  );

  it.effect(
    "an anchored child reads, adds and ticks inside its branch; elsewhere only by explicit parent",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { root, published } = yield* goalRoot("anchored");
          const mine = taskIdOf((yield* callAs(root, "goal_task_add", { text: "Mine" })).text);
          const theirs = taskIdOf((yield* callAs(root, "goal_task_add", { text: "Theirs" })).text);
          const foreign = taskIdOf(
            (yield* callAs(root, "goal_task_add", { text: "Their step", parentTaskId: theirs }))
              .text,
          );
          const child = spawnedId(
            (yield* callAs(root, "workstream_spawn", {
              role: "coder",
              title: "Branch owner",
              purpose: "Own a branch.",
              anchorTaskId: mine,
            })).text,
          );
          yield* published;

          const branch = (yield* callAs(child, "goal_task_list", {})).text;
          assert.include(branch, `- [ ] Mine (${mine})`);
          assert.notInclude(branch, "Theirs");
          assert.include(
            (yield* callAs(child, "goal_task_list", { scope: "tree" })).text,
            "Theirs",
          );

          // Lands under the anchor by default.
          const added = yield* callAs(child, "goal_task_add", { text: "My step" });
          const myStep = taskIdOf(added.text);
          const tasks = (yield* (yield* LoomStoreV2).goals.get(
            (yield* (yield* LoomStoreV2).getWorkstream(child))!.goalId!,
          ))!.tasks;
          assert.equal(
            flattenGoalTasks(tasks).find((task) => task.id === myStep)?.parentTaskId,
            mine,
          );
          // Any task of the goal is a legal explicit parent; the echo shows where it landed.
          const elsewhere = yield* callAs(child, "goal_task_add", {
            text: "Found for them",
            parentTaskId: theirs,
          });
          assert.include(elsewhere.text, "Recorded outside your branch");
          assert.lengthOf(yield* published, 2);

          // Ticking another branch's task is refused and writes nothing.
          const refused = yield* callAs(child, "goal_task_update", { taskId: foreign, done: true });
          assert.include(refused.text, "outside the branch you own");
          assert.lengthOf(yield* published, 0);
          assert.include(
            (yield* callAs(child, "goal_task_update", { taskId: myStep, done: true })).text,
            `Updated task ${myStep}.`,
          );

          // A branch rewrite naming a foreign id is refused; the branch itself is accepted.
          const reaching = yield* callAs(child, "goal_tasks_rewrite", {
            markdown: `- [ ] Mine (${mine})\n  - [ ] Their step (${foreign})`,
          });
          assert.include(reaching.text, "outside the branch you own");
          const own = yield* callAs(child, "goal_tasks_rewrite", {
            markdown: `- [x] Mine, renamed (${mine})`,
          });
          assert.include(own.text, "1 edited");
          assert.include(own.text, "1 removed");
          assert.lengthOf(yield* published, 2);
          const after = flattenGoalTasks(
            (yield* (yield* LoomStoreV2).goals.get(
              (yield* (yield* LoomStoreV2).getWorkstream(child))!.goalId!,
            ))!.tasks,
          ).map((task) => task.text);
          assert.deepEqual(after, ["Mine, renamed", "Theirs", "Their step", "Found for them"]);
        }),
      ),
  );

  it.effect(
    "an owner's rewrite lists what it removed, and resubmitting those lines restores them",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { root, goalId } = yield* goalRoot("restore");
          const phase = taskIdOf(
            (yield* callAs(root, "goal_task_add", { text: "Phase one" })).text,
          );
          const step = taskIdOf(
            (yield* callAs(root, "goal_task_add", { text: "Step", parentTaskId: phase })).text,
          );
          yield* callAs(root, "goal_task_update", { taskId: step, done: true });
          const kept = taskIdOf((yield* callAs(root, "goal_task_add", { text: "Phase two" })).text);

          // A subtree-only submission wipes the rest, and says exactly what went.
          const wiped = yield* callAs(root, "goal_tasks_rewrite", {
            markdown: `- [ ] Phase two (${kept})`,
          });
          assert.include(wiped.text, "2 removed");
          const removedLines = `- [ ] Phase one (${phase})\n  - [x] Step (${step})`;
          assert.include(wiped.text, `Removed:\n${removedLines}\n`);

          const restored = yield* callAs(root, "goal_tasks_rewrite", {
            markdown: `${removedLines}\n- [ ] Phase two (${kept})`,
          });
          assert.include(restored.text, "2 restored");
          assert.deepEqual(
            flattenGoalTasks((yield* (yield* LoomStoreV2).goals.get(goalId))!.tasks).map((task) => [
              task.id,
              task.parentTaskId,
              task.done,
            ]),
            [
              [phase, null, false],
              [step, phase, true],
              [kept, null, false],
            ],
          );
          // An id that never belonged to the goal is still refused.
          const stranger = yield* callAs(root, "goal_tasks_rewrite", {
            markdown: "- [ ] Ghost (00000000-0000-4000-8000-000000000000)",
          });
          assert.include(stranger.text, "not a task in this goal");
        }),
      ),
  );

  it.effect("an anchored child restores only what was deleted from its own branch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { root, goalId } = yield* goalRoot("restore-branch");
        const mine = taskIdOf((yield* callAs(root, "goal_task_add", { text: "Mine" })).text);
        const myStep = taskIdOf(
          (yield* callAs(root, "goal_task_add", { text: "My step", parentTaskId: mine })).text,
        );
        const theirs = taskIdOf((yield* callAs(root, "goal_task_add", { text: "Theirs" })).text);
        const foreign = taskIdOf(
          (yield* callAs(root, "goal_task_add", { text: "Their step", parentTaskId: theirs })).text,
        );
        const child = spawnedId(
          (yield* callAs(root, "workstream_spawn", {
            role: "coder",
            title: "Branch owner",
            purpose: "Own a branch.",
            anchorTaskId: mine,
          })).text,
        );
        // The owner prunes the foreign step; the child prunes its own.
        yield* callAs(root, "goal_tasks_rewrite", {
          markdown: `- [ ] Mine (${mine})\n  - [ ] My step (${myStep})\n- [ ] Theirs (${theirs})`,
        });
        assert.include(
          (yield* callAs(child, "goal_tasks_rewrite", { markdown: `- [ ] Mine (${mine})` })).text,
          `- [ ] My step (${myStep})`,
        );

        const reaching = yield* callAs(child, "goal_tasks_rewrite", {
          markdown: `- [ ] Mine (${mine})\n  - [ ] Their step (${foreign})`,
        });
        assert.include(reaching.text, "outside the branch you own");
        const back = yield* callAs(child, "goal_tasks_rewrite", {
          markdown: `- [ ] Mine (${mine})\n  - [ ] My step (${myStep})`,
        });
        assert.include(back.text, "1 restored");
        assert.deepEqual(
          flattenGoalTasks((yield* (yield* LoomStoreV2).goals.get(goalId))!.tasks).map(
            (task) => task.id,
          ),
          [mine, myStep, theirs],
        );
      }),
    ),
  );

  it.effect("an unanchored child may add but never rewrite", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { root, published } = yield* goalRoot("unanchored");
        yield* callAs(root, "goal_task_add", { text: "Phase" });
        const child = spawnedId(
          (yield* callAs(root, "workstream_spawn", {
            role: "reviewer",
            title: "Free reviewer",
            purpose: "Review.",
          })).text,
        );
        yield* published;
        const refused = yield* callAs(child, "goal_tasks_rewrite", { markdown: "- [ ] Mine now" });
        assert.isFalse(refused.isError);
        assert.include(refused.text, "this thread has a parent and no anchor");
        assert.lengthOf(yield* published, 0);
        assert.include(
          (yield* callAs(child, "goal_task_add", { text: "Noted" })).text,
          "Added task",
        );
        assert.lengthOf(yield* published, 1);
      }),
    ),
  );

  it.effect(
    "mcp__t3-code__goal_update renames the goal and publishes once; a taken slug is refused",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { root, goalId, published } = yield* goalRoot("update");
          yield* goalRoot("update-other");
          yield* published;
          assert.include(
            (yield* callAs(root, "goal_update", { slug: "update-other" })).text,
            "already used",
          );
          const updated = yield* callAs(root, "goal_update", { title: "Renamed", description: "" });
          assert.include(updated.text, `Updated goal ${goalId}.`);
          const items = yield* published;
          assert.lengthOf(items, 1);
          assert.equal(items[0]?.kind === "goal.updated" ? items[0].goal.title : null, "Renamed");

          // Only the owner may reframe the goal; a child's attempt writes nothing.
          const phase = taskIdOf((yield* callAs(root, "goal_task_add", { text: "Phase" })).text);
          const child = spawnedId(
            (yield* callAs(root, "workstream_spawn", {
              role: "coder",
              title: "Anchored",
              purpose: "Work.",
              anchorTaskId: phase,
            })).text,
          );
          yield* published;
          const refused = yield* callAs(child, "goal_update", { description: "changed by child" });
          assert.include(refused.text, "Only the thread that owns this goal");
          assert.lengthOf(yield* published, 0);
          assert.equal((yield* (yield* LoomStoreV2).goals.get(goalId))!.description, "");
        }),
      ),
  );
});
