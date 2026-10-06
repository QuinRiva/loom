// @effect-diagnostics nodeBuiltinImport:off - brief and report fixtures are written synchronously at module load.
/**
 * The dispatcher pass on the real orchestrator, sink, SQL projection and
 * receipts (Phase 2's testkit): promotion (smoke steps 1–2), the forkFrom
 * prepare-then-kickoff with its deferral, the review gate's legs (steps 3–4)
 * and the cancel cascade (step 16) — all driven by `WorkstreamDispatcher.runPass`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import { dependenciesSatisfied } from "@t3tools/shared/workstreamStart.loom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ServerConfig from "../../../config.ts";
import { CommandReceiptStoreV2 } from "../../../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import { LoomStoreV2 } from "../../projection/LoomStore.ts";
import {
  completeSeededRun,
  dispatch,
  LoomOrchestratorTestLayer,
  seedRunningRun,
  seedThread,
  spawnChild,
} from "../../testkit/loomOrchestratorLayer.ts";
import { forkPrepareCommandId, kickoffCommandId } from "./controlMessage.ts";
import { WorkstreamDispatcher, WorkstreamDispatcherLive } from "./WorkstreamDispatcher.ts";

const TestLayer = WorkstreamDispatcherLive.pipe(
  Layer.provideMerge(LoomOrchestratorTestLayer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-loom-dispatcher-" })),
  Layer.provide(NodeServices.layer),
);

const createdAt = "2026-01-01T00:00:00.000Z";
const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "loom-dispatcher-pass-"));
const writeFile = (name: string, text: string) => {
  const path = NodePath.join(dir, name);
  NodeFS.writeFileSync(path, text);
  return path;
};

const runPass = Effect.flatMap(WorkstreamDispatcher, (d) => d.runPass);
const row = (threadId: ThreadId) =>
  Effect.flatMap(LoomStoreV2, (store) => Effect.map(store.getWorkstream(threadId), (r) => r!));
const receipt = (id: string) =>
  Effect.flatMap(CommandReceiptStoreV2, (receipts) =>
    Effect.map(receipts.getByCommandId(CommandId.make(id)), Option.getOrNull),
  );
const messages = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    Effect.map(orchestrator.getThreadProjection(threadId), (projection) => projection.messages),
  );
const setBrief = (threadId: ThreadId, path: string) =>
  dispatch({
    type: "thread.kickoff-brief.set",
    commandId: CommandId.make(`pass-brief:${threadId}`),
    threadId,
    createdAt,
    kickoffBriefPath: path,
  });
let submits = 0;
const submit = (threadId: ThreadId, outcome?: string, reportPath?: string) =>
  dispatch({
    type: "thread.work.submit",
    commandId: CommandId.make(`pass-submit:${++submits}`),
    threadId,
    createdAt,
    reportPath: reportPath ?? `/reports/${threadId}-${submits}.md`,
    ...(outcome === undefined ? {} : { outcome }),
  });

it.layer(TestLayer)("WorkstreamDispatcher pass", (it) => {
  it.effect("promotion: briefed, unblocked children are kicked off exactly once", () =>
    Effect.gen(function* () {
      const [root, a, b, held, unbriefed, dependent, unreadable] = [
        "promo-root",
        "promo-a",
        "promo-b",
        "promo-held",
        "promo-unbriefed",
        "promo-dependent",
        "promo-unreadable",
      ].map((id) => ThreadId.make(id));
      yield* seedThread({ threadId: root! });
      for (const child of [a!, b!, unbriefed!, unreadable!]) {
        yield* spawnChild({ parentThreadId: root!, threadId: child, graphKey: child });
      }
      yield* spawnChild({ parentThreadId: root!, threadId: held!, graphKey: "held", held: true });
      yield* spawnChild({
        parentThreadId: root!,
        threadId: dependent!,
        graphKey: "dependent",
        blockedBy: [a!],
      });
      for (const child of [a!, b!, held!, dependent!]) {
        yield* setBrief(child, writeFile(`${child}.md`, `Brief for ${child}.`));
      }
      yield* setBrief(unreadable!, NodePath.join(dir, "missing-brief.md"));

      yield* runPass;
      for (const child of [a!, b!]) {
        assert.isNotNull((yield* row(child)).kickoffAt);
        assert.equal((yield* receipt(kickoffCommandId(child)))?.status, "accepted");
        const [kickoff] = yield* messages(child);
        assert.equal(kickoff?.id, MessageId.make(`message:${kickoffCommandId(child)}`));
        assert.equal(kickoff?.text, `Brief for ${child}.`);
        assert.equal(kickoff?.loom?.origin, "kickoff");
        assert.isUndefined(kickoff?.loom?.controlPayload);
      }
      for (const child of [held!, unbriefed!, dependent!, unreadable!]) {
        assert.isNull((yield* row(child)).kickoffAt);
        assert.isNull(yield* receipt(kickoffCommandId(child)));
      }
      // An unreadable brief parks the child for a human instead of launching it empty.
      assert.deepEqual((yield* row(unreadable!)).attention, ["needs_guidance"]);

      // A second pass sends nothing.
      const before = (yield* messages(a!)).length + (yield* messages(b!)).length;
      yield* runPass;
      assert.equal((yield* messages(a!)).length + (yield* messages(b!)).length, before);

      // The dependency releases once its sibling is done.
      yield* submit(a!);
      assert.equal((yield* row(a!)).outcome, "done");
      yield* runPass;
      assert.isNotNull((yield* row(dependent!)).kickoffAt);
      assert.equal((yield* receipt(kickoffCommandId(dependent!)))?.status, "accepted");
    }),
  );

  it.effect("forkFrom: fork.prepare defers while the source runs, then precedes the kickoff", () =>
    Effect.gen(function* () {
      const [root, source, fork, orphanSource, orphanFork] = [
        "fork-root",
        "fork-source",
        "fork-child",
        "fork-orphan-source",
        "fork-orphan-child",
      ].map((id) => ThreadId.make(id));
      yield* seedThread({ threadId: root! });
      yield* spawnChild({ parentThreadId: root!, threadId: source!, graphKey: "source" });
      // As the spawn handler does: forkFrom implies a dependency on the source.
      yield* spawnChild({
        parentThreadId: root!,
        threadId: fork!,
        graphKey: "fork",
        forkFromThreadId: source!,
        blockedBy: [source!],
        kickoffBriefPath: writeFile("fork.md", "Fork brief."),
      });
      yield* seedRunningRun({ threadId: source!, live: true });
      // The source hands back from inside its still-running turn.
      yield* submit(source!);
      assert.equal((yield* row(source!)).outcome, "done");

      yield* runPass;
      assert.isNull(yield* receipt(forkPrepareCommandId(fork!)));
      assert.isNull((yield* row(fork!)).kickoffAt);

      yield* completeSeededRun({ threadId: source! });
      yield* runPass;
      assert.equal((yield* receipt(forkPrepareCommandId(fork!)))?.status, "accepted");
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const transfers = (yield* orchestrator.getThreadProjection(fork!)).contextTransfers;
      assert.deepEqual(
        transfers.map((t) => [t.type, t.sourceThreadId, t.status]),
        [["fork", source!, "pending"]],
      );
      assert.isNotNull((yield* row(fork!)).kickoffAt);
      assert.equal((yield* receipt(kickoffCommandId(fork!)))?.status, "accepted");
      const prepareAt = (yield* receipt(forkPrepareCommandId(fork!)))!.resultSequence;
      const kickoffAt = (yield* receipt(kickoffCommandId(fork!)))!.resultSequence;
      assert.isBelow(prepareAt, kickoffAt);

      // A source with nothing to fork is refused: a dead episode, and no kickoff, ever.
      yield* spawnChild({
        parentThreadId: root!,
        threadId: orphanSource!,
        graphKey: "orphan-source",
      });
      yield* spawnChild({
        parentThreadId: root!,
        threadId: orphanFork!,
        graphKey: "orphan-fork",
        forkFromThreadId: orphanSource!,
        blockedBy: [orphanSource!],
        kickoffBriefPath: writeFile("orphan-fork.md", "Orphan fork brief."),
      });
      yield* submit(orphanSource!);
      yield* runPass;
      yield* runPass;
      assert.equal((yield* receipt(forkPrepareCommandId(orphanFork!)))?.status, "rejected");
      assert.isNull((yield* row(orphanFork!)).kickoffAt);
      assert.isNull(yield* receipt(kickoffCommandId(orphanFork!)));
    }),
  );

  it.effect("the review gate's legs are pass output and carry their notice kinds", () =>
    Effect.gen(function* () {
      const [parent, coder, reviewer, dependent] = [
        "gate-parent",
        "gate-coder",
        "gate-reviewer",
        "gate-dependent",
      ].map((id) => ThreadId.make(id));
      const leg = (round: number, kind: "rework" | "reverify" | "resolve") =>
        `server:workstream-gate:${reviewer}:${round}:${kind}`;
      const controlNotices = (threadId: ThreadId) =>
        Effect.map(messages(threadId), (all) =>
          all.filter((message) => message.loom?.origin === "control_notice"),
        );
      const dependentReleased = Effect.gen(function* () {
        const store = yield* LoomStoreV2;
        const siblings = yield* store.listChildren(parent!, { includeArchived: true });
        const byId = new Map(siblings.map((s) => [s.threadId, { ...s, id: s.threadId }]));
        return dependenciesSatisfied(byId.get(dependent!)!, byId);
      });

      yield* seedThread({ threadId: parent! });
      yield* spawnChild({ parentThreadId: parent!, threadId: coder!, graphKey: "coder" });
      yield* spawnChild({
        parentThreadId: parent!,
        threadId: reviewer!,
        graphKey: "reviewer",
        role: "reviewer",
        blockedBy: [coder!],
        routes: [
          { on: ["needs_rework"], kind: "loop", to: coder! },
          { on: ["clean"], kind: "resolve" },
        ],
      });
      yield* spawnChild({
        parentThreadId: parent!,
        threadId: dependent!,
        graphKey: "dependent",
        blockedBy: [coder!],
      });
      yield* setBrief(coder!, writeFile("gate-coder.md", "Build it."));
      yield* runPass; // kicks off the coder
      yield* submit(coder!);
      yield* setBrief(reviewer!, writeFile("gate-reviewer.md", "Review it."));
      yield* runPass; // the coder is done: kicks off the reviewer
      assert.isNotNull((yield* row(reviewer!)).kickoffAt);

      // The reviewer loops: the pass reopens the coder with a gate-rework notice.
      const findings = writeFile("gate-findings.md", "FINDING_ONE: fix the null guard.");
      yield* submit(reviewer!, "needs_rework", findings);
      yield* runPass;
      assert.equal((yield* receipt(leg(1, "rework")))?.status, "accepted");
      assert.isTrue((yield* row(coder!)).pendingRework);
      const [rework] = yield* controlNotices(coder!);
      assert.equal(rework?.id, MessageId.make(`message:${leg(1, "rework")}`));
      assert.equal(rework?.loom?.controlPayload?.notice, "gate-rework");
      assert.include(rework?.text ?? "", "Review round 1");
      assert.include(rework?.text ?? "", findings);
      assert.include(rework?.text ?? "", "FINDING_ONE: fix the null guard.");
      assert.include(rework?.text ?? "", "mcp__t3-code__workstream_submit");
      assert.isFalse(yield* dependentReleased);

      // The coder hands back: the loop-back re-verifies the reviewer.
      yield* submit(coder!);
      yield* runPass;
      assert.equal((yield* receipt(leg(1, "reverify")))?.status, "accepted");
      const reverify = yield* controlNotices(reviewer!);
      assert.lengthOf(reverify, 1);
      assert.equal(reverify[0]?.loom?.controlPayload?.notice, "gate-reverify");

      // The reviewer passes: resolve finishes both; the dependent is released.
      yield* submit(reviewer!, "clean");
      yield* runPass;
      assert.equal((yield* receipt(leg(1, "resolve")))?.status, "accepted");
      assert.equal((yield* row(coder!)).outcome, "done");
      assert.isFalse((yield* row(coder!)).pendingRework);
      assert.isTrue(yield* dependentReleased);
    }),
  );

  it.effect("the cancel cascade runs in the pass and is not re-sent", () =>
    Effect.gen(function* () {
      const [a, b, c] = ["cascade-a", "cascade-b", "cascade-c"].map((id) => ThreadId.make(id));
      yield* seedThread({ threadId: a! });
      yield* spawnChild({ parentThreadId: a!, threadId: b! });
      yield* spawnChild({ parentThreadId: b!, threadId: c! });
      yield* seedRunningRun({ threadId: b!, live: true });
      yield* seedRunningRun({ threadId: c!, live: true });
      yield* dispatch({
        type: "thread.outcome.set",
        commandId: CommandId.make("cascade-cancel-a"),
        threadId: a!,
        createdAt,
        outcome: "cancelled",
      });
      yield* runPass;
      const cancelEvent = (yield* row(a!)).outcomeEventId!;
      for (const threadId of [b!, c!]) {
        assert.equal((yield* row(threadId)).outcome, "cancelled");
        assert.equal(
          (yield* receipt(`server:loom:cascade-cancel:${cancelEvent}:${threadId}`))?.status,
          "accepted",
        );
      }
      const before = (yield* row(c!)).updatedAt;
      yield* runPass;
      assert.equal((yield* row(c!)).updatedAt, before);
    }),
  );
});
