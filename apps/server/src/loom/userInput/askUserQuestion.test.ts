/**
 * `mcp__t3-code__ask_user_question` on the real orchestrator (3a-4): the request on its
 * dedicated node, the respond hunk with and without a live waiter, rule 6's
 * supersede and the run-end close. The reactor is fed each command's committed
 * events (the dispatch result, or the receipt's events by command id), so every
 * step is deterministic; the long-poll waits on its Deferred under the
 * TestClock, whose slice never elapses.
 */
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  type RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { WorkstreamCaller } from "../../mcp/toolkits/workstream/authorisation.ts";
import { CommandReceiptStoreV2 } from "../../orchestration-v2/CommandReceiptStore.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import {
  completeSeededRun,
  dispatch,
  LoomOrchestratorTestLayer,
  seedRunningRun,
  seedThread,
} from "../testkit/loomOrchestratorLayer.ts";
import { openAskUserQuestion, reactToAskEvent } from "./askUserQuestion.ts";
import { LoomAskWaiters, makeLoomAskWaiters } from "./askWaiters.ts";

const QUESTIONS = [
  {
    header: "Ship",
    question: "Ship the change now?",
    options: [
      { label: "Yes", description: "Merge it.", recommended: true },
      { label: "No", description: "Hold it." },
    ],
  },
];

const callerOf = (threadId: ThreadId): WorkstreamCaller => ({
  threadId,
  scope: {
    environmentId: EnvironmentId.make("environment:loom-ask"),
    capabilities: new Set(["workstream"]),
    issuedAt: 0,
    requestNamespace: "ns-ask",
    thread: {
      threadId,
      providerSessionId: "provider-session:ask",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
  },
});

/** Dispatches and feeds the command's committed events to the ask reactor. */
const dispatchAndReact = (command: Parameters<typeof dispatch>[0]) =>
  Effect.gen(function* () {
    const result = yield* dispatch(command);
    yield* Effect.forEach(result.storedEvents, (stored) => reactToAskEvent(stored.event), {
      discard: true,
    });
    return result;
  });

/** Feeds the events a server command (the reactor's own dismiss) committed. */
const reactToCommand = (commandId: string) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    yield* sink
      .readByCommandId({ commandId: CommandId.make(commandId) })
      .pipe(Stream.runForEach((stored) => reactToAskEvent(stored.event)));
  });

const askOn = (name: string) =>
  Effect.gen(function* () {
    const threadId = ThreadId.make(name);
    yield* seedThread({ threadId });
    const ids = yield* seedRunningRun({ threadId });
    const requestId = yield* openAskUserQuestion(callerOf(threadId), {
      toolCallId: `call-${name}`,
      questions: QUESTIONS,
    });
    const waiters = yield* LoomAskWaiters;
    return { threadId, ids, requestId, waiters };
  });

const poll = (
  waiters: ReturnType<typeof makeLoomAskWaiters>,
  requestId: RuntimeRequestId,
  threadId: ThreadId,
) => Effect.forkChild(waiters.wait(requestId, threadId, 25_000));

const respond = (threadId: ThreadId, requestId: RuntimeRequestId) =>
  dispatchAndReact({
    type: "runtime-request.respond",
    commandId: CommandId.make(`command:respond:${requestId}`),
    threadId,
    requestId,
    answers: { q1: "Yes" },
  });

const fresh = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, LoomAskWaiters, makeLoomAskWaiters());

it.layer(LoomOrchestratorTestLayer)("Loom mcp__t3-code__ask_user_question", (it) => {
  it.effect("opens a pending user_input request on its own node, the pick shown in its label", () =>
    fresh(
      Effect.gen(function* () {
        const { threadId, ids, requestId } = yield* askOn("ask-open");
        assert.isTrue(requestId.startsWith("loom-ask:ask-open:"));
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        assert.equal(
          (yield* orchestrator.getThreadShell(threadId))?.pendingRuntimeRequest?.id,
          requestId,
        );
        const projection = yield* orchestrator.getThreadProjection(threadId);
        const request = projection.runtimeRequests.find((entry) => entry.id === requestId)!;
        const node = projection.nodes.find((entry) => entry.id === request.nodeId)!;
        assert.equal(node.kind, "user_input_request");
        assert.notEqual(node.id, ids.nodeId);
        assert.equal(node.parentNodeId, ids.nodeId);
        const item = projection.turnItems.find((entry) => entry.type === "user_input_request");
        assert.deepEqual(item?.type === "user_input_request" ? item.questions[0]?.options : [], [
          { label: "Yes (Recommended)", description: "Merge it.", value: "Yes" },
          { label: "No", description: "Hold it." },
        ]);

        // A retried POST (same pi tool call) is the same request, receipted once.
        const again = yield* openAskUserQuestion(callerOf(threadId), {
          toolCallId: "call-ask-open",
          questions: QUESTIONS,
        });
        assert.equal(again, requestId);
      }),
    ),
  );

  it.effect("a live waiter takes the panel's answer as its tool result; no message is sent", () =>
    fresh(
      Effect.gen(function* () {
        const { threadId, requestId, waiters } = yield* askOn("ask-live");
        const polling = yield* poll(waiters, requestId, threadId);

        yield* respond(threadId, requestId);

        const outcome = yield* Fiber.join(polling);
        assert.deepEqual(outcome, Option.some("The user answered:\n- Ship the change now?: Yes"));
        const projection = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(
          threadId,
        );
        assert.equal(projection.runtimeRequests[0]?.status, "resolved");
        assert.isFalse(
          projection.messages.some((message) => message.id.startsWith("async-answer:")),
        );
        assert.equal(projection.runs.length, 1);
      }),
    ),
  );

  it.effect("with no live waiter the answer falls through to upstream's one user message", () =>
    fresh(
      Effect.gen(function* () {
        const { threadId, requestId, waiters } = yield* askOn("ask-dead");
        yield* waiters.drop(requestId); // pi died, or the server restarted

        yield* respond(threadId, requestId);

        const projection = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(
          threadId,
        );
        const answers = projection.messages.filter(
          (message) => message.id === MessageId.make(`async-answer:${requestId}`),
        );
        assert.equal(answers.length, 1);
        assert.equal(answers[0]?.text, "Ship the change now?\nYes");
        assert.equal(answers[0]?.loom?.humanAuthored, true);
        // Resolution and message commit together, so the reactor reads no pending request.
        const supersede = yield* (yield* CommandReceiptStoreV2).getByCommandId(
          CommandId.make(`server:loom:ask-supersede:${requestId}`),
        );
        assert.isTrue(Option.isNone(supersede));
      }),
    ),
  );

  it.effect("a human message while the question stands supersedes it; no extra turn", () =>
    fresh(
      Effect.gen(function* () {
        const { threadId, requestId, waiters } = yield* askOn("ask-supersede");
        const polling = yield* poll(waiters, requestId, threadId);

        yield* dispatchAndReact({
          type: "message.dispatch",
          commandId: CommandId.make("command:ask-supersede:reply"),
          threadId,
          messageId: MessageId.make("message:ask-supersede:reply"),
          text: "Hold it until Monday.",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          dispatchMode: { type: "queue_after_active" },
        });
        yield* reactToCommand(`server:loom:ask-supersede:${requestId}`);

        const outcome = Option.getOrThrow((yield* Fiber.join(polling))!);
        assert.include(outcome, "replied with a message instead of using the form");
        assert.notInclude(outcome, "Hold it until Monday.");
        const projection = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(
          threadId,
        );
        assert.equal(projection.runtimeRequests[0]?.decision, "cancel");
        assert.equal(
          projection.nodes.find((node) => node.kind === "user_input_request")?.status,
          "cancelled",
        );
        // The human's own message is the only turn added: no answer message, no second ask turn.
        assert.isFalse(
          projection.messages.some((message) => message.id.startsWith("async-answer:")),
        );
        assert.deepEqual(
          projection.runs.map((run) => run.status),
          ["running", "queued"],
        );
      }),
    ),
  );

  it.effect("the run that asked ending closes its question", () =>
    fresh(
      Effect.gen(function* () {
        const { threadId, requestId, waiters } = yield* askOn("ask-run-end");
        const polling = yield* poll(waiters, requestId, threadId);
        const sink = yield* EventSink.EventSinkV2;
        const before = yield* sink.latestSequence();

        yield* completeSeededRun({ threadId });
        yield* sink.stream({ afterSequence: before, threadId }).pipe(
          Stream.map((stored) => stored.event),
          Stream.takeUntil((event) => event.type === "run.updated"),
          Stream.runForEach(reactToAskEvent),
        );
        yield* reactToCommand(`server:loom:ask-run-end:${requestId}`);

        assert.include(
          Option.getOrThrow((yield* Fiber.join(polling))!),
          "cancelled or interrupted without answers",
        );
        const projection = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(
          threadId,
        );
        assert.equal(projection.runtimeRequests[0]?.decision, "cancel");
      }),
    ),
  );
});
