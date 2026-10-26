/**
 * A steered-tier Loom message queued because its target's turn was not up yet is promoted into that
 * turn with upstream's `queued-message.promote-to-steer` once it runs steerably, in delivery order.
 * Notifications, delegated completions, human-held queues and human-queued messages stay queued.
 * One id per queued run; a refusal (turn ended) just leaves the message to start the next turn.
 */
import { CommandId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { isPromotableLoomQueuedRun } from "../../../orchestration-v2/Orchestrator.loom.ts";
import { OrchestratorV2 } from "../../../orchestration-v2/Orchestrator.ts";
import { queuedRunsInDeliveryOrder } from "../../../orchestration-v2/QueuedRunOrder.ts";
import { type PassStep, perThread } from "./WorkstreamDispatcher.ts";

const promoteSteerCommandId = (queuedRunId: string) => `server:loom:promote-steer:${queuedRunId}`;

export const queuedSteerPromotion: PassStep = {
  name: "queuedSteerPromotion",
  run: Effect.fn("loom.dispatcher.queuedSteerPromotion")(function* (ctx) {
    const orchestrator = yield* OrchestratorV2;
    for (const shell of ctx.shells.values()) {
      if (shell.activityRunStatus !== "running" || shell.activeRunId === null) continue;
      yield* perThread(
        "queuedSteerPromotion",
        shell.id,
        Effect.gen(function* () {
          const { runs, messages, providerThreads, providerTurns, providerSessions } =
            yield* orchestrator.getThreadRecords(
              shell.id,
              ["runs", "messages", "providerThreads", "providerTurns", "providerSessions"],
              { messageRoles: ["user"] },
            );
          const active = runs.find(
            (run) => run.id === shell.activeRunId && run.status === "running",
          );
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
            return;
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
        }),
      );
    }
  }),
};
