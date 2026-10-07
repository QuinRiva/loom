/**
 * The live waiters of `mcp__t3-code__ask_user_question`: one entry per
 * `loom-ask:` request, held by the server for the pi tool call that is
 * long-polling it. Settled from the resolved `runtime-request.updated` (the
 * ask reactor, `askUserQuestion.ts`); read by the `runtime-request.respond`
 * hunk in `Orchestrator.ts`, which withholds upstream's answer message while a
 * waiter is live.
 *
 * In memory on purpose: the tool call it serves lives in a pi process that
 * dies with the server. A `Context.Reference` whose default is the registry
 * itself — Effect caches a reference's default per key, so every `yield*`
 * in the process sees one registry and no layer has to provide it (a test may
 * provide a fresh one).
 *
 * @module loom/userInput/askWaiters
 */
import type { OrchestrationV2UserInputQuestion, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/**
 * How long after its last poll detached a waiter still counts as live. The
 * extension re-polls the moment a slice ends, so only a pi that died or lost
 * the server for this long falls through to upstream's message delivery.
 */
export const LOOM_ASK_RECONNECT_GRACE_MS = 3_000;

/** Why the ask reactor closed a request, so the cancelled event renders the right outcome. */
export type LoomAskClosing = "superseded" | "run-ended";

interface Waiter {
  readonly threadId: ThreadId;
  readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
  /** The rendered tool result. */
  readonly outcome: Deferred.Deferred<string>;
  attached: number;
  detachedAt: number;
  closing: LoomAskClosing | undefined;
}

export const makeLoomAskWaiters = () => {
  const waiters = new Map<string, Waiter>();
  return {
    /** Idempotent: a retried ask keeps its waiter. */
    open: (
      requestId: string,
      threadId: ThreadId,
      questions: ReadonlyArray<OrchestrationV2UserInputQuestion>,
    ) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        if (waiters.has(requestId)) return;
        waiters.set(requestId, {
          threadId,
          questions,
          outcome: Deferred.makeUnsafe<string>(),
          attached: 0,
          detachedAt: now,
          closing: undefined,
        });
      }),
    get: (requestId: string) => waiters.get(requestId),
    drop: (requestId: string) => Effect.sync(() => waiters.delete(requestId)),
    /** Unsettled, and polled now or within the reconnect grace. */
    isLive: (requestId: string) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        const waiter = waiters.get(requestId);
        return (
          waiter !== undefined &&
          !Deferred.isDoneUnsafe(waiter.outcome) &&
          (waiter.attached > 0 || now - waiter.detachedAt < LOOM_ASK_RECONNECT_GRACE_MS)
        );
      }),
    markClosing: (requestId: string, closing: LoomAskClosing) =>
      Effect.sync(() => {
        const waiter = waiters.get(requestId);
        if (waiter !== undefined) waiter.closing ??= closing;
      }),
    settle: (requestId: string, rendered: string) =>
      Effect.suspend(() => {
        const waiter = waiters.get(requestId);
        return waiter === undefined ? Effect.void : Deferred.succeed(waiter.outcome, rendered);
      }),
    /**
     * One long-poll slice: the outcome, `Option.none()` when the slice ended
     * first, or `undefined` when no waiter of this thread has the id. A settled
     * outcome stays collectable, so a poll whose response was lost re-reads it.
     */
    wait: (requestId: string, threadId: ThreadId, sliceMs: number) =>
      Effect.suspend(() => {
        const waiter = waiters.get(requestId);
        if (waiter === undefined || waiter.threadId !== threadId) return Effect.succeed(undefined);
        waiter.attached += 1;
        return Deferred.await(waiter.outcome).pipe(
          Effect.timeoutOption(sliceMs),
          Effect.ensuring(
            Effect.map(Clock.currentTimeMillis, (now) => {
              waiter.attached -= 1;
              waiter.detachedAt = now;
            }),
          ),
        );
      }) as Effect.Effect<Option.Option<string> | undefined>,
  };
};

export type LoomAskWaitersShape = ReturnType<typeof makeLoomAskWaiters>;

export class LoomAskWaiters extends Context.Reference<LoomAskWaitersShape>(
  "loom/userInput/LoomAskWaiters",
  { defaultValue: makeLoomAskWaiters },
) {}
