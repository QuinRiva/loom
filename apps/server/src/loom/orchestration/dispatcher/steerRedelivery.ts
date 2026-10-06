/**
 * Seam 20's second half (Phase 3 plan Track 3b; DL-387): a steer stashed on a
 * thread the startup pass did not continue (rule 0's not-continued set: flagged,
 * done, request-parked) stays on disk, and the next turn a human or the parent
 * starts on that thread carries it. No `dispatchMessage` hunk is authorised for
 * this (P3-21), so it is a dispatcher rail: while such a turn runs, the stash is
 * dispatched as the same steered control message the startup pass sends (same
 * id, so a startup redelivery and this one are mutually exclusive), which
 * upstream's conversion steers into the running turn, then the file is cleared.
 *
 * Residual: a turn short enough to finalize before a pass sees it running loses
 * the steer, because 3c's adapter clears the stash at `finalizeTurn`; the
 * `run.updated` running trigger (`hasStashedSteer`) keeps that window to one pass.
 *
 * @module loom/orchestration/dispatcher/steerRedelivery
 */
import type { ThreadId } from "@t3tools/contracts";
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
import { landed, type PassContext, type PassStep } from "./WorkstreamDispatcher.ts";

/** The pass trigger's cheap check: does `threadId` hold a stash? */
export const hasStashedSteer = (threadId: ThreadId) =>
  Effect.map(PendingSteering.read(threadId), (steer) => steer !== null);

export const steerRedelivery: PassStep = {
  name: "steerRedelivery",
  run: Effect.fn("loom.dispatcher.steerRedelivery")(function* (ctx: PassContext) {
    const orchestrator = yield* OrchestratorV2;
    for (const threadId of yield* PendingSteering.listStashed()) {
      if (ctx.shells.get(threadId)?.activityRunStatus !== "running") continue;
      const { runs, messages, runtimeRequests } = yield* orchestrator.getThreadRecords(
        threadId,
        ["runs", "messages", "runtimeRequests"],
        { messageRoles: ["user"] },
      );
      if (
        loomContinuationVetoed(
          ctx.nodesById.get(threadId) ?? null,
          runtimeRequests.some((request) => request.status === "pending"),
        )
      )
        continue;
      // Only a turn a human or the parent started: a control wake or a continuation does not carry it.
      const started = runs.find((run) => run.status === "running");
      const loom = messages.find((message) => message.id === started?.userMessageId)?.loom;
      if (loom?.humanAuthored !== true && loom?.origin !== "orchestrator") continue;
      const steer = yield* PendingSteering.read(threadId);
      if (steer === null) {
        yield* PendingSteering.clear(threadId);
        continue;
      }
      const outcome = yield* ctx.dispatch(
        "steer-redelivery",
        controlMessage({
          threadId,
          id: steerRedeliverCommandId(threadId, steerHash(steer)),
          tier: "steered",
          origin: "control_notice",
          text: redeliveredSteerText(steer),
        }),
      );
      if (landed(outcome)) yield* PendingSteering.clear(threadId);
    }
  }),
};
