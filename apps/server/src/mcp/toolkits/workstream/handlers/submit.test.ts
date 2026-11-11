/**
 * workstream_submit and set_outcome on the real orchestrator: the routing echo per outcome, the
 * terminal, reserved, hold and response-block refusals before any report is written, and the
 * self-issued `done` guard (pending rework, unresolved gate) versus a parent's `done` with the
 * arm's warning.
 */
import { assert, it } from "@effect/vitest";
import { CommandId, GoalId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/sql/SqlClient";

import { LoomStoreV2 } from "../../../../loom/projection/LoomStore.ts";
import {
  NO_RESPONSE_BLOCK,
  SUBMIT_REFUSED_WHILE_HELD,
  SUBMIT_REFUSED_WHILE_RAISED,
} from "../../../../loom/prompt/prose.ts";
import {
  loomEvent,
  seedThread,
  writeEvents,
} from "../../../../loom/testkit/loomOrchestratorLayer.ts";
import * as Orchestrator from "../../../../orchestration-v2/Orchestrator.ts";
import { callAs, HandlerTestLayer, spawnedId } from "./handlers.testkit.ts";

const spawn = (parent: ThreadId, title: string, extra: Record<string, unknown> = {}) =>
  Effect.map(
    callAs(parent, "workstream_spawn", {
      role: "coder",
      title,
      purpose: `Deliver ${title}.`,
      ...extra,
    }),
    (result) => spawnedId(result.text),
  );

const report = (response: string) => `<!-- response -->\n${response}\n<!-- /response -->`;

/** A root with a coder and a reviewer gated on it. */
const gatedPair = (root: ThreadId) =>
  Effect.gen(function* () {
    yield* seedThread({ threadId: root });
    const coder = yield* spawn(root, "Coder");
    const reviewer = yield* spawn(root, "Review", { role: "reviewer", gate: { rework: coder } });
    return { coder, reviewer };
  });

it.layer(HandlerTestLayer)("workstream submit and set_outcome", (it) => {
  it.effect("submit echoes terminal, needs_human and yield, and records the report", () =>
    Effect.gen(function* () {
      const store = yield* LoomStoreV2;
      const root = ThreadId.make("submit-root");
      yield* seedThread({ threadId: root });
      const done = yield* spawn(root, "Done");
      const human = yield* spawn(root, "Human");
      const yielded = yield* spawn(root, "Yielded");

      const terminal = yield* callAs(done, "workstream_submit", {
        markdown: report("# Report"),
        counts: { mustFix: 0, niceToHave: 2 },
        contested: ["a finding I reject"],
      });
      assert.isFalse(terminal.isError, terminal.text);
      assert.include(terminal.text, "outcome done (dependents released)");
      const row = (yield* store.getWorkstream(done))!;
      assert.equal(row.outcome, "done");
      assert.include(terminal.text, row.reportPath!);
      assert.equal(
        yield* (yield* FileSystem.FileSystem).readFileString(row.reportPath!),
        report("# Report"),
      );
      assert.deepEqual(row.lastOutcome?.counts, { mustFix: 0, niceToHave: 2 });
      assert.deepEqual(row.lastOutcome?.contested, ["a finding I reject"]);

      const attention = yield* callAs(human, "workstream_submit", {
        markdown: report("stuck"),
        outcome: "needs_human",
      });
      assert.include(attention.text, "needs_guidance raised");
      assert.include(attention.text, "you are not done");
      assert.deepEqual((yield* store.getWorkstream(human))!.attention, ["needs_guidance"]);

      const yieldEcho = yield* callAs(yielded, "workstream_submit", {
        markdown: report("over to you"),
        outcome: "rework_approach",
      });
      assert.include(yieldEcho.text, "YIELDED to your parent orchestrator: you are NOT done");
      assert.deepEqual((yield* store.getWorkstream(yielded))!.attention, ["awaiting_orchestrator"]);
    }),
  );

  it.effect(
    "an anchored child's submit lists its branch's open lines; ticked or unanchored, none",
    () =>
      Effect.gen(function* () {
        const root = ThreadId.make("branch-root");
        const goalId = GoalId.make("goal:branch");
        yield* seedThread({ threadId: root });
        yield* (yield* LoomStoreV2).goals.upsert({
          id: goalId,
          projectId: ProjectId.make("project:loom-test"),
          slug: "branch",
          title: "Goal branch",
          description: "",
        });
        yield* (yield* Orchestrator.OrchestratorV2).dispatch({
          type: "thread.goal.set",
          commandId: CommandId.make("command:branch:goal-set"),
          threadId: root,
          createdAt: DateTime.formatIso(yield* DateTime.now),
          goalId,
        });
        const add = (text: string, parentTaskId?: string) =>
          Effect.map(
            callAs(root, "goal_task_add", { text, ...(parentTaskId ? { parentTaskId } : {}) }),
            (result) => result.text.match(/^Added task (\S+):/)![1]!,
          );
        const open = yield* add("Build the chip");
        const verify = yield* add("Verify the chip", open);
        const shipped = yield* add("Ship the docs", open);
        const ticked = yield* add("Tidy the copy");
        yield* callAs(root, "goal_task_update", { taskId: shipped, done: true });
        yield* callAs(root, "goal_task_update", { taskId: ticked, done: true });

        const anchored = yield* spawn(root, "Anchored", { anchorTaskId: open });
        const reply = yield* callAs(anchored, "workstream_submit", { markdown: report("done") });
        assert.match(
          reply.text,
          new RegExp(
            `Report: \\S+\\n\\nStill open in your branch; your parent's notice of your completion lists these lines:\\n  Build the chip \\(${open}\\)   your anchor\\n    Verify the chip \\(${verify}\\)$`,
          ),
        );

        const finished = yield* spawn(root, "Finished", { anchorTaskId: ticked });
        const unanchored = yield* spawn(root, "Unanchored");
        for (const thread of [finished, unanchored]) {
          const quiet = yield* callAs(thread, "workstream_submit", { markdown: report("done") });
          assert.match(quiet.text, /^Work submitted: [^\n]+\nReport: \S+$/);
        }
      }),
  );

  it.effect("submit echoes a gate loop as not done and a resolve as done for both", () =>
    Effect.gen(function* () {
      const store = yield* LoomStoreV2;
      const looped = yield* gatedPair(ThreadId.make("loop-root"));
      yield* callAs(looped.coder, "workstream_submit", { markdown: report("code") });
      const loop = yield* callAs(looped.reviewer, "workstream_submit", {
        markdown: report("fix these"),
        outcome: "needs_rework",
        counts: { mustFix: 1, niceToHave: 0 },
      });
      assert.include(
        loop.text,
        "findings routed to the coder for rework (round 1): you are NOT done",
      );
      assert.match(loop.text, /\.round-1\.md$/);
      assert.isNull((yield* store.getWorkstream(looped.reviewer))!.outcome);

      const resolved = yield* gatedPair(ThreadId.make("resolve-root"));
      yield* callAs(resolved.coder, "workstream_submit", { markdown: report("code") });
      const clean = yield* callAs(resolved.reviewer, "workstream_submit", {
        markdown: report("lgtm"),
        outcome: "clean",
      });
      assert.include(clean.text, "the review gate RESOLVED");
      assert.equal((yield* store.getWorkstream(resolved.reviewer))!.outcome, "done");
    }),
  );

  it.effect(
    "a gate over several siblings: rework refusals land before any report; the verdict names the reopened set",
    () =>
      Effect.gen(function* () {
        const store = yield* LoomStoreV2;
        const root = ThreadId.make("trio-root");
        yield* seedThread({ threadId: root });
        const a = yield* spawn(root, "A");
        const b = yield* spawn(root, "B");
        const c = yield* spawn(root, "C");
        const reviewer = yield* spawn(root, "Review", {
          role: "reviewer",
          gate: { rework: [a, b, c] },
        });
        for (const coder of [a, b, c])
          yield* callAs(coder, "workstream_submit", { markdown: report("code") });

        const unnamed = yield* callAs(reviewer, "workstream_submit", {
          markdown: report("fix these"),
          outcome: "needs_rework",
        });
        assert.isTrue(unnamed.isError);
        assert.include(unnamed.text, `any of: ${a}, ${b}, ${c}`);
        const stray = yield* callAs(reviewer, "workstream_submit", {
          markdown: report("fix these"),
          outcome: "needs_rework",
          rework: [a, root],
        });
        assert.isTrue(stray.isError);
        assert.include(stray.text, `rework names ${root}`);
        assert.isNull((yield* store.getWorkstream(reviewer))!.reportPath);

        const loop = yield* callAs(reviewer, "workstream_submit", {
          markdown: report("fix these"),
          outcome: "needs_rework",
          rework: [`thread:${b}`, a],
        });
        assert.isFalse(loop.isError, loop.text);
        assert.include(loop.text, `findings routed to \`${a}\`, \`${b}\` for rework (round 1)`);
        assert.include(loop.text, `not reopened: \`${c}\``);
        assert.include(loop.text, "once all of them have resubmitted");
        assert.deepEqual(
          (yield* store.getWorkstream(reviewer))!.lastRoutes.map((route) => route.to),
          [a, b],
        );
      }),
  );

  it.effect("a report with no non-empty response block is refused before it is written", () =>
    Effect.gen(function* () {
      const store = yield* LoomStoreV2;
      const root = ThreadId.make("block-root");
      yield* seedThread({ threadId: root });
      const child = yield* spawn(root, "Blockless");
      for (const markdown of [
        "## What I did\nAll of it.",
        "<!-- response -->\n<!-- /response -->\nBody.",
      ]) {
        const refused = yield* callAs(child, "workstream_submit", { markdown });
        assert.isTrue(refused.isError);
        assert.equal(refused.text, NO_RESPONSE_BLOCK);
      }
      assert.isNull((yield* store.getWorkstream(child))!.reportPath);
      const accepted = yield* callAs(child, "workstream_submit", { markdown: report("Done.") });
      assert.isFalse(accepted.isError, accepted.text);
      assert.equal((yield* store.getWorkstream(child))!.outcome, "done");
    }),
  );

  it.effect("a submit the arm would refuse leaves the recorded report and its search row", () =>
    Effect.gen(function* () {
      const store = yield* LoomStoreV2;
      const fs = yield* FileSystem.FileSystem;
      const sql = yield* SqlClient.SqlClient;
      const indexed = (threadId: ThreadId) =>
        Effect.map(
          sql<{ readonly text: string }>`SELECT text FROM loom_thread_search
            WHERE thread_id = ${threadId} AND kind = 'report'`,
          (rows) => rows.map((row) => row.text),
        );
      const root = ThreadId.make("refused-root");
      yield* seedThread({ threadId: root });
      const done = yield* spawn(root, "Finished");
      yield* callAs(done, "workstream_submit", { markdown: report("original") });
      const reportPath = (yield* store.getWorkstream(done))!.reportPath!;

      const terminal = yield* callAs(done, "workstream_submit", { markdown: report("revised") });
      assert.isTrue(terminal.isError);
      assert.include(terminal.text, "cannot act on a terminal thread");
      assert.equal(yield* fs.readFileString(reportPath), report("original"));
      assert.deepEqual(yield* indexed(done), [report("original")]);

      const fresh = yield* spawn(root, "Fresh");
      const reserved = yield* callAs(fresh, "workstream_submit", {
        markdown: report("quiet"),
        outcome: "quiescent",
      });
      assert.isTrue(reserved.isError);
      assert.include(reserved.text, "reserved for the server");
      assert.isNull((yield* store.getWorkstream(fresh))!.reportPath);
      assert.deepEqual(yield* indexed(fresh), []);
    }),
  );

  it.effect(
    "D19: a completing submit is refused while a raised hold stands, before any report",
    () =>
      Effect.gen(function* () {
        const store = yield* LoomStoreV2;
        const root = ThreadId.make("d19-root");
        yield* seedThread({ threadId: root });
        const child = yield* spawn(root, "Stuck");
        yield* callAs(root, "workstream_request_attention", {
          threadId: child,
          reason: "needs_guidance",
        });
        const refused = yield* callAs(child, "workstream_submit", { markdown: report("done!") });
        assert.isTrue(refused.isError);
        assert.equal(refused.text, SUBMIT_REFUSED_WHILE_RAISED);
        assert.isNull((yield* store.getWorkstream(child))!.reportPath);
      }),
  );

  it.effect(
    "a held hand-back: one call holds; a plain submit is refused until the human writes; their round dispatches nothing",
    () =>
      Effect.gen(function* () {
        const store = yield* LoomStoreV2;
        const fs = yield* FileSystem.FileSystem;
        const root = ThreadId.make("held-root");
        yield* seedThread({ threadId: root });
        const child = yield* spawn(root, "Brief");

        const selfRaise = yield* callAs(child, "workstream_request_attention", {
          reason: "awaiting_acceptance",
        });
        assert.isTrue(selfRaise.isError);
        assert.deepEqual((yield* store.getWorkstream(child))!.attention, []);

        const held = yield* callAs(child, "workstream_submit", {
          markdown: report("brief v1"),
          outcome: "awaiting_acceptance",
        });
        assert.isFalse(held.isError, held.text);
        assert.include(held.text, "you are held `awaiting_acceptance`");
        const first = (yield* store.getWorkstream(child))!;
        assert.deepEqual(first.attention, ["awaiting_acceptance"]);
        assert.isNull(first.outcome);
        assert.equal(first.lastOutcome?.outcome, "awaiting_acceptance");

        // No human in this turn: completing would release the work behind the hold.
        const early = yield* callAs(child, "workstream_submit", { markdown: report("all done") });
        assert.isTrue(early.isError);
        assert.equal(early.text, SUBMIT_REFUSED_WHILE_HELD);
        assert.equal(yield* fs.readFileString(first.reportPath!), report("brief v1"));

        // The human corrects in the child: the hold stands, and a held re-hand-back only rewrites the report.
        yield* (yield* Orchestrator.OrchestratorV2).dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("held-human-correction"),
          threadId: child,
          messageId: MessageId.make("message:held-human-correction"),
          text: "Rename the second section.",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          dispatchMode: { type: "queue_after_active" },
        });
        assert.deepEqual((yield* store.getWorkstream(child))!.attention, ["awaiting_acceptance"]);
        const again = yield* callAs(child, "workstream_submit", {
          markdown: report("brief v2"),
          outcome: "awaiting_acceptance",
        });
        assert.isFalse(again.isError, again.text);
        assert.include(again.text, "your parent is not told of this round");
        const silent = (yield* store.getWorkstream(child))!;
        assert.deepEqual(silent.lastOutcome, first.lastOutcome);
        assert.equal(yield* fs.readFileString(silent.reportPath!), report("brief v2"));

        // The human approves in the same thread: the plain submit completes and clears the hold.
        const approved = yield* callAs(child, "workstream_submit", { markdown: report("final") });
        assert.isFalse(approved.isError, approved.text);
        const done = (yield* store.getWorkstream(child))!;
        assert.equal(done.outcome, "done");
        assert.deepEqual(done.attention, []);
      }),
  );

  it.effect(
    "set_outcome: a self-issued done is refused in an unresolved gate or with pending rework",
    () =>
      Effect.gen(function* () {
        const store = yield* LoomStoreV2;
        const root = ThreadId.make("outcome-root");
        const { coder, reviewer } = yield* gatedPair(root);
        for (const self of [reviewer, coder]) {
          const refused = yield* callAs(self, "workstream_set_outcome", { outcome: "done" });
          assert.isTrue(refused.isError, self);
          assert.include(refused.text, "part of an active review gate");
        }

        // Pending rework with the gate dissolved (reviewer cancelled) still refuses the coder.
        yield* writeEvents([
          yield* loomEvent("thread.gate-rework-accepted", coder, {
            sourceThreadId: reviewer,
            round: 1,
          }),
        ]);
        yield* callAs(root, "workstream_set_outcome", { threadId: reviewer, outcome: "cancelled" });
        assert.isTrue((yield* store.getWorkstream(coder))!.pendingRework);
        const pending = yield* callAs(coder, "workstream_set_outcome", { outcome: "done" });
        assert.isTrue(pending.isError);

        // The parent's done is allowed, with the arm's mid-round warning.
        const parents = yield* callAs(root, "workstream_set_outcome", {
          threadId: coder,
          outcome: "done",
        });
        assert.isFalse(parents.isError, parents.text);
        assert.include(parents.text, "Warning: ");
        assert.include(parents.text, "review round is open");
        assert.equal((yield* store.getWorkstream(coder))!.outcome, "done");

        const reopened = yield* callAs(root, "workstream_set_outcome", {
          threadId: coder,
          outcome: "none",
        });
        assert.include(reopened.text, "Reopened");
        assert.isNull((yield* store.getWorkstream(coder))!.outcome);
      }),
  );

  it.effect("set_outcome: a parent's done that clears awaiting_acceptance warns (#321)", () =>
    Effect.gen(function* () {
      const store = yield* LoomStoreV2;
      const root = ThreadId.make("acceptance-root");
      yield* seedThread({ threadId: root });
      const held = yield* spawn(root, "Held");
      const plain = yield* spawn(root, "Plain");
      yield* callAs(held, "workstream_submit", {
        markdown: report("please accept"),
        outcome: "awaiting_acceptance",
      });

      const accepted = yield* callAs(root, "workstream_set_outcome", {
        threadId: held,
        outcome: "done",
      });
      assert.isFalse(accepted.isError, accepted.text);
      assert.include(accepted.text, "Warning: It held an `awaiting_acceptance` hold");
      assert.deepEqual((yield* store.getWorkstream(held))!.attention, []);

      // No hold, or no change (already done), no warning.
      for (const threadId of [plain, held]) {
        const quiet = yield* callAs(root, "workstream_set_outcome", { threadId, outcome: "done" });
        assert.notInclude(quiet.text, "Warning:", threadId);
      }
    }),
  );
});
