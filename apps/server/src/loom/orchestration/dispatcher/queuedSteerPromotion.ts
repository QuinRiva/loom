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
 * The id is one per queued run, so a promotion is tried once. It is dispatched
 * directly rather than through `PassContext.dispatch`: a refusal (the turn ended
 * in between) is no dead episode to report, because the message simply stays
 * queued and starts the next turn. A message carrying a `notification` or a
 * delegated completion is upstream's to deliver queued and is left alone, as is
 * anything a human queued.
 *
 * @module loom/orchestration/dispatcher/queuedSteerPromotion
 */
import { CommandId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { OrchestratorV2 } from "../../../orchestration-v2/Orchestrator.ts";
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
      for (const run of runs.filter((candidate) => candidate.status === "queued")) {
        const message = messages.find((candidate) => candidate.id === run.userMessageId);
        if (
          message?.loom?.origin === undefined ||
          message.notification !== undefined ||
          message.delegatedCompletion !== undefined
        )
          continue;
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
