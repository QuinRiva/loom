// @effect-diagnostics nodeBuiltinImport:off - brief fixtures are written and the synthesised report read synchronously.
/**
 * The quiescence rail on the real orchestrator (smoke steps 3, 6, 9): a quiet
 * control-started child gets a synthesised report and yields; a human-started
 * turn under the null human grace, and a child with a live child, do not; a
 * quiet gate coder mid-rework yields and is never looped to its reviewer.
 * The control grace is 0 through the settings layer, so "past grace" is now.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ServerConfig from "../../../config.ts";
import { CommandReceiptStoreV2 } from "../../../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { LoomStoreV2 } from "../../projection/LoomStore.ts";
import {
  completeOpenRuns,
  dispatch,
  LoomOrchestratorTestLayer,
  seedThread,
  spawnChild,
} from "../../testkit/loomOrchestratorLayer.ts";
import { quiescentSubmitCommandId } from "./controlMessage.ts";
import { formatGrace } from "./quiescenceRail.ts";
import { WorkstreamDispatcher, WorkstreamDispatcherLive } from "./WorkstreamDispatcher.ts";

const TestLayer = WorkstreamDispatcherLive.pipe(
  Layer.provideMerge(LoomOrchestratorTestLayer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-loom-quiescence-" })),
  Layer.provide(ServerSettings.layerTest({ quiescenceGraceMs: 0 })),
  Layer.provide(NodeServices.layer),
);

const createdAt = "2026-01-01T00:00:00.000Z";
const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "loom-quiescence-rail-"));
const brief = (threadId: ThreadId) => {
  const path = NodePath.join(dir, `${threadId}.md`);
  NodeFS.writeFileSync(path, `Brief for ${threadId}.`);
  return dispatch({
    type: "thread.kickoff-brief.set",
    commandId: CommandId.make(`quiet-brief:${threadId}`),
    threadId,
    createdAt,
    kickoffBriefPath: path,
  });
};
const runPass = Effect.flatMap(WorkstreamDispatcher, (d) => d.runPass);
const row = (threadId: ThreadId) =>
  Effect.flatMap(LoomStoreV2, (store) => Effect.map(store.getWorkstream(threadId), (r) => r!));
const receipt = (id: string) =>
  Effect.flatMap(CommandReceiptStoreV2, (receipts) =>
    Effect.map(receipts.getByCommandId(CommandId.make(id)), Option.getOrNull),
  );
const projection = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (o) => o.getThreadProjection(threadId));
const yields = (threadId: ThreadId) =>
  Effect.map(projection(threadId), (p) =>
    p.messages.filter((message) => message.loom?.controlPayload?.kind === "yield"),
  );
let submits = 0;
const submit = (threadId: ThreadId, outcome?: string) =>
  dispatch({
    type: "thread.work.submit",
    commandId: CommandId.make(`quiet-submit:${++submits}`),
    threadId,
    createdAt,
    reportPath: `/reports/${threadId}-${submits}.md`,
    ...(outcome === undefined ? {} : { outcome }),
  });

it.layer(TestLayer)("quiescence rail", (it) => {
  it("formatGrace renders the header's words", () => {
    assert.equal(formatGrace(600_000), "10 minutes");
    assert.equal(formatGrace(60_000), "1 minute");
    assert.equal(formatGrace(0), "0 minutes");
    assert.equal(formatGrace(45_000), "45 seconds");
  });

  it.effect("a quiet control-started child gets a synthesised report and yields", () =>
    Effect.gen(function* () {
      const [root, child] = ["quiet-root", "quiet-x"].map((id) => ThreadId.make(id));
      yield* seedThread({ threadId: root! });
      yield* spawnChild({ parentThreadId: root!, threadId: child!, graphKey: "x" });
      yield* brief(child!);
      yield* runPass; // kickoff
      const run = (yield* completeOpenRuns(child!, "X_LAST_WORDS: three findings."))!;

      yield* runPass; // quiescence
      const id = quiescentSubmitCommandId(child!, run.id);
      assert.equal((yield* receipt(id))?.status, "accepted");
      const quiet = yield* row(child!);
      assert.deepInclude(quiet.lastOutcome, { outcome: "quiescent", synthesised: true });
      assert.deepEqual(quiet.attention, ["awaiting_orchestrator"]);
      assert.isNull(quiet.outcome);
      assert.match(quiet.reportPath!, /quiet-x\.quiescent-.+\.md$/);
      const report = NodeFS.readFileSync(quiet.reportPath!, "utf8");
      assert.isTrue(
        report.startsWith(
          "> **Synthesised report.** This thread ended its turn without calling `mcp__t3-code__workstream_submit`.\n> The control plane wrote this file from its last assistant message after 0 minutes of silence\n> and yielded it to the parent. Nothing below was written as a hand-back.\n\nX_LAST_WORDS",
        ),
      );

      yield* runPass; // the yield rail sees the raise
      const [card] = yield* yields(root!);
      assert.isTrue(card?.loom?.controlPayload?.synthesised);
      assert.include(card?.text ?? "", "went quiet");
      assert.include(card?.text ?? "", "X_LAST_WORDS");
      yield* runPass;
      assert.lengthOf(yield* yields(root!), 1);
    }),
  );

  it.effect("a human-started last turn and a child with a live child are not candidates", () =>
    Effect.gen(function* () {
      const [root, human, lead, grandchild] = [
        "quiet-root-2",
        "quiet-human",
        "quiet-lead",
        "quiet-grandchild",
      ].map((id) => ThreadId.make(id));
      yield* seedThread({ threadId: root! });
      yield* spawnChild({ parentThreadId: root!, threadId: human!, graphKey: "human" });
      yield* dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("quiet-human-turn"),
        threadId: human!,
        messageId: MessageId.make("message:quiet-human-turn"),
        text: "A composer message",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "queue_after_active" },
      });
      yield* spawnChild({ parentThreadId: root!, threadId: lead!, graphKey: "lead" });
      yield* spawnChild({ parentThreadId: lead!, threadId: grandchild!, graphKey: "g" });
      yield* brief(lead!);
      yield* runPass; // kicks off the lead
      const humanRun = (yield* completeOpenRuns(human!))!;
      const leadRun = (yield* completeOpenRuns(lead!))!;

      yield* runPass;
      yield* runPass;
      assert.isTrue((yield* projection(human!)).messages.at(-1)?.loom?.humanAuthored);
      for (const [threadId, run] of [
        [human!, humanRun],
        [lead!, leadRun],
      ] as const) {
        assert.isNull(yield* receipt(quiescentSubmitCommandId(threadId, run.id)));
        assert.deepEqual((yield* row(threadId)).attention, []);
      }
      assert.lengthOf(yield* yields(root!), 0);
    }),
  );

  it.effect("a quiet gate coder in rework yields; the reviewer gets no reverify leg", () =>
    Effect.gen(function* () {
      const [root, coder, reviewer] = ["quiet-gate-root", "quiet-coder", "quiet-reviewer"].map(
        (id) => ThreadId.make(id),
      );
      yield* seedThread({ threadId: root! });
      yield* spawnChild({ parentThreadId: root!, threadId: coder!, graphKey: "coder" });
      yield* spawnChild({
        parentThreadId: root!,
        threadId: reviewer!,
        graphKey: "reviewer",
        role: "reviewer",
        blockedBy: [coder!],
        routes: [
          { on: ["needs_rework"], kind: "loop", to: coder! },
          { on: ["clean"], kind: "resolve" },
        ],
      });
      yield* brief(coder!);
      yield* runPass; // kicks off the coder
      yield* submit(coder!);
      yield* completeOpenRuns(coder!);
      yield* brief(reviewer!);
      yield* runPass; // kicks off the reviewer (left running: never a candidate)
      yield* submit(reviewer!, "needs_rework");
      yield* runPass; // the rework leg reopens the coder
      assert.isTrue((yield* row(coder!)).pendingRework);
      const reworkRun = (yield* completeOpenRuns(coder!))!; // the coder ends its rework turn without submitting

      yield* runPass; // quiescence
      assert.equal(
        (yield* receipt(quiescentSubmitCommandId(coder!, reworkRun.id)))?.status,
        "accepted",
      );
      const quiet = yield* row(coder!);
      assert.equal(quiet.lastOutcome?.decision, "yield");
      assert.deepEqual(quiet.attention, ["awaiting_orchestrator"]);
      assert.isTrue(quiet.pendingRework);
      yield* runPass;
      yield* runPass;
      assert.isNull(yield* receipt(`server:workstream-gate:${reviewer}:1:reverify`));
      assert.isEmpty(
        (yield* projection(reviewer!)).messages.filter(
          (message) => message.loom?.origin === "control_notice",
        ),
      );
      const [card] = yield* yields(root!);
      assert.isTrue(card?.loom?.controlPayload?.synthesised);
      assert.include(card?.text ?? "", "the gate is parked");
    }),
  );
});
