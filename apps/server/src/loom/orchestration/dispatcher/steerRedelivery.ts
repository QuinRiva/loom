/**
 * Seam 20's second half (Phase 3 plan Track 3b; DL-387): a steer stashed on a
 * thread the startup pass did not continue (rule 0's not-continued set: flagged,
 * done, request-parked) stays on disk, and the next turn a human or the parent
 * starts on that thread carries it. No `dispatchMessage` hunk is authorised for
 * this (P3-21), so it is a dispatcher rail over the stashes the startup pass
 * LEFT (`PassContext.leftStashes`) — never over the stash directory, which during
 * any live turn also holds that turn's own already-accepted steers (3c's adapter
 * appends on every acked steer and clears at `finalizeTurn`).
 *
 * While such a turn runs, the left text is dispatched as the same steered control
 * message the startup pass sends (same id, so the two paths are mutually
 * exclusive), which upstream's conversion steers into the running turn. The file
 * then keeps only what the adapter appended after startup (the live turn's own
 * steers, so their crash durability survives). An entry whose file no longer
 * starts with the left text was cleared by the adapter's `finalizeTurn`: it is
 * dropped, and the steer is lost — the residual for a turn too short for a pass
 * to see it running (the `run.updated` running trigger keeps that to one pass).
 *
 * @module loom/orchestration/dispatcher/steerRedelivery
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
import { landed, type PassContext, type PassStep } from "./WorkstreamDispatcher.ts";

export const steerRedelivery: PassStep = {
  name: "steerRedelivery",
  run: Effect.fn("loom.dispatcher.steerRedelivery")(function* (ctx: PassContext) {
    const orchestrator = yield* OrchestratorV2;
    for (const [threadId, left] of ctx.leftStashes) {
      const current = yield* PendingSteering.read(threadId);
      if (current === null || !current.startsWith(left)) {
        ctx.leftStashes.delete(threadId);
        continue;
      }
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
      const outcome = yield* ctx.dispatch(
        "steer-redelivery",
        controlMessage({
          threadId,
          id: steerRedeliverCommandId(threadId, steerHash(left)),
          tier: "steered",
          origin: "control_notice",
          text: redeliveredSteerText(left),
        }),
      );
      if (!landed(outcome)) continue;
      ctx.leftStashes.delete(threadId);
      // Keep only what the adapter appended after startup (this turn's accepted steers).
      const rest = current.slice(left.length).replace(/^\n\n/, "");
      yield* PendingSteering.clear(threadId);
      if (rest.length > 0) yield* PendingSteering.append(threadId, rest);
    }
  }),
};
