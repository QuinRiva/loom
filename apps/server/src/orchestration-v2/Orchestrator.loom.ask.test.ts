/**
 * `runtime-request.create` (Phase 3 plan seam 7b, P3-26, DL-330–332) on the real
 * engine: a `loom-ask:` request on a live run is the shell's pending request and
 * the projection's `user_input_request` item; every refusal is receipted.
 */
import { assert, it } from "@effect/vitest";
import { CommandId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  dispatch,
  LoomOrchestratorTestLayer,
  seededRunIds,
  seedRunningRun,
  seedThread,
} from "../loom/testkit/loomOrchestratorLayer.ts";
import { CommandReceiptStoreV2 } from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";

const questions = [
  {
    id: "ship",
    header: "Ship",
    question: "Ship the change now?",
    options: [
      { label: "Yes", description: "Merge it." },
      { label: "No", description: "Hold it." },
    ],
  },
];

const ask = (threadId: ThreadId, requestId: string) =>
  Effect.flatMap(DateTime.now, (now) =>
    dispatch({
      type: "runtime-request.create",
      commandId: CommandId.make(`server:loom:ask:${requestId}`),
      threadId,
      createdAt: DateTime.formatIso(now),
      requestId: RuntimeRequestId.make(requestId),
      questions,
    }),
  );

const expectRefused = (threadId: ThreadId, requestId: string, cause: string) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(ask(threadId, requestId));
    assert.equal(error._tag, "OrchestratorDispatchError");
    assert.include(String((error as { cause?: unknown }).cause), cause);
    const receipt = yield* (yield* CommandReceiptStoreV2).getByCommandId(
      CommandId.make(`server:loom:ask:${requestId}`),
    );
    assert.equal(Option.getOrThrow(receipt).status, "rejected");
  });

it.layer(LoomOrchestratorTestLayer)("Loom runtime-request.create", (it) => {
  it.effect("opens a pending user_input request with its question item on the live run", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("ask-live");
      yield* seedThread({ threadId });
      const ids = yield* seedRunningRun({ threadId });
      const requestId = RuntimeRequestId.make("loom-ask:live-1");

      yield* ask(threadId, requestId);

      const shell = (yield* orchestrator.getThreadShell(threadId))!;
      assert.equal(shell.pendingRuntimeRequest?.id, requestId);
      assert.equal(shell.pendingRuntimeRequest?.kind, "user_input");
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const request = projection.runtimeRequests.find((entry) => entry.id === requestId)!;
      assert.deepEqual(request.responseCapability, { type: "message" });
      assert.equal(request.providerTurnId, ids.providerTurnId);
      const node = projection.nodes.find((entry) => entry.id === request.nodeId)!;
      assert.equal(node.kind, "user_input_request");
      assert.equal(node.status, "waiting");
      assert.equal(node.parentNodeId, ids.nodeId);
      const item = projection.turnItems.find(
        (entry) => entry.type === "user_input_request" && entry.requestId === requestId,
      );
      assert.equal(item?.status, "waiting");
      assert.equal(item?.nodeId, request.nodeId);
      assert.equal(item?.runId, ids.runId);
      assert.deepEqual(item?.type === "user_input_request" ? item.questions : [], questions);

      // One question at a time: a second ask while this one is pending is refused.
      yield* expectRefused(threadId, "loom-ask:live-2", "already has pending runtime request");
    }),
  );

  it.effect("refuses without an active run, and a request id without the loom-ask: prefix", () =>
    Effect.gen(function* () {
      const idle = ThreadId.make("ask-idle");
      yield* seedThread({ threadId: idle });
      yield* expectRefused(idle, "loom-ask:idle-1", "no active run");

      const live = ThreadId.make("ask-prefix");
      yield* seedThread({ threadId: live });
      yield* seedRunningRun({ threadId: live });
      yield* expectRefused(live, `runtime-request:${seededRunIds(live).runId}`, "loom-ask:");
    }),
  );
});
