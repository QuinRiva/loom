/**
 * Seam 20's second half (Phase 3 plan Track 3b; DL-387, DL-455): a steer stashed on a
 * thread the startup pass did not continue (rule 0's not-continued set: flagged,
 * done, request-parked) stays on disk, and the next turn a human or the parent
 * starts on that thread carries it. No `dispatchMessage` hunk is authorised for
 * this (P3-21), so it is a dispatcher rail over the stashes the startup pass
 * LEFT (`PassContext.leftStashes`) — never over the stash directory, which during
 * any live turn also holds that turn's own already-accepted steers (3c's adapter
 * appends on every acked steer and clears at `finalizeTurn`).
 *
 * The text comes from the startup snapshot, never read back from the file: the
 * carrying turn's `finalizeTurn` (or an earlier control turn's) may clear the file
 * before a pass sees the turn, and that clear never delivered the left steer. Once
 * a turn a human or the parent started after startup exists, the steer goes out as
 * the same steered control message the startup pass sends (same id, so the two
 * paths are mutually exclusive): upstream's conversion steers it into that turn
 * while it runs, and it starts the follow-up turn when that turn already ended.
 * The file then keeps only what the adapter appended after startup.
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
        continue;
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
      if (!landed(outcome)) continue;
      ctx.leftStashes.delete(threadId);
      // Keep only what the adapter appended after startup (this turn's accepted steers).
      const current = yield* PendingSteering.read(threadId);
      if (current === null || !current.startsWith(left.text)) continue;
      const rest = current.slice(left.text.length).replace(/^\n\n/, "");
      yield* PendingSteering.clear(threadId);
      if (rest.length > 0) yield* PendingSteering.append(threadId, rest);
    }
  }),
};
