import type { OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ThreadDeletionReactor,
  type ThreadDeletionReactorShape,
} from "../Services/ThreadDeletionReactor.ts";

/**
 * Why a thread's runtime resources are being reclaimed. `deleted` is the
 * permanent case; the rest are terminal-but-reversible (a done/cancelled thread
 * can be reopened, an archived one unarchived).
 */
export type ThreadCleanupReason = "deleted" | "archived" | "done" | "cancelled";

export interface ThreadCleanupRequest {
  readonly threadId: ThreadId;
  readonly reason: ThreadCleanupReason;
}

/**
 * Map a domain event onto a cleanup request, or `null` when the event does not
 * put a thread into a terminal state.
 *
 * loom: the fork's plan lanes mean "the thread finished" is far more common than
 * "the thread row was deleted" — a thread that reaches `done`/`cancelled` or is
 * archived keeps its PTYs (and any `vp run dev` inside them) alive forever
 * otherwise. Terminal lanes other than these two (`yielded`, `in_progress`, …)
 * are explicitly NOT cleanup triggers: work continues on that thread.
 */
export const toThreadCleanupRequest = (event: OrchestrationEvent): ThreadCleanupRequest | null => {
  switch (event.type) {
    case "thread.deleted":
      return { threadId: event.payload.threadId, reason: "deleted" };
    case "thread.archived":
      return { threadId: event.payload.threadId, reason: "archived" };
    case "thread.plan-lane-set":
      return event.payload.planLane === "done" || event.payload.planLane === "cancelled"
        ? { threadId: event.payload.threadId, reason: event.payload.planLane }
        : null;
    default:
      return null;
  }
};

/**
 * Scrollback is evidence. Only a deleted thread — whose row is gone for good and
 * can never be reopened — has its terminal history destroyed; every reversible
 * terminal state keeps history so a reopened/unarchived thread (or a human
 * reading back what an agent ran) still has it. Killing the process is what
 * reclaims the memory; deleting the transcript reclaims nothing that matters.
 */
const shouldDeleteHistory = (reason: ThreadCleanupReason) => reason === "deleted";

export const logCleanupCauseUnlessInterrupted = <R, E>({
  effect,
  message,
  threadId,
}: {
  readonly effect: Effect.Effect<void, E, R>;
  readonly message: string;
  readonly threadId: ThreadId;
}): Effect.Effect<void, E, R> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause);
      }
      return Effect.logDebug(message, {
        threadId,
        cause: Cause.pretty(cause),
      });
    }),
  );

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const terminalManager = yield* TerminalManager.TerminalManager;

  const stopProviderSession = (threadId: ThreadId) =>
    logCleanupCauseUnlessInterrupted({
      effect: providerService.stopSession({ threadId }),
      message: "thread deletion cleanup skipped provider session stop",
      threadId,
    });

  const closeThreadTerminals = (request: ThreadCleanupRequest) =>
    logCleanupCauseUnlessInterrupted({
      effect: terminalManager.close({
        threadId: request.threadId,
        deleteHistory: shouldDeleteHistory(request.reason),
      }),
      message: "thread cleanup skipped terminal close",
      threadId: request.threadId,
    });

  const processThreadCleanup = Effect.fn("processThreadCleanup")(function* (
    request: ThreadCleanupRequest,
  ) {
    // Only deletion stops the provider session. A reversible terminal state
    // leaves it to the existing owners of that resource — the archive command
    // path (which dispatches `thread.session.stop` behind a liveness check) and
    // the idle ProviderSessionReaper — because a `done` lane write can land
    // while the very turn that produced it is still finishing, and tearing the
    // session down under it would truncate that turn.
    if (request.reason === "deleted") {
      yield* stopProviderSession(request.threadId);
    }
    // Idempotent by construction: with no `terminalId`, close iterates the
    // thread's live sessions, so a thread that already has none (repeat
    // done → reopened → done, or archived-while-done) is a no-op.
    yield* closeThreadTerminals(request);
  });

  const processThreadCleanupSafely = (request: ThreadCleanupRequest) =>
    processThreadCleanup(request).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("thread cleanup reactor failed to process event", {
          reason: request.reason,
          threadId: request.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processThreadCleanupSafely);

  const start: ThreadDeletionReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        const request = toThreadCleanupRequest(event);
        if (!request) {
          return Effect.void;
        }
        return worker.enqueue(request);
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ThreadDeletionReactorShape;
});

export const ThreadDeletionReactorLive = Layer.effect(ThreadDeletionReactor, make);
