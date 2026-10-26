/**
 * Applies a thread's deferred snooze once the asking turn ended idle: mid-turn, run completion
 * would undo it. Consumed once: applied, or dropped when a later message or run exists, a question
 * or approval is pending, or the turn ended unsafe to hide (attention flag, failed or interrupted
 * run, archived thread, wake time already past).
 */
import { CommandId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { LoomStoreV2 } from "../../projection/LoomStore.ts";
import { type PassContext, type PassStep, perThread } from "./WorkstreamDispatcher.ts";

const millis = (time: DateTime.DateTime | null | undefined) =>
  time == null ? null : DateTime.toEpochMillis(time);

const snoozeCommandId = (threadId: string, requestedAt: string) =>
  `server:loom:snooze:${threadId}:${requestedAt}`;

export const snoozeRail: PassStep = {
  name: "snooze",
  run: Effect.fn("loom.dispatcher.snooze")(function* (ctx: PassContext) {
    const requests = (yield* LoomStoreV2).snoozeRequests;
    for (const request of yield* requests.list) {
      yield* perThread(
        "snooze",
        request.threadId,
        Effect.gen(function* () {
          const shell = ctx.shells.get(request.threadId);
          const requestedMs = Date.parse(request.requestedAt);
          // Only the asking turn's own end applies it. A message or a run since the request
          // (a watch wake, a reply, a queued turn) means something happened the human should
          // see, and a question or approval means the human is engaged: each drops it.
          const dropped =
            shell === undefined ||
            (millis(shell.latestUserMessageAt) ?? 0) > requestedMs ||
            (millis(shell.latestRunRequestedAt) ?? 0) > requestedMs ||
            shell.pendingRuntimeRequest !== null;
          // The asking turn is still running (or this pass's snapshot predates its end): wait.
          if (
            !dropped &&
            (shell.activityRunStatus != null ||
              (millis(shell.latestRunCompletedAt) ?? 0) < requestedMs)
          )
            return;
          const apply =
            !dropped &&
            shell.status === "completed" &&
            shell.archivedAt === null &&
            (ctx.nodesById.get(request.threadId)?.attention.length ?? 0) === 0 &&
            Date.parse(request.snoozedUntil) > DateTime.toEpochMillis(ctx.now);
          if (apply) {
            const outcome = yield* ctx.dispatch("snooze", {
              type: "thread.snooze",
              commandId: CommandId.make(snoozeCommandId(request.threadId, request.requestedAt)),
              threadId: request.threadId,
              snoozedUntil: request.snoozedUntil,
            });
            if (outcome.status === "deferred") return; // retried next pass
          }
          // Only this request: a newer one written since the pass read it stands.
          yield* requests.clear(request.threadId, request.requestedAt);
        }),
      );
    }
  }),
};
