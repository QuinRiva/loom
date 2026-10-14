/**
 * The snooze rail: applies a thread's own deferred snooze
 * (`mcp__t3-code__snooze_thread`, `loom_thread_snooze_requests`) once the turn
 * that asked for it has ended idle. Mid-turn the snooze would be undone by the
 * run's completion (`isSnoozed`); dispatched after it, `snoozedAt` postdates
 * `latestRunCompletedAt`, so the thread stays snoozed until a message
 * un-snoozes it (`dispatchMessage` clears `snoozedUntil`) or the time lapses.
 * A terminal `run.updated` triggers a pass, so it lands right after the turn.
 *
 * A request is consumed once: applied, or dropped when a message arrived or a
 * run was requested after it (the turn that asked is no longer the latest), when a question or approval is
 * pending (even mid-turn), or when the turn did not end in a state the human may
 * safely not see — a Loom attention flag, a failed or interrupted run, an
 * archived thread, a wake time already past.
 *
 * @module loom/orchestration/dispatcher/snoozeRail
 */
import { CommandId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { LoomStoreV2 } from "../../projection/LoomStore.ts";
import { type PassContext, type PassStep, perThread } from "./WorkstreamDispatcher.ts";

const millis = (time: DateTime.DateTime | null | undefined) =>
  time == null ? null : DateTime.toEpochMillis(time);

export const snoozeCommandId = (threadId: string, requestedAt: string) =>
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
