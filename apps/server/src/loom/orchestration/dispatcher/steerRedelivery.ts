/**
 * Redelivers a steer the startup pass stashed but did not continue (flagged, done, request-parked)
 * in the next human- or parent-started turn. Reads only `PassContext.leftStashes` and the startup
 * snapshot text: the stash dir also mirrors live turns' steers and pi overwrites the file. Same id as
 * the startup send, so the paths are exclusive; the file goes only if it still holds that text.
 */
import * as Effect from "effect/Effect";

import { loomContinuationVetoed } from "../../../orchestration-v2/Orchestrator.loom.ts";
import { OrchestratorV2 } from "../../../orchestration-v2/Orchestrator.ts";
import * as PendingSteering from "../../steering/pendingSteering.ts";
import {
  controlMessage,
  redeliveredSteerText,
  steerHash,
  steerRedeliverCommandId,
} from "./controlMessage.ts";
import { landed, type PassContext, type PassStep, perThread } from "./WorkstreamDispatcher.ts";

export const steerRedelivery: PassStep = {
  name: "steerRedelivery",
  run: Effect.fn("loom.dispatcher.steerRedelivery")(function* (ctx: PassContext) {
    const orchestrator = yield* OrchestratorV2;
    for (const [threadId, left] of ctx.leftStashes) {
      yield* perThread(
        "steerRedelivery",
        threadId,
        Effect.gen(function* () {
          const { runs, messages, runtimeRequests } = yield* orchestrator.getThreadRecords(
            threadId,
            ["runs", "messages", "runtimeRequests"],
            { messageRoles: ["user"] },
          );
          // A turn a human or the parent started since startup, once it has begun (running, or already
          // ended): a control wake or a continuation does not carry it.
          const carrier = runs.find((run) => {
            const loom = messages.find((message) => message.id === run.userMessageId)?.loom;
            return (
              run.ordinal > left.afterOrdinal &&
              run.startedAt != null &&
              (loom?.humanAuthored === true || loom?.origin === "orchestrator")
            );
          });
          if (
            carrier === undefined ||
            loomContinuationVetoed(
              ctx.nodesById.get(threadId) ?? null,
              runtimeRequests.some((request) => request.status === "pending"),
            )
          )
            return;
          const outcome = yield* ctx.dispatch(
            "steer-redelivery",
            controlMessage({
              threadId,
              id: steerRedeliverCommandId(threadId, steerHash(left.text)),
              tier: "steered",
              origin: "control_notice",
              text: redeliveredSteerText(left.text),
            }),
          );
          if (!landed(outcome)) return;
          ctx.leftStashes.delete(threadId);
          yield* PendingSteering.clear(threadId, left.text);
        }),
      );
    }
  }),
};
