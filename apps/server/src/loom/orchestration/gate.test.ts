/**
 * t-gate (plan §7): a review gate's legs move through the re-drive pass alone —
 * the reviewer's loop reopens the coder with a control message, the coder's
 * loop-back re-verifies the reviewer, the reviewer's resolve finishes both — on
 * the real orchestrator, sink, SQL projection and receipts.
 */
import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import { isEligibleToStart } from "@t3tools/shared/workstreamStart.loom";
import * as Effect from "effect/Effect";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import { LoomStoreV2 } from "../projection/LoomStore.ts";
import {
  dispatch,
  LoomOrchestratorTestLayer,
  seedThread,
  spawnChild,
} from "../testkit/loomOrchestratorLayer.ts";
import { fixedGateLeg, runReDrivePass } from "./redrive.ts";

const createdAt = "2026-01-01T00:00:00.000Z";
const parent = ThreadId.make("gate-parent");
const coder = ThreadId.make("gate-coder");
const reviewer = ThreadId.make("gate-reviewer");
const dependent = ThreadId.make("gate-dependent");

const kickoff = (threadId: ThreadId) =>
  dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`server:test-kickoff:${threadId}`),
    threadId,
    messageId: MessageId.make(`message:kickoff:${threadId}`),
    text: "Your brief.",
    attachments: [],
    createdBy: "agent",
    creationSource: "server",
    dispatchMode: { type: "queue_after_active" },
    loom: { origin: "kickoff" },
  });
let submits = 0;
const submit = (threadId: ThreadId, outcome?: string) =>
  dispatch({
    type: "thread.work.submit",
    commandId: CommandId.make(`gate-submit:${++submits}`),
    threadId,
    createdAt,
    reportPath: `/reports/${threadId}-${submits}.md`,
    ...(outcome === undefined ? {} : { outcome }),
  });
const leg = (round: number, kind: "rework" | "reverify" | "resolve") =>
  CommandId.make(`server:workstream-gate:${reviewer}:${round}:${kind}`);

it.layer(LoomOrchestratorTestLayer)("Loom review gate", (it) => {
  it.effect("t-gate: rework, reverify and resolve legs are re-drive output", () =>
    Effect.gen(function* () {
      const store = yield* LoomStoreV2;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const pass = runReDrivePass(fixedGateLeg);
      const row = (threadId: ThreadId) => Effect.map(store.getWorkstream(threadId), (r) => r!);
      const dependentEligible = Effect.gen(function* () {
        const siblings = yield* store.listChildren(parent, { includeArchived: true });
        const byId = new Map(siblings.map((s) => [s.threadId, { ...s, id: s.threadId }]));
        return isEligibleToStart(byId.get(dependent)!, byId);
      });
      const controlNotices = (threadId: ThreadId) =>
        Effect.map(orchestrator.getThreadProjection(threadId), (projection) =>
          projection.messages.filter((message) => message.loom?.origin === "control_notice"),
        );

      yield* seedThread({ threadId: parent });
      yield* spawnChild({ parentThreadId: parent, threadId: coder, graphKey: "coder" });
      yield* spawnChild({
        parentThreadId: parent,
        threadId: reviewer,
        graphKey: "reviewer",
        role: "reviewer",
        blockedBy: [coder],
        routes: [
          { on: ["needs_rework"], kind: "loop", to: coder },
          { on: ["clean"], kind: "resolve" },
        ],
      });
      yield* spawnChild({
        parentThreadId: parent,
        threadId: dependent,
        graphKey: "dependent",
        blockedBy: [coder],
      });
      yield* dispatch({
        type: "thread.kickoff-brief.set",
        commandId: CommandId.make("gate-dependent-brief"),
        threadId: dependent,
        createdAt,
        kickoffBriefPath: "/briefs/dependent.md",
      });

      yield* kickoff(coder);
      yield* submit(coder);
      assert.equal((yield* row(coder)).outcome, "done");
      assert.isTrue(yield* dependentEligible);
      yield* kickoff(reviewer);

      // The reviewer loops: the pass reopens the coder with a queued control notice.
      yield* submit(reviewer, "needs_rework");
      assert.equal((yield* row(reviewer)).lastRoute?.kind, "loop");
      assert.deepEqual((yield* pass).accepted, [leg(1, "rework")]);
      const reopened = yield* row(coder);
      assert.isNull(reopened.outcome);
      assert.isTrue(reopened.pendingRework);
      const rework = yield* controlNotices(coder);
      assert.deepEqual(
        rework.map((message) => message.id),
        [MessageId.make(`message:${leg(1, "rework")}`)],
      );
      const reworkRun = (yield* orchestrator.getThreadProjection(coder)).runs.find(
        (run) => run.userMessageId === rework[0]!.id,
      );
      assert.equal(reworkRun?.status, "queued"); // queue_after_active behind the coder's running turn
      assert.isFalse(yield* dependentEligible);

      // The coder hands back: an intercepted target loops back to its reviewer.
      yield* submit(coder);
      assert.equal((yield* row(coder)).lastRoute?.kind, "loop-back");
      assert.deepEqual((yield* pass).accepted, [leg(1, "reverify")]);
      assert.lengthOf(yield* controlNotices(reviewer), 1);

      // The reviewer passes: resolve finishes the reviewer, the pass finishes the coder.
      yield* submit(reviewer, "clean");
      assert.equal((yield* row(reviewer)).outcome, "done");
      assert.deepEqual((yield* pass).accepted, [leg(1, "resolve")]);
      assert.equal((yield* row(coder)).outcome, "done");
      assert.isFalse((yield* row(coder)).pendingRework);
      assert.isTrue(yield* dependentEligible);
      assert.deepEqual(yield* pass, { accepted: [], deferred: [], dead: [] });
    }),
  );
});
