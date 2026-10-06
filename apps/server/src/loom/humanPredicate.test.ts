/**
 * Seam 14's one human predicate (DL-194/245/248), the two cases Phase 2 did not
 * test, on the real orchestrator: upstream's limit-resume (`createdBy: "user"`,
 * `creationSource: "server"`, `usageLimitContinuationOfRunId`) never clears a hold
 * and is stored without `loom.humanAuthored`, so quiescence reads its turn as
 * control-started; a composer message and a `runtime-request.respond` fall-through
 * answer are stamped human and take the human grace. (3a's `humanEngaged` reads the
 * same stamp and is tested there.)
 */
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2ConversationMessage,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { quiescenceCandidate } from "./orchestration/quiescence.ts";
import { LoomStoreV2 } from "./projection/LoomStore.ts";
import {
  completeSeededRun,
  dispatch,
  LoomOrchestratorTestLayer,
  loomEvent,
  seededRunIds,
  seedRunningRun,
  seedThread,
  seedUsageLimitedRun,
  spawnChild,
  writeEvents,
} from "./testkit/loomOrchestratorLayer.ts";

const createdAt = "2026-01-01T00:00:00.000Z";
const parent = ThreadId.make("human-parent");
const grace = { controlStartedMs: 60_000, humanStartedMs: null };

const limitResume = (threadId: ThreadId, runId: string) =>
  dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`limit-resume:${threadId}`),
    threadId,
    messageId: MessageId.make(`message:limit-resume:${threadId}`),
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
    usageLimitContinuationOfRunId: runId as never,
  });

const storedMessage = (threadId: ThreadId, messageId: string) =>
  Effect.map(
    Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
      orchestrator.getThreadProjection(threadId),
    ),
    (projection) => projection.messages.find((message) => message.id === messageId),
  );

it.layer(LoomOrchestratorTestLayer)("Loom human predicate (seam 14)", (it) => {
  it.effect("an upstream limit-resume keeps a hold and is not human for quiescence", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const store = yield* LoomStoreV2;
      yield* seedThread({ threadId: parent });

      // A quiet, kicked-off child: the candidate whose grace the latest user message decides.
      const quiet = ThreadId.make("human-quiet");
      yield* spawnChild({ parentThreadId: parent, threadId: quiet, graphKey: "quiet" });
      yield* seedRunningRun({ threadId: quiet });
      yield* writeEvents([
        yield* loomEvent("thread.kickoff-recorded", quiet, {
          kickoffAt: createdAt,
          messageId: seededRunIds(quiet).messageId,
          origin: "kickoff",
        }),
      ]);
      yield* completeSeededRun({ threadId: quiet });
      const quietProjection = yield* orchestrator.getThreadProjection(quiet);
      const quietShell = (yield* orchestrator.getThreadShell(quiet))!;
      const ended = quietProjection.runs[0]!.completedAt!;
      const candidateAfterGrace = (
        latestUserMessage: OrchestrationV2ConversationMessage | undefined,
      ) =>
        quiescenceCandidate({
          shell: quietShell,
          runs: quietProjection.runs,
          latestUserMessage: latestUserMessage ?? null,
          children: [],
          now: DateTime.add(ended, { seconds: 61 }),
          grace,
        });

      // Upstream accepts the limit-resume on a live Loom thread and stores it unstamped.
      const resumed = ThreadId.make("human-limit-live");
      yield* spawnChild({ parentThreadId: parent, threadId: resumed, graphKey: "limit-live" });
      const limited = yield* seedUsageLimitedRun({ threadId: resumed });
      yield* limitResume(resumed, limited.runId);
      const resume = yield* storedMessage(resumed, `message:limit-resume:${resumed}`);
      assert.equal(resume?.createdBy, "user");
      assert.notEqual(resume?.loom?.humanAuthored, true);
      assert.isTrue(
        (yield* orchestrator.getThreadProjection(resumed)).runs.some(
          (run) => run.userMessageId === resume?.id,
        ),
      );
      // Its turn is control-started: the control grace applies (a human turn never qualifies).
      assert.isTrue(candidateAfterGrace(resume));

      // On a thread holding awaiting_acceptance the hold stands (rule 0 makes the resume a no-op).
      const holding = ThreadId.make("human-limit-holding");
      yield* spawnChild({ parentThreadId: parent, threadId: holding, graphKey: "limit-holding" });
      const held = yield* seedUsageLimitedRun({ threadId: holding });
      yield* dispatch({
        type: "thread.attention.raise",
        commandId: CommandId.make("human-limit-holding-raise"),
        threadId: holding,
        createdAt,
        reason: "awaiting_acceptance",
      });
      const noOp = yield* limitResume(holding, held.runId);
      assert.deepEqual(
        noOp.storedEvents.map((stored) => stored.event.type),
        ["thread.metadata-updated"],
      );
      assert.isUndefined(yield* storedMessage(holding, `message:limit-resume:${holding}`));
      assert.deepEqual((yield* store.getWorkstream(holding))!.attention, ["awaiting_acceptance"]);

      // A composer message is human: the null human grace means never a candidate.
      const composer = ThreadId.make("human-composer");
      yield* spawnChild({ parentThreadId: parent, threadId: composer, graphKey: "composer" });
      yield* dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("human-composer-send"),
        threadId: composer,
        messageId: MessageId.make("message:human-composer-send"),
        text: "From the composer",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
      const composed = yield* storedMessage(composer, "message:human-composer-send");
      assert.isTrue(composed?.loom?.humanAuthored);
      assert.isFalse(candidateAfterGrace(composed));

      // A runtime-request.respond answer with no live waiter falls through to upstream's
      // message path (`createdBy: "user"`, `creationSource: "server"`): human too.
      const asked = ThreadId.make("human-respond");
      yield* spawnChild({ parentThreadId: parent, threadId: asked, graphKey: "respond" });
      yield* seedRunningRun({ threadId: asked });
      const requestId = RuntimeRequestId.make("loom-ask:human-respond");
      yield* dispatch({
        type: "runtime-request.create",
        commandId: CommandId.make("server:loom:ask:human-respond"),
        threadId: asked,
        createdAt,
        requestId,
        questions: [{ id: "go", header: "Go", question: "Proceed?", options: [] }],
      });
      yield* dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make("human-respond-answer"),
        threadId: asked,
        requestId,
        answers: { go: "Yes" },
      });
      const answer = yield* storedMessage(asked, `async-answer:${requestId}`);
      assert.equal(answer?.creationSource, "server");
      assert.isTrue(answer?.loom?.humanAuthored);
      assert.isFalse(candidateAfterGrace(answer));
    }),
  );
});
