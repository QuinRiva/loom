/**
 * Prompt, stop, request_attention and set_dependencies on the real orchestrator: a prompt is one
 * orchestrator-origin message that clears a hold; on an unstarted briefed child it amends the brief,
 * once started it steers; an unbriefed child is refused; stop never raises; dependencies carry the parent.
 */
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { LoomStoreV2 } from "../../../../loom/projection/LoomStore.ts";
import { readWorkstreamBriefAt } from "../../../../loom/workstream/brief.ts";
import {
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
    "prompt: an unbriefed child is sent to mcp__t3-code__workstream_brief; a briefed unstarted one has its brief amended",
    () =>
      Effect.gen(function* () {
        const store = yield* LoomStoreV2;
        const root = ThreadId.make("amend-prompt-root");
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
        for (const message of ["go", "and also this"]) {
          const amended = yield* callAs(root, "workstream_prompt", { threadId: second, message });
          assert.isFalse(amended.isError, amended.text);
          assert.include(amended.text, `dependency '${first}' is not done yet`);
        }
        assert.lengthOf(yield* messagesOf(second), 0);
        const row = (yield* store.getWorkstream(second))!;
        assert.isNull(row.kickoffAt);
        const amendment = (message: string) =>
          `\n\n---\n\nAmendment from your parent orchestrator, added after the brief above was written:\n\n${message}`;
        assert.equal(
          Option.getOrUndefined(yield* readWorkstreamBriefAt(row.kickoffBriefPath!)),
          `brief${amendment("go")}${amendment("and also this")}\n`,
        );

        yield* markStarted(second);
        const steered = yield* callAs(root, "workstream_prompt", {
          threadId: second,
          message: "now steer",
        });
        assert.isFalse(steered.isError, steered.text);
        assert.include(steered.text, "Sent prompt");
        assert.deepEqual(
          (yield* messagesOf(second)).map((message) => message.text),
          ["now steer"],
        );
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

  it.effect("child ids resolve with the thread: prefix stripped; a bare segment does not", () =>
    Effect.gen(function* () {
      const store = yield* LoomStoreV2;
      const root = ThreadId.make("alias-root");
      yield* seedThread({ threadId: root });
      const first = yield* spawn(root, "First");
      const second = yield* spawn(root, "Second");
      const strip = (id: ThreadId) => id.slice("thread:".length);

      const flagged = yield* callAs(root, "workstream_request_attention", {
        threadId: strip(second),
        reason: "needs_guidance",
      });
      assert.isFalse(flagged.isError, flagged.text);
      assert.include(flagged.text, second);
      assert.deepEqual((yield* store.getWorkstream(second))!.attention, ["needs_guidance"]);

      const set = yield* callAs(root, "workstream_set_dependencies", {
        threadId: strip(second),
        blockedBy: [strip(first)],
      });
      assert.isFalse(set.isError, set.text);
      assert.deepEqual((yield* store.getWorkstream(second))!.blockedBy, [first]);

      // The trailing uuid alone names no thread: only the prefix is equated.
      const segment = second.split(":").at(-1)!;
      const refused = yield* callAs(root, "workstream_stop", { threadId: segment });
      assert.isTrue(refused.isError);
      assert.include(refused.text, `Thread ${segment} was not found.`);
    }),
  );
});
