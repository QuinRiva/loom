/**
 * mcp__t3-code__workstream_prompt, mcp__t3-code__workstream_stop, mcp__t3-code__workstream_request_attention and
 * mcp__t3-code__workstream_set_dependencies on V2's real orchestrator: the prompt is one
 * stored message with `loom.origin` orchestrator that clears a standing hold;
 * an unstarted briefed child is started by it with the kickoff wrapper; an
 * unbriefed or blocked child is refused; stop interrupts without raising;
 * dependencies carry the parent.
 */
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { LoomStoreV2 } from "../../../../loom/projection/LoomStore.ts";
import { workstreamChildPrompt } from "../../../../loom/prompt/prose.ts";
import {
  completeSeededRun,
  loomEvent,
  seedRunningRun,
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

const markStarted = (threadId: ThreadId) =>
  Effect.gen(function* () {
    yield* writeEvents([
      yield* loomEvent("thread.kickoff-recorded", threadId, {
        kickoffAt: DateTime.formatIso(yield* DateTime.now),
        messageId: `message:kickoff:${threadId}` as never,
        origin: "kickoff",
      }),
    ]);
  });

const messagesOf = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    Effect.map(orchestrator.getThreadRecords(threadId, ["messages"]), ({ messages }) => messages),
  );

it.layer(HandlerTestLayer)("workstream prompt, stop, attention and dependencies", (it) => {
  it.effect("prompt: one orchestrator-origin message that clears the child's standing hold", () =>
    Effect.gen(function* () {
      const store = yield* LoomStoreV2;
      const root = ThreadId.make("prompt-root");
      yield* seedThread({ threadId: root });
      const child = yield* spawn(root, "Flagged");
      yield* markStarted(child);
      yield* callAs(root, "workstream_request_attention", {
        threadId: child,
        reason: "needs_guidance",
      });
      assert.deepEqual((yield* store.getWorkstream(child))!.attention, ["needs_guidance"]);

      const result = yield* callAs(root, "workstream_prompt", {
        threadId: child,
        message: "Here is the answer.",
      });
      assert.isFalse(result.isError, result.text);
      const messages = yield* messagesOf(child);
      assert.lengthOf(messages, 1);
      assert.equal(messages[0]!.text, "Here is the answer.");
      assert.equal(messages[0]!.loom?.origin, "orchestrator");
      assert.equal(messages[0]!.createdBy, "agent");
      assert.deepEqual((yield* store.getWorkstream(child))!.attention, []);
    }),
  );

  it.effect(
    "prompt: before the child's provider turn is up the message queues; once it is up it steers",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const root = ThreadId.make("early-prompt-root");
        yield* seedThread({ threadId: root });
        const [launching, running] = [
          yield* spawn(root, "Launching"),
          yield* spawn(root, "Running"),
        ];
        for (const child of [launching!, running!]) yield* markStarted(child);
        // A live session and a `running` run, but the adapter has not reported its turn yet.
        yield* seedRunningRun({ threadId: launching!, live: true, turn: false });
        const { runId } = yield* seedRunningRun({ threadId: running!, live: true });

        const early = yield* callAs(root, "workstream_prompt", {
          threadId: launching!,
          message: "Correction.",
        });
        assert.isFalse(early.isError, early.text);
        assert.include(early.text, "queued");
        const queued = yield* orchestrator.getThreadRecords(launching!, ["runs", "messages"]);
        assert.deepEqual(
          queued.runs.map((run) => run.status),
          ["running", "queued"],
        );
        const correction = queued.messages.find((message) => message.text === "Correction.");
        assert.equal(correction?.runId, queued.runs[1]!.id);
        assert.equal(correction?.loom?.origin, "orchestrator");

        const steered = yield* callAs(root, "workstream_prompt", {
          threadId: running!,
          message: "Correction.",
        });
        assert.include(steered.text, "steered into its running turn");
        const live = yield* orchestrator.getThreadRecords(running!, ["runs", "messages"]);
        assert.deepEqual(
          live.runs.map((run) => run.status),
          ["running"],
        );
        assert.equal(live.messages.find((message) => message.text === "Correction.")?.runId, runId);
      }),
  );

  it.effect(
    "prompt: an unstarted briefed child starts with the kickoff wrapper before the message",
    () =>
      Effect.gen(function* () {
        const store = yield* LoomStoreV2;
        const root = ThreadId.make("kickoff-root");
        yield* seedThread({ threadId: root });
        const child = yield* spawn(root, "Unstarted", { brief: "Port the handlers." });

        const result = yield* callAs(root, "workstream_prompt", {
          threadId: child,
          message: "Start with spawn.",
        });
        assert.isFalse(result.isError, result.text);
        const [message, ...rest] = yield* messagesOf(child);
        assert.lengthOf(rest, 0);
        assert.equal(
          message!.text,
          `${workstreamChildPrompt({ role: "coder", brief: "Port the handlers.", gateTargetId: null })}\n\nStart with spawn.`,
        );
        assert.equal(message!.loom?.origin, "orchestrator");
        const row = (yield* store.getWorkstream(child))!;
        assert.isNotNull(row.kickoffAt);
      }),
  );

  it.effect(
    "prompt: an unbriefed child is sent to mcp__t3-code__workstream_brief; a blocked one is refused by the arm",
    () =>
      Effect.gen(function* () {
        const store = yield* LoomStoreV2;
        const root = ThreadId.make("refused-prompt-root");
        yield* seedThread({ threadId: root });
        yield* callAs(root, "workstream_scaffold", {
          nodes: [
            { key: "first", role: "coder", title: "First", purpose: "Go first." },
            {
              key: "second",
              role: "coder",
              title: "Second",
              purpose: "Go second.",
              blockedBy: ["first"],
            },
          ],
        });
        const children = yield* store.listChildren(root);
        const first = children.find((child) => child.graphKey === "first")!.threadId;
        const second = children.find((child) => child.graphKey === "second")!.threadId;

        const unbriefed = yield* callAs(root, "workstream_prompt", {
          threadId: first,
          message: "go",
        });
        assert.isTrue(unbriefed.isError);
        assert.include(unbriefed.text, "has not been briefed yet");

        yield* callAs(root, "workstream_brief", { node: "second", markdown: "brief" });
        const blocked = yield* callAs(root, "workstream_prompt", {
          threadId: second,
          message: "go",
        });
        assert.isTrue(blocked.isError);
        assert.include(blocked.text, "cannot start");
        assert.lengthOf(yield* messagesOf(second), 0);
      }),
  );

  it.effect("prompt: an unblocked fork child gets its fork transfer before its kickoff", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const root = ThreadId.make("fork-prompt-root");
      yield* seedThread({ threadId: root });
      const source = yield* spawn(root, "Reader");
      const fork = spawnedId(
        (yield* callAs(root, "workstream_spawn", {
          title: "Fork",
          purpose: "Act on it.",
          forkFrom: source,
        })).text,
      );
      yield* markStarted(source);
      yield* seedRunningRun({ threadId: source });
      yield* completeSeededRun({ threadId: source });
      yield* callAs(source, "workstream_submit", { markdown: "read it" });

      const result = yield* callAs(root, "workstream_prompt", { threadId: fork, message: "go" });
      assert.isFalse(result.isError, result.text);
      const { contextTransfers } = yield* orchestrator.getThreadRecords(fork, ["contextTransfers"]);
      assert.deepInclude(contextTransfers[0], { type: "fork", sourceThreadId: source });
      assert.lengthOf(yield* messagesOf(fork), 1);
    }),
  );

  it.effect("stop: interrupts a direct child's run without raising attention", () =>
    Effect.gen(function* () {
      const store = yield* LoomStoreV2;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const root = ThreadId.make("stop-root");
      yield* seedThread({ threadId: root });
      const child = yield* spawn(root, "Busy");
      yield* markStarted(child);
      yield* seedRunningRun({ threadId: child, live: true });

      const self = yield* callAs(root, "workstream_stop", { threadId: root });
      assert.isTrue(self.isError);

      const result = yield* callAs(root, "workstream_stop", { threadId: child });
      assert.isFalse(result.isError, result.text);
      assert.include(result.text, "Stopped Workstream child");
      const { turnItems } = yield* orchestrator.getThreadRecords(child, ["turnItems"]);
      assert.isTrue(turnItems.some((item) => item.type === "run_interrupt_request"));
      assert.deepEqual((yield* store.getWorkstream(child))!.attention, []);
    }),
  );

  it.effect("set_dependencies: replaces the set under the parent; a started target is warned", () =>
    Effect.gen(function* () {
      const store = yield* LoomStoreV2;
      const root = ThreadId.make("deps-root");
      yield* seedThread({ threadId: root });
      const first = yield* spawn(root, "First");
      const second = yield* spawn(root, "Second");

      const set = yield* callAs(root, "workstream_set_dependencies", {
        threadId: second,
        blockedBy: [first],
      });
      assert.isFalse(set.isError, set.text);
      assert.deepEqual((yield* store.getWorkstream(second))!.blockedBy, [first]);

      yield* markStarted(first);
      const started = yield* callAs(root, "workstream_set_dependencies", {
        threadId: first,
        blockedBy: [],
      });
      assert.include(started.text, "recorded for DISPLAY ONLY");

      const rootRefused = yield* callAs(root, "workstream_set_dependencies", { blockedBy: [] });
      assert.isTrue(rootRefused.isError);
    }),
  );
});
