// @effect-diagnostics nodeBuiltinImport:off - brief and report fixtures are written synchronously at module load.
/**
 * The dispatcher pass on the real orchestrator, sink, SQL projection and
 * receipts (Phase 2's testkit): promotion (smoke steps 1–2), the forkFrom
 * prepare-then-kickoff with its deferral, the review gate's legs (steps 3–4)
 * and the cancel cascade (step 16) — all driven by `WorkstreamDispatcher.runPass`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, EventId, MessageId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import { dependenciesSatisfied } from "@t3tools/shared/workstreamStart.loom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ServerConfig from "../../../config.ts";
import { CommandReceiptStoreV2 } from "../../../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import { notifyDeliveryCommand } from "../../../mcp/toolkits/workstream/handlers/notify.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { kickoffText } from "../../prompt/childPrompt.ts";
import { LoomStoreV2 } from "../../projection/LoomStore.ts";
import {
  completeOpenRuns,
  completeSeededRun,
  dispatch,
  LoomOrchestratorTestLayer,
  seedRunningRun,
  seedThread,
  spawnChild,
  writeEvents,
} from "../../testkit/loomOrchestratorLayer.ts";
import {
  attentionCommandId,
  forkPrepareCommandId,
  kickoffCommandId,
  notifyCommandId,
  notifyExpireCommandId,
  notifyMarkCommandId,
  yieldCommandId,
} from "./controlMessage.ts";
import { WorkstreamDispatcher, WorkstreamDispatcherLive } from "./WorkstreamDispatcher.ts";

const TestLayer = WorkstreamDispatcherLive.pipe(
  Layer.provideMerge(LoomOrchestratorTestLayer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-loom-dispatcher-" })),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(NodeServices.layer),
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
const projection = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.getThreadProjection(threadId),
  );
const messages = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    Effect.map(orchestrator.getThreadProjection(threadId), (projection) => projection.messages),
  );
const withPayload = (threadId: ThreadId, kind: "digest" | "yield" | "notice", notice?: string) =>
  Effect.map(messages(threadId), (all) =>
    all.filter(
      (message) =>
        message.loom?.controlPayload?.kind === kind &&
        (notice === undefined || message.loom.controlPayload.notice === notice),
    ),
  );
/** A second dispatcher instance on the same database: proves no in-memory state is load-bearing. */
const runFreshPass = Effect.scoped(
  Effect.flatMap(
    Layer.build(WorkstreamDispatcherLive),
    (context) => Context.get(context, WorkstreamDispatcher).runPass,
  ),
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
        // The same first turn mcp__t3-code__workstream_prompt sends (DL-472).
        assert.equal(kickoff?.text, kickoffText({ role: "coder", brief: `Brief for ${child}.` }));
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
      // Held, so it never owes a brief-needed notice that would carry the digest instead.
      yield* spawnChild({
        parentThreadId: parent!,
        threadId: dependent!,
        graphKey: "dependent",
        blockedBy: [coder!],
        held: true,
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

      // The parent heard nothing of the legs; the resolution reaches it as one digest item.
      yield* runPass;
      const parentNotices = yield* controlNotices(parent!);
      assert.isEmpty(
        parentNotices.filter((m) => m.loom?.controlPayload?.notice?.startsWith("gate-")),
      );
      const digests = parentNotices.filter((m) => m.loom?.controlPayload?.kind === "digest");
      assert.lengthOf(digests, 1);
      const items = digests[0]!.loom!.controlPayload!.items;
      assert.deepEqual(
        items.filter((item) => item.kind === "gate-resolved").map((item) => item.threadId),
        [reviewer!],
      );
      assert.deepInclude(
        items.find((item) => item.threadId === coder),
        { kind: "terminal" },
      );
      for (const party of [reviewer!, coder!])
        assert.include(digests[0]!.text, (yield* row(party)).reportPath!);
      yield* runPass;
      assert.lengthOf(
        (yield* controlNotices(parent!)).filter((m) => m.loom?.controlPayload?.kind === "digest"),
        1,
      );
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
  it.effect("FYI digest: deferred while the parent runs, then ONE coalesced card, once", () =>
    Effect.gen(function* () {
      const [root, a, b] = ["digest-root", "digest-a", "digest-b"].map((id) => ThreadId.make(id));
      yield* seedThread({ threadId: root! });
      yield* spawnChild({ parentThreadId: root!, threadId: a!, graphKey: "a" });
      yield* spawnChild({ parentThreadId: root!, threadId: b!, graphKey: "b" });
      yield* seedRunningRun({ threadId: root!, live: true });
      yield* submit(a!, undefined, "/reports/digest-a.md");
      yield* submit(b!, undefined, "/reports/digest-b.md");

      yield* runPass;
      assert.isEmpty(yield* withPayload(root!, "digest"));
      const deferred = yield* Effect.flatMap(WorkstreamDispatcher, (d) => d.deferredWakes);
      assert.equal(deferred.get(root!)?.get("digest"), 2);

      yield* completeSeededRun({ threadId: root! });
      yield* runPass;
      const [digest, ...rest] = yield* withPayload(root!, "digest");
      assert.isEmpty(rest);
      assert.equal(digest?.loom?.origin, "control_notice");
      assert.isDefined(digest?.notification);
      const items = digest!.loom!.controlPayload!.items;
      assert.deepEqual(
        items.map((item) => [item.kind, item.threadId, item.reportPath]),
        [
          ["terminal", a!, "/reports/digest-a.md"],
          ["terminal", b!, "/reports/digest-b.md"],
        ],
      );
      assert.include(digest!.text, "/reports/digest-a.md");
      assert.include(digest!.text, "/reports/digest-b.md");

      yield* runPass;
      yield* runFreshPass;
      assert.lengthOf(yield* withPayload(root!, "digest"), 1);

      // A new completion is news; a and b are not (the stored digest says so, not memory).
      const c = ThreadId.make("digest-c");
      yield* spawnChild({ parentThreadId: root!, threadId: c, graphKey: "c" });
      yield* submit(c);
      yield* completeOpenRuns(root!);
      yield* runFreshPass;
      const later = (yield* withPayload(root!, "digest")).find((m) => m.id !== digest!.id);
      assert.deepEqual(
        later?.loom?.controlPayload?.items.map((item) => item.threadId),
        [c],
      );
    }),
  );

  it.effect("advise: a slow-tool advisory joins the next digest once", () =>
    Effect.gen(function* () {
      const [root, child] = ["advise-root", "advise-child"].map((id) => ThreadId.make(id));
      yield* seedThread({ threadId: root! });
      yield* spawnChild({ parentThreadId: root!, threadId: child!, graphKey: "child" });
      yield* setBrief(child!, writeFile("advise-child.md", "Run the long build."));
      yield* runPass; // kicked off: the workstream is busy, so the advisory flushes by age
      const dispatcher = yield* WorkstreamDispatcher;
      const advice = {
        parentId: root!,
        item: {
          kind: "slow-tool" as const,
          threadId: child!,
          title: "Still executing",
          excerpt: "⏳ coder `advise-child` still executing — SLOW_TOOL_LINE",
        },
        episodeKey: `slow-tool:${child}:1`,
        episodeStartedAt: "1969-12-31T23:50:00.000Z",
      };
      yield* dispatcher.advise(advice);
      yield* dispatcher.advise(advice);
      yield* runPass;
      const [digest, ...rest] = yield* withPayload(root!, "digest");
      assert.isEmpty(rest);
      assert.deepEqual(
        digest!.loom!.controlPayload!.items.map((item) => [item.kind, item.threadId]),
        [["slow-tool", child!]],
      );
      assert.include(digest!.text, "SLOW_TOOL_LINE");

      // The sweep re-advises the same episode: the stored digest already carries it,
      // so the next digest (the child's completion) does not repeat it.
      yield* dispatcher.advise(advice);
      yield* submit(child!);
      yield* completeOpenRuns(root!);
      yield* runPass;
      const later = (yield* withPayload(root!, "digest")).filter((m) => m.id !== digest!.id);
      assert.deepEqual(
        later.map((m) => m.loom!.controlPayload!.items.map((item) => [item.kind, item.threadId])),
        [[["terminal", child!]]],
      );
    }),
  );

  it.effect("yield: one steered card into the running parent; the child's flag stands", () =>
    Effect.gen(function* () {
      const [root, child] = ["yield-root", "yield-child"].map((id) => ThreadId.make(id));
      yield* seedThread({ threadId: root! });
      yield* spawnChild({ parentThreadId: root!, threadId: child!, graphKey: "child" });
      const { runId } = yield* seedRunningRun({ threadId: root!, live: true });
      yield* submit(child!, "rework_approach", writeFile("yield-report.md", "YIELD_EXCERPT"));
      const lastOutcome = (yield* row(child!)).lastOutcome!;
      assert.equal(lastOutcome.decision, "yield");

      yield* runPass;
      const [card, ...rest] = yield* withPayload(root!, "yield");
      assert.isEmpty(rest);
      assert.equal(
        card?.id,
        MessageId.make(`message:${yieldCommandId(child!, lastOutcome.eventId!)}`),
      );
      assert.equal(card?.loom?.origin, "control_notice");
      assert.isUndefined(card?.loom?.controlPayload?.synthesised);
      for (const fragment of [
        "YIELD_EXCERPT",
        "`mcp__t3-code__workstream_set_outcome` done",
        "`mcp__t3-code__workstream_prompt`",
        "`mcp__t3-code__workstream_set_outcome` cancelled",
      ])
        assert.include(card?.text ?? "", fragment);
      // Upstream's conversion steered it into the running turn: no queued run behind it.
      assert.equal(card?.runId, runId);
      assert.isEmpty((yield* projection(root!)).runs.filter((run) => run.status === "queued"));
      assert.deepEqual((yield* row(child!)).attention, ["awaiting_orchestrator"]);

      yield* runPass;
      assert.lengthOf(yield* withPayload(root!, "yield"), 1);
    }),
  );

  it.effect("attention: one notice per raise episode; a re-raise is a new episode", () =>
    Effect.gen(function* () {
      const [root, child] = ["attn-root", "attn-child"].map((id) => ThreadId.make(id));
      yield* seedThread({ threadId: root! });
      yield* spawnChild({ parentThreadId: root!, threadId: child!, graphKey: "child" });
      let commands = 0;
      const attention = (type: "thread.attention.raise" | "thread.attention.clear") =>
        dispatch({
          type,
          commandId: CommandId.make(`attn-${++commands}`),
          threadId: child!,
          createdAt,
          reason: "needs_guidance",
        });
      const notices = withPayload(root!, "notice", "attention");

      yield* attention("thread.attention.raise");
      const first = (yield* row(child!)).attentionEpisodes.needs_guidance!;
      yield* runPass;
      yield* runPass;
      const [notice, ...rest] = yield* notices;
      assert.isEmpty(rest);
      assert.equal(
        notice?.id,
        MessageId.make(`message:${attentionCommandId(child!, "needs_guidance", first)}`),
      );
      assert.include(notice?.text ?? "", "paused and needs attention");
      assert.deepEqual((yield* row(child!)).attention, ["needs_guidance"]);

      yield* attention("thread.attention.clear");
      yield* attention("thread.attention.raise");
      assert.notEqual((yield* row(child!)).attentionEpisodes.needs_guidance, first);
      yield* runPass;
      assert.lengthOf(yield* notices, 2);
    }),
  );

  it.effect("notify: a pending record becomes one notify message and leaves the queue", () =>
    Effect.gen(function* () {
      const [root, target] = ["notify-root", "notify-target"].map((id) => ThreadId.make(id));
      yield* seedThread({ threadId: root! });
      yield* spawnChild({ parentThreadId: root!, threadId: target!, graphKey: "target" });
      yield* dispatch({
        type: "thread.peer-message.record",
        commandId: CommandId.make("notify-record-1"),
        threadId: root!,
        createdAt,
        recordId: "notify-rec-1",
        targetThreadId: target!,
        targetTitle: "Target",
        message: "Heads up.",
        framedMessage: "[notify from root] Heads up.",
      });
      const store = yield* LoomStoreV2;
      assert.lengthOf(yield* store.peerMessages.listPending(), 1);

      yield* runPass;
      const delivered = (yield* messages(target!)).filter((m) => m.loom?.origin === "notify");
      assert.deepEqual(
        delivered.map((m) => [m.id, m.text, m.loom?.controlPayload?.notice]),
        [
          [
            MessageId.make("message:server:workstream-notify:notify-rec-1"),
            "[notify from root] Heads up.",
            "notify",
          ],
        ],
      );
      assert.isEmpty(yield* store.peerMessages.listPending());
      yield* runPass;
      assert.lengthOf(
        (yield* messages(target!)).filter((m) => m.loom?.origin === "notify"),
        1,
      );
    }),
  );

  it.effect(
    "notify: a record mcp__t3-code__notify_thread already delivered is a receipted no-op for the rail",
    () =>
      Effect.gen(function* () {
        const [root, target] = ["notify-race-root", "notify-race-target"].map((id) =>
          ThreadId.make(id),
        );
        yield* seedThread({ threadId: root! });
        yield* spawnChild({ parentThreadId: root!, threadId: target!, graphKey: "target" });
        yield* dispatch({
          type: "thread.peer-message.record",
          commandId: CommandId.make("notify-race-record"),
          threadId: root!,
          createdAt,
          recordId: "notify-race-rec",
          targetThreadId: target!,
          targetTitle: "Target",
          message: "Heads up.",
          framedMessage: "[notify from root] Heads up.",
        });
        // The handler's immediate send landed; its mark-delivered had not when the pass read the queue.
        yield* dispatch(
          notifyDeliveryCommand({
            recordId: "notify-race-rec",
            senderThreadId: root!,
            senderTitle: "Root",
            targetThreadId: target!,
            framedMessage: "[notify from root] Heads up.",
          }),
        );
        const receipt = yield* (yield* CommandReceiptStoreV2).getByCommandId(
          CommandId.make(notifyCommandId("notify-race-rec")),
        );

        yield* runPass;
        const delivered = (yield* messages(target!)).filter((m) => m.loom?.origin === "notify");
        assert.lengthOf(delivered, 1);
        // The handler's message, not a second one built by the rail.
        const payload = delivered[0]!.loom?.controlPayload;
        assert.equal(payload?.kind === "notice" ? payload.items?.[0]?.title : null, "From Root");
        assert.deepEqual(
          yield* (yield* CommandReceiptStoreV2).getByCommandId(
            CommandId.make(notifyCommandId("notify-race-rec")),
          ),
          receipt,
        );
        // Marked delivered (the replay counts as landed), never expired.
        const receipts = yield* CommandReceiptStoreV2;
        assert.isTrue(
          Option.isSome(
            yield* receipts.getByCommandId(CommandId.make(notifyMarkCommandId("notify-race-rec"))),
          ),
        );
        assert.isTrue(
          Option.isNone(
            yield* receipts.getByCommandId(
              CommandId.make(notifyExpireCommandId("notify-race-rec")),
            ),
          ),
        );
        assert.isEmpty(yield* (yield* LoomStoreV2).peerMessages.listPending());
      }),
  );

  it.effect(
    "steer promotion: a Loom message queued before the turn was up steers once it is; a human's stays queued",
    () =>
      Effect.gen(function* () {
        const target = ThreadId.make("promote-steer-target");
        yield* seedThread({ threadId: target });
        const ids = yield* seedRunningRun({ threadId: target, live: true, turn: false });
        const queue = (id: string, loom: boolean) =>
          dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(id),
            threadId: target,
            messageId: MessageId.make(`message:${id}`),
            text: id,
            attachments: [],
            createdBy: loom ? "agent" : "user",
            creationSource: loom ? "mcp" : "web",
            dispatchMode: { type: "queue_after_active" },
            ...(loom ? { loom: { origin: "orchestrator" as const } } : {}),
          });
        yield* queue("early-correction", true);
        yield* queue("human-follow-up", false);
        const statuses = Effect.map(projection(target), (p) => p.runs.map((run) => run.status));
        assert.deepEqual(yield* statuses, ["running", "queued", "queued"]);

        // No running provider turn yet: nothing moves.
        yield* runPass;
        assert.deepEqual(yield* statuses, ["running", "queued", "queued"]);

        // The adapter reports its turn: the Loom message steers into it, the human's waits.
        const now = yield* DateTime.now;
        yield* writeEvents([
          {
            id: EventId.make("event:promote-steer:turn"),
            type: "provider-turn.updated",
            threadId: target,
            runId: ids.runId,
            nodeId: ids.nodeId,
            occurredAt: now,
            payload: {
              id: ids.providerTurnId,
              providerThreadId: ids.providerThreadId,
              nodeId: ids.nodeId,
              runAttemptId: ids.attemptId,
              nativeTurnRef: null,
              ordinal: 1,
              status: "running",
              startedAt: now,
              completedAt: null,
            },
          },
        ]);
        yield* runPass;
        const after = yield* projection(target);
        assert.deepEqual(
          after.runs.map((run) => run.status),
          ["running", "cancelled", "queued"],
        );
        const byText = (text: string) => after.messages.find((m) => m.text === text);
        assert.equal(byText("early-correction")?.runId, ids.runId);
        assert.equal(byText("early-correction")?.loom?.origin, "orchestrator");
        assert.notEqual(byText("human-follow-up")?.runId, ids.runId);
      }),
  );

  it.effect("imported rows (null episode stamps) wake nobody", () =>
    Effect.gen(function* () {
      const [root, done, yielded, flagged] = [
        "import-root",
        "import-done",
        "import-yielded",
        "import-flagged",
      ].map((id) => ThreadId.make(id));
      yield* seedThread({ threadId: root! });
      for (const child of [done!, yielded!, flagged!])
        yield* spawnChild({ parentThreadId: root!, threadId: child, graphKey: child });
      yield* submit(done!);
      yield* submit(yielded!, "rework_approach");
      yield* dispatch({
        type: "thread.attention.raise",
        commandId: CommandId.make("import-flag"),
        threadId: flagged!,
        createdAt,
        reason: "needs_guidance",
      });
      // As Phase 4's importer writes them: no outcome-recorded id, no raise episode.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE loom_thread_workstream
        SET last_outcome = json_set(last_outcome, '$.eventId', json('null')),
            attention_episodes = '{}'
        WHERE thread_id IN (${done!}, ${yielded!}, ${flagged!})`;
      assert.isNull((yield* row(done!)).lastOutcome?.eventId);

      yield* runPass;
      yield* runPass;
      const wakes = (yield* messages(root!)).filter((m) => {
        const payload = m.loom?.controlPayload;
        return (
          payload?.kind === "digest" || payload?.kind === "yield" || payload?.notice === "attention"
        );
      });
      assert.isEmpty(wakes);
    }),
  );
});
