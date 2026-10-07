/**
 * mcp__t3-code__notify_thread and mcp__t3-code__consult_thread on V2's real orchestrator. Notify: one
 * direct message with origin `notify` under the rail's shared id, the record
 * marked delivered, steer-or-queue never an abort, terminal targets refused
 * by the record before anything is sent, and the hourly cap counted from the
 * ledger even for a sender without a sidecar row. Consult: the session file
 * is the provider thread's strong pi `nativeThreadRef` (the fork transport is
 * stubbed), a weak or non-pi ref is refused loudly, and an ambiguous name
 * returns candidates without consulting.
 */
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  GoalId,
  ProjectId,
  ProviderDriverKind,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitWorkflowService from "../../../../git/GitWorkflowService.ts";
import { LoomStoreV2 } from "../../../../loom/projection/LoomStore.ts";
import {
  dispatch,
  seedRunningRun,
  seedThread,
  testModelSelection,
  writeEvents,
} from "../../../../loom/testkit/loomOrchestratorLayer.ts";
import { type ConsultForkInput, LoomThreadConsult } from "../../../../loom/workstream/consult.ts";
import * as Orchestrator from "../../../../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../../../../orchestration-v2/ThreadLaunchService.ts";
import { callAs, makeHandlerTestLayer } from "./handlers.testkit.ts";

const asked: Array<ConsultForkInput> = [];

const TestLayer = makeHandlerTestLayer(
  Layer.mergeAll(
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
    Layer.mock(GitWorkflowService.GitWorkflowService)({}),
    Layer.succeed(
      LoomThreadConsult,
      LoomThreadConsult.of({
        ask: (input) =>
          Effect.sync(() => {
            asked.push(input);
            return { answer: "The session settled on option B." };
          }),
      }),
    ),
  ),
);

const messagesOf = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    Effect.map(orchestrator.getThreadRecords(threadId, ["messages"]), ({ messages }) => messages),
  );

/** A root with a sidecar row (via its goal), so outcomes can be set on it. */
const rootWithRow = Effect.fn("notifyTest.rootWithRow")(function* (name: string) {
  const threadId = ThreadId.make(name);
  const goalId = GoalId.make(`goal:${name}`);
  yield* seedThread({ threadId, title: `Thread ${name}` });
  yield* (yield* LoomStoreV2).goals.upsert({
    id: goalId,
    projectId: ProjectId.make("project:loom-test"),
    slug: name,
    title: name,
    description: "",
  });
  yield* dispatch({
    type: "thread.goal.set",
    commandId: CommandId.make(`command:${name}:goal-set`),
    threadId,
    createdAt: DateTime.formatIso(yield* DateTime.now),
    goalId,
  });
  return threadId;
});

/** A provider thread on `threadId` with the given native session ref. */
const seedProviderThread = Effect.fn("consultTest.seedProviderThread")(function* (
  threadId: ThreadId,
  ref: { readonly driver: string; readonly nativeId: string; readonly strength: "strong" | "weak" },
) {
  const now = yield* DateTime.now;
  yield* writeEvents([
    {
      id: EventId.make(`event:consult-test:provider-thread:${threadId}`),
      type: "provider-thread.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: ProviderThreadId.make(`provider-thread:consult:${threadId}`),
        driver: ProviderDriverKind.make(ref.driver),
        providerInstanceId: testModelSelection.instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: { ...ref, driver: ProviderDriverKind.make(ref.driver) },
        nativeConversationHeadRef: null,
        status: "active",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      },
    },
  ]);
});

it.layer(TestLayer)("mcp__t3-code__notify_thread and mcp__t3-code__consult_thread", (it) => {
  it.effect("notify: one notify-origin message under the rail's id; the record is delivered", () =>
    Effect.gen(function* () {
      const store = yield* LoomStoreV2;
      const sender = yield* rootWithRow("notify-sender");
      const target = yield* rootWithRow("notify-target");
      const result = yield* callAs(sender, "notify_thread", {
        threadId: target,
        message: "Report is at /tmp/report.md.",
      });
      assert.isFalse(result.isError, result.text);
      assert.include(result.text, "its next turn is starting with it");

      const messages = yield* messagesOf(target);
      assert.lengthOf(messages, 1);
      const [message] = messages;
      assert.match(message!.id, /^message:server:workstream-notify:/);
      assert.equal(message!.loom?.origin, "notify");
      assert.equal(message!.loom?.controlPayload?.notice, "notify");
      assert.equal(message!.createdBy, "agent");
      assert.include(message!.text, "Report is at /tmp/report.md.");
      assert.include(message!.text, "sent via mcp__t3-code__notify_thread");
      assert.deepEqual(yield* store.peerMessages.listPending(target), []);
      assert.equal((yield* store.getWorkstream(sender))!.notifySendLog[0]?.targetThreadId, target);
    }),
  );

  it.effect("notify: a busy target is queued behind its turn, never interrupted", () =>
    Effect.gen(function* () {
      const sender = yield* rootWithRow("busy-sender");
      const target = yield* rootWithRow("busy-target");
      yield* seedRunningRun({ threadId: target });
      const result = yield* callAs(sender, "notify_thread", { threadId: target, message: "FYI" });
      assert.include(result.text, "queued");
      const { runs } = yield* (yield* Orchestrator.OrchestratorV2).getThreadRecords(target, [
        "runs",
      ]);
      assert.deepEqual(
        runs.map((run) => run.status),
        ["running", "queued"],
      );
    }),
  );

  it.effect("notify: a target whose provider turn is not up yet is queued and delivered", () =>
    Effect.gen(function* () {
      const store = yield* LoomStoreV2;
      const sender = yield* rootWithRow("launching-sender");
      const target = yield* rootWithRow("launching-target");
      yield* seedRunningRun({ threadId: target, live: true, turn: false });
      const result = yield* callAs(sender, "notify_thread", { threadId: target, message: "FYI" });
      assert.isFalse(result.isError, result.text);
      assert.include(result.text, "queued");
      const { runs } = yield* (yield* Orchestrator.OrchestratorV2).getThreadRecords(target, [
        "runs",
      ]);
      assert.deepEqual(
        runs.map((run) => run.status),
        ["running", "queued"],
      );
      assert.deepEqual(yield* store.peerMessages.listPending(target), []);
    }),
  );

  it.effect("notify: archived and done targets are refused and nothing is sent", () =>
    Effect.gen(function* () {
      const sender = yield* rootWithRow("terminal-sender");
      const archived = yield* rootWithRow("archived-target");
      yield* dispatch({
        type: "thread.archive",
        commandId: CommandId.make("command:archive-target"),
        threadId: archived,
      });
      const done = yield* rootWithRow("done-target");
      yield* dispatch({
        type: "thread.outcome.set",
        commandId: CommandId.make("command:done-target"),
        threadId: done,
        createdAt: DateTime.formatIso(yield* DateTime.now),
        outcome: "done",
      });
      for (const target of [archived, done]) {
        const refused = yield* callAs(sender, "notify_thread", { threadId: target, message: "hi" });
        assert.isTrue(refused.isError, target);
        assert.include(refused.text, "is finished or archived; it cannot be notified");
        assert.lengthOf(yield* messagesOf(target), 0);
      }
    }),
  );

  it.effect("notify: the hourly cap holds for a sender with no sidecar row", () =>
    Effect.gen(function* () {
      const sender = ThreadId.make("rowless-sender");
      yield* seedThread({ threadId: sender });
      const target = yield* rootWithRow("capped-target");
      for (let index = 0; index < 10; index += 1) {
        const sent = yield* callAs(sender, "notify_thread", {
          threadId: target,
          message: `#${index}`,
        });
        assert.isFalse(sent.isError, sent.text);
      }
      assert.isNull(yield* (yield* LoomStoreV2).getWorkstream(sender));
      const capped = yield* callAs(sender, "notify_thread", { threadId: target, message: "#10" });
      assert.isTrue(capped.isError);
      assert.include(capped.text, "rate cap reached");
    }),
  );

  it.effect("consult: the fork reads the provider thread's strong pi session file", () =>
    Effect.gen(function* () {
      const asker = yield* rootWithRow("consult-asker");
      const target = ThreadId.make("consult-target");
      yield* seedThread({ threadId: target, title: "Liveness detection" });
      yield* seedProviderThread(target, {
        driver: "pi",
        nativeId: "/sessions/liveness.jsonl",
        strength: "strong",
      });
      asked.length = 0;
      const result = yield* callAs(asker, "consult_thread", {
        threadId: target,
        question: "Which option won?",
      });
      assert.equal(result.text, "The session settled on option B.");
      assert.lengthOf(asked, 1);
      assert.equal(asked[0]!.sessionFile, "/sessions/liveness.jsonl");
      assert.include(asked[0]!.asker, `consult-asker; no parent/child relationship to you`);
      const [summary] = yield* (yield* LoomStoreV2).consults.listByAsker(asker);
      assert.equal(summary?.targetThreadId, target);

      // Resolved by name when the match is clear.
      const byName = yield* callAs(asker, "consult_thread", {
        name: "liveness detection",
        question: "Again?",
      });
      assert.equal(byName.text, "The session settled on option B.");
      assert.lengthOf(asked, 2);
    }),
  );

  it.effect("consult: a weak or non-pi session ref is refused and nothing is forked", () =>
    Effect.gen(function* () {
      const asker = yield* rootWithRow("refused-asker");
      const weak = ThreadId.make("weak-target");
      yield* seedThread({ threadId: weak });
      yield* seedProviderThread(weak, { driver: "pi", nativeId: "pi-session", strength: "weak" });
      const codex = ThreadId.make("codex-target");
      yield* seedThread({ threadId: codex });
      yield* seedRunningRun({ threadId: codex });
      const never = ThreadId.make("never-ran-target");
      yield* seedThread({ threadId: never });
      asked.length = 0;
      for (const [target, reason] of [
        [weak, "weak pi session ref"],
        [codex, "strong codex session ref"],
        [never, "never run a pi turn"],
      ] as const) {
        const refused = yield* callAs(asker, "consult_thread", { threadId: target, question: "?" });
        assert.isTrue(refused.isError, target);
        assert.include(refused.text, "has no inspectable pi session");
        assert.include(refused.text, reason);
      }
      assert.lengthOf(asked, 0);
    }),
  );

  it.effect("consult: an ambiguous name returns ranked candidates and consults nothing", () =>
    Effect.gen(function* () {
      const asker = yield* rootWithRow("ambiguous-asker");
      for (const id of ["twin-a", "twin-b"]) {
        yield* seedThread({ threadId: ThreadId.make(id), title: "Receipt dedup" });
      }
      asked.length = 0;
      const result = yield* callAs(asker, "consult_thread", {
        name: "receipt dedup",
        question: "Done?",
      });
      assert.isFalse(result.isError);
      assert.include(result.text, "Multiple threads match that name");
      assert.include(result.text, "(threadId: twin-a)");
      assert.include(result.text, "(threadId: twin-b)");
      assert.lengthOf(asked, 0);
    }),
  );
});
