/**
 * Steered-tier messages queued before their target could take a steer (DL-662).
 * A Loom message (`workstream_prompt`, `notify_thread`, a control wake) aimed at a
 * run whose provider turn is not up yet — still starting, or `running` before the
 * adapter reports its turn — is queued as the target's next turn (DL-660). That
 * delivers it, but a correction sent right after a spawn would then wait out the
 * child's whole first turn. Once that run has a running turn on a session that
 * steers without interrupting tools (the condition upstream's steer conversion
 * uses), this rail moves the message into the turn with upstream's own
 * `queued-message.promote-to-steer`.
 *
 * Which queued runs qualify is `isPromotableLoomQueuedRun`, shared with the
 * decider's steer conversion: while one is queued, a later Loom message queues
 * behind it instead of steering past it (DL-663), and this rail promotes them in
 * upstream's delivery order, so the turn reads them in send order. A message
 * with a `notification` or a delegated completion is upstream's to deliver
 * queued, a human-held queue stays held, and anything a human queued is theirs.
 *
 * The id is one per queued run, so a promotion is tried once. It is dispatched
 * directly rather than through `PassContext.dispatch`: a refusal (the turn ended
 * in between) is no dead episode to report, because the message simply stays
 * queued and starts the next turn.
 *
 * @module loom/orchestration/dispatcher/queuedSteerPromotion
 */
import { CommandId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { isPromotableLoomQueuedRun } from "../../../orchestration-v2/Orchestrator.loom.ts";
import { OrchestratorV2 } from "../../../orchestration-v2/Orchestrator.ts";
import { queuedRunsInDeliveryOrder } from "../../../orchestration-v2/QueuedRunOrder.ts";
import type { PassStep } from "./WorkstreamDispatcher.ts";

export const promoteSteerCommandId = (queuedRunId: string) =>
  `server:loom:promote-steer:${queuedRunId}`;

export const queuedSteerPromotion: PassStep = {
  name: "queuedSteerPromotion",
  run: Effect.fn("loom.dispatcher.queuedSteerPromotion")(function* (ctx) {
    const orchestrator = yield* OrchestratorV2;
    for (const shell of ctx.shells.values()) {
      if (shell.activityRunStatus !== "running" || shell.activeRunId === null) continue;
      const { runs, messages, providerThreads, providerTurns, providerSessions } =
        yield* orchestrator.getThreadRecords(
          shell.id,
          ["runs", "messages", "providerThreads", "providerTurns", "providerSessions"],
          { messageRoles: ["user"] },
        );
      const active = runs.find((run) => run.id === shell.activeRunId && run.status === "running");
      const sessionId = providerThreads.find(
        (thread) => thread.id === active?.providerThreadId,
      )?.providerSessionId;
      const turns = providerSessions.find((session) => session.id === sessionId)?.capabilities
        .turns;
      if (
        active === undefined ||
        turns?.supportsActiveSteering !== true ||
        turns.activeSteeringInterruptsTools === true ||
        !providerTurns.some(
          (turn) => turn.runAttemptId === active.activeAttemptId && turn.status === "running",
        )
      )
        continue;
      const queued = queuedRunsInDeliveryOrder({ runs, messages }).filter((run) =>
        isPromotableLoomQueuedRun(run, messages),
      );
      for (const run of queued) {
        yield* orchestrator
          .dispatch({
            type: "queued-message.promote-to-steer",
            commandId: CommandId.make(promoteSteerCommandId(run.id)),
            threadId: shell.id,
            queuedRunId: run.id,
            targetRunId: active.id,
          })
          .pipe(
            Effect.catch((error) =>
              Effect.logInfo("loom.dispatcher.steer-promotion-refused", {
                threadId: shell.id,
                queuedRunId: run.id,
                error: error.message,
              }),
            ),
          );
      }
    }
  }),
};
