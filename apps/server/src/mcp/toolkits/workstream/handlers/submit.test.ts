/**
 * workstream_submit and workstream_set_outcome on V2's real orchestrator: the
 * routing echo for terminal / loop / resolve / needs_human / yield, the D19
 * refusal before any report is written, and the self-issued `done` guard
 * (pending rework, unresolved gate) against a parent's `done` with the arm's
 * warning.
 */
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { LoomStoreV2 } from "../../../../loom/projection/LoomStore.ts";
import { SUBMIT_REFUSED_WHILE_RAISED } from "../../../../loom/prompt/prose.ts";
import {
  loomEvent,
  seedThread,
  writeEvents,
} from "../../../../loom/testkit/loomOrchestratorLayer.ts";
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
        markdown: "# Report",
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
        "# Report",
      );
      assert.deepEqual(row.lastOutcome?.counts, { mustFix: 0, niceToHave: 2 });
      assert.deepEqual(row.lastOutcome?.contested, ["a finding I reject"]);

      const attention = yield* callAs(human, "workstream_submit", {
        markdown: "stuck",
        outcome: "needs_human",
      });
      assert.include(attention.text, "needs_guidance raised");
      assert.include(attention.text, "you are not done");
      assert.deepEqual((yield* store.getWorkstream(human))!.attention, ["needs_guidance"]);

      const yieldEcho = yield* callAs(yielded, "workstream_submit", {
        markdown: "over to you",
        outcome: "rework_approach",
      });
      assert.include(yieldEcho.text, "YIELDED to your parent orchestrator — you are NOT done");
      assert.deepEqual((yield* store.getWorkstream(yielded))!.attention, ["awaiting_orchestrator"]);
    }),
  );

  it.effect("submit echoes a gate loop as not done and a resolve as done for both", () =>
    Effect.gen(function* () {
      const store = yield* LoomStoreV2;
      const looped = yield* gatedPair(ThreadId.make("loop-root"));
      yield* callAs(looped.coder, "workstream_submit", { markdown: "code" });
      const loop = yield* callAs(looped.reviewer, "workstream_submit", {
        markdown: "fix these",
        outcome: "needs_rework",
        counts: { mustFix: 1, niceToHave: 0 },
      });
      assert.include(
        loop.text,
        "findings routed to the coder for rework (round 1) — you are NOT done",
      );
      assert.match(loop.text, /\.round-1\.md$/);
      assert.isNull((yield* store.getWorkstream(looped.reviewer))!.outcome);

      const resolved = yield* gatedPair(ThreadId.make("resolve-root"));
      yield* callAs(resolved.coder, "workstream_submit", { markdown: "code" });
      const clean = yield* callAs(resolved.reviewer, "workstream_submit", {
        markdown: "lgtm",
        outcome: "clean",
      });
      assert.include(clean.text, "the review gate RESOLVED");
      assert.equal((yield* store.getWorkstream(resolved.reviewer))!.outcome, "done");
    }),
  );

  it.effect(
    "D19: a completing submit is refused while a raised hold stands, before any report",
    () =>
      Effect.gen(function* () {
        const store = yield* LoomStoreV2;
        const root = ThreadId.make("d19-root");
        yield* seedThread({ threadId: root });
        const child = yield* spawn(root, "Held");
        const raised = yield* callAs(child, "workstream_request_attention", {
          reason: "awaiting_acceptance",
        });
        assert.isFalse(raised.isError, raised.text);

        const refused = yield* callAs(child, "workstream_submit", { markdown: "done!" });
        assert.isTrue(refused.isError);
        assert.equal(refused.text, SUBMIT_REFUSED_WHILE_RAISED);
        assert.isNull((yield* store.getWorkstream(child))!.reportPath);

        const yielded = yield* callAs(child, "workstream_submit", {
          markdown: "please accept",
          outcome: "blocked",
        });
        assert.include(yielded.text, "YIELDED");
        assert.include((yield* store.getWorkstream(child))!.attention, "awaiting_acceptance");
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
});
