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
 * Threads without a sidecar row keep upstream's rule.
 *
 * @module loom/recovery/loomRecoveryPolicy
 */
import {
  CommandId,
  type LoomThreadWorkstream,
  type OrchestrationV2ThreadProjection,
  type RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { loomContinuationVetoed } from "../../orchestration-v2/Orchestrator.loom.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { LoomStoreV2 } from "../projection/LoomStore.ts";

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
  Effect.catchCause((cause) =>
    Effect.logWarning("loom.recovery.release-held-queues-failed", { cause }),
  ),
  Effect.withSpan("loom.recovery.releaseHeldQueues"),
);
