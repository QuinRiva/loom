/**
 * Restart recovery for Loom threads (plans/upstream-pull9-phase2-substrate/plan.mdx
 * §3 "Restart recovery", D20; DL-195, DL-199). Upstream commits reconciliation
 * and the continuation effect together, so Loom attaches at two seams:
 *
 * - **Rule 0** — `isContinued` is the not-continued set the `dispatchMessage`
 *   hunk vetoes a restart / usage-limit continuation with (as upstream's no-op).
 * - **`releaseHeldQueues`** — a startup pass after upstream's reconciliation
 *   (which holds every queued run): a dead thread's queued runs are cancelled, a
 *   thread owed a human stays held, a live thread with a held Loom control wake
 *   is resumed.
 *
 * - **`loomStartupRecovery`** — the one startup call: each stashed steer (seam 20)
 *   carried by the thread's restart continuation or redelivered as a steered
 *   control message, then `releaseHeldQueues`, then one dispatcher pass (a
 *   kickoff with no receipt is redelivered by promotion).
 *
 * Threads without a sidecar row keep upstream's rule.
 *
 * @module loom/recovery/loomRecoveryPolicy
 */
import {
  CommandId,
  type LoomThreadWorkstream,
  MessageId,
  type OrchestrationV2ThreadProjection,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import { loomContinuationVetoed } from "../../orchestration-v2/Orchestrator.loom.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { continueRestartedRun } from "../../orchestration-v2/RestartContinuation.ts";
import {
  controlMessage,
  redeliveredSteerText,
  steerHash,
  steerRedeliverCommandId,
} from "../orchestration/dispatcher/controlMessage.ts";
import { WorkstreamDispatcher } from "../orchestration/dispatcher/WorkstreamDispatcher.ts";
import { LoomStoreV2 } from "../projection/LoomStore.ts";
import * as PendingSteering from "../steering/pendingSteering.ts";

/**
 * A cut turn of this thread may be continued: no sidecar (upstream's rule), or a
 * live Loom thread with no outcome that owes no human an action (the §3 table
 * plus `outcome done`, DL-195). Rule 0 reads the same predicate.
 */
export const isContinued = (
  workstream: LoomThreadWorkstream | null,
  projection: Pick<OrchestrationV2ThreadProjection, "runtimeRequests">,
) =>
  !loomContinuationVetoed(
    workstream,
    projection.runtimeRequests.some((request) => request.status === "pending"),
  );

/**
 * Runs the thread's restart continuation now when its outbox effect is still due. The effect
 * worker runs `effect:restart-continuation:<run>` asynchronously, so a Loom wake dispatched at
 * startup could start a run first and turn the continuation into a no-op (the cut turn would be
 * lost, DL-376). `continueRestartedRun` is idempotent by its message and command ids, so the
 * worker's later run of the same effect does nothing.
 */
const runDueContinuation = (
  threadId: ThreadId,
  projection: Pick<OrchestrationV2ThreadProjection, "runs">,
) =>
  Effect.gen(function* () {
    // Upstream's choice of the cut run (`restartContinuationRun`): by end time, not ordinal — a
    // queued message promoted to a steer leaves a cancelled run with a higher ordinal.
    const source = projection.runs
      .filter((run) => run.status !== "queued")
      .reduce<(typeof projection.runs)[number] | undefined>(
        (latest, run) => (latest === undefined || runRanAfter(run, latest) ? run : latest),
        undefined,
      );
    if (source === undefined) return;
    const continuation = yield* (yield* EffectOutbox.EffectOutboxV2).get(
      `effect:restart-continuation:${source.id}`,
    );
    if (
      Option.isSome(continuation) &&
      (continuation.value.status === "pending" || continuation.value.status === "running")
    ) {
      yield* continueRestartedRun({ threadId, sourceRunId: source.id });
    }
  });

/** The §3 table's startup pass over Loom threads holding a queued run. Never fails startup. */
export const releaseHeldQueues = Effect.gen(function* () {
  const orchestrator = yield* OrchestratorV2;
  const loomStore = yield* LoomStoreV2;
  const startupId = DateTime.formatIso(yield* DateTime.now);
  for (const threadId of yield* loomStore.listThreadsWithHeldQueue()) {
    yield* Effect.gen(function* () {
      const workstream = (yield* loomStore.getWorkstream(threadId))!;
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const queued = projection.runs.filter((run) => run.status === "queued");
      // DL-199: per startup, so a later restart can release the same thread again.
      const commandId = (kind: "queue.resume" | "queued-run.cancel", runId?: RunId) =>
        CommandId.make(
          `server:loom:recovery:${threadId}:${startupId}:${kind}${runId === undefined ? "" : `:${runId}`}`,
        );
      // A dead thread does not wake.
      if (
        workstream.outcome === "cancelled" ||
        workstream.archivedAt !== null ||
        workstream.deletedAt !== null
      ) {
        for (const run of queued) {
          yield* orchestrator.dispatch({
            type: "queued-run.cancel",
            commandId: commandId("queued-run.cancel", run.id),
            threadId,
            runId: run.id,
          });
        }
        return;
      }
      // A human is owed an action (or the thread is done): their message is the release.
      if (!isContinued(workstream, projection)) return;
      // A live thread: a held steered-tier wake must not wait for a human. queue.resume is
      // thread-wide, so a human's queued follow-ups go too — the thread is alive.
      const loomOrigin = new Set(
        projection.messages.flatMap((message) =>
          message.loom?.origin === undefined ? [] : [message.id],
        ),
      );
      if (queued.some((run) => run.queueHeld === true && loomOrigin.has(run.userMessageId))) {
        // The continuation first, or the released wake starts a run ahead of it (DL-376).
        yield* runDueContinuation(threadId, projection);
        yield* orchestrator.dispatch({
          type: "queue.resume",
          commandId: commandId("queue.resume"),
          threadId,
        });
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("loom.recovery.release-held-queue-failed", { threadId, cause }),
      ),
    );
  }
}).pipe(
  Effect.provide(EffectOutbox.layer),
  Effect.catchCause((cause) =>
    Effect.logWarning("loom.recovery.release-held-queues-failed", { cause }),
  ),
  Effect.withSpan("loom.recovery.releaseHeldQueues"),
);

/**
 * Seam 20 (P3-24): each stashed steer — what the dead pi had accepted and never delivered
 * (DL-691) — reaches its thread once. A thread in rule 0's not-continued set keeps its stash,
 * handed to the dispatcher (`leaveStash`) for its `steerRedelivery` rail to carry into the next
 * human- or parent-started turn (DL-387). Otherwise upstream's restart continuation carries it
 * (`withStashedSteer` in its prompt, DL-690): its effect is run here when still due, so the
 * steer is delivered first and never queues behind the continuation — where a human-held queue
 * would hold it too. With no continuation it goes out as a steered control message, which starts
 * at once on the idle thread. The stash is then cleared unless pi has mirrored a newer queue.
 * Never fails; per-thread failures log.
 */
export const redeliverStashedSteers = Effect.gen(function* () {
  const orchestrator = yield* OrchestratorV2;
  const loomStore = yield* LoomStoreV2;
  for (const threadId of yield* PendingSteering.listStashed()) {
    yield* Effect.gen(function* () {
      const steer = yield* PendingSteering.read(threadId);
      if (steer === null) return yield* PendingSteering.clear(threadId, null);
      const workstream = yield* loomStore.getWorkstream(threadId);
      const projection = yield* orchestrator.getThreadProjection(threadId);
      if (!isContinued(workstream, projection))
        return yield* (yield* WorkstreamDispatcher).leaveStash(threadId, {
          text: steer,
          afterOrdinal: Math.max(0, ...projection.runs.map((run) => run.ordinal)),
        });
      yield* runDueContinuation(threadId, projection);
      // Carried: a continuation of this thread (the worker's or the one above) holds it.
      const { messages } = yield* orchestrator.getThreadRecords(threadId, ["messages"], {
        messageIds: projection.runs.map((run) =>
          MessageId.make(`message:restart-continuation:${run.id}`),
        ),
      });
      const carried = messages.some((message) =>
        message.text.endsWith(redeliveredSteerText(steer)),
      );
      if (!carried)
        yield* orchestrator.dispatch(
          controlMessage({
            threadId,
            id: steerRedeliverCommandId(threadId, steerHash(steer)),
            tier: "steered",
            origin: "control_notice",
            text: redeliveredSteerText(steer),
          }),
        );
      yield* PendingSteering.clear(threadId, steer);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("loom.recovery.steer-redelivery-failed", { threadId, cause }),
      ),
    );
  }
}).pipe(
  Effect.provide(EffectOutbox.layer),
  Effect.catchCause((cause) =>
    Effect.logWarning("loom.recovery.steer-redelivery-pass-failed", { cause }),
  ),
  Effect.withSpan("loom.recovery.redeliverStashedSteers"),
);

/**
 * The one marked startup call (after upstream's recovery and continuation effects are
 * committed): stashed steers first, so a steer the cut turn accepted precedes every queued
 * message (DL-690); then the held-queue release and one dispatcher pass.
 */
export const loomStartupRecovery = Effect.gen(function* () {
  yield* redeliverStashedSteers;
  yield* releaseHeldQueues;
  yield* (yield* WorkstreamDispatcher).runPass;
});
