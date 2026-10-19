import * as Cause from "effect/Cause";
import * as Scope from "effect/Scope";
import * as Effect from "effect/Effect";
import * as TxQueue from "effect/TxQueue";
import * as TxRef from "effect/TxRef";

export interface DrainableWorker<A> {
  readonly enqueue: (item: A) => Effect.Effect<void>;

  readonly drain: Effect.Effect<void>;
}

/**
 * A finalizer shuts down the queue and drops queued items, so `drain` resolves after the scope
 * closes instead of waiting on them. An item that fails or dies is logged and skipped; the worker
 * keeps processing later items and `drain` still resolves.
 *
 * @param options.capacity - loom: bound the queue; `enqueue` then suspends
 *   while `capacity` items are waiting, backpressuring the producer. Omitted,
 *   the queue is unbounded.
 */
export const makeDrainableWorker = <A, E, R>(
  process: (item: A) => Effect.Effect<void, E, R>,
  options?: { readonly capacity?: number },
): Effect.Effect<DrainableWorker<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const outstanding = yield* TxRef.make(0);
    const queue = yield* Effect.acquireRelease(
      // loom: optional bound; `TxQueue.offer` retries while a bounded queue is full.
      options?.capacity === undefined
        ? TxQueue.unbounded<A>()
        : TxQueue.bounded<A>(options.capacity),
      (queue) =>
        // Uncount only the dropped items: an item still running uncounts itself,
        // even when a parallel scope closes it after this finalizer.
        TxQueue.clear(queue).pipe(
          Effect.flatMap((dropped) => TxRef.update(outstanding, (n) => n - dropped.length)),
          Effect.andThen(TxQueue.shutdown(queue)),
          Effect.tx,
        ),
    );

    yield* TxQueue.take(queue).pipe(
      Effect.flatMap((a) =>
        // `suspend` turns a `process` that throws while building its effect
        // into this item's defect instead of the loop's.
        Effect.suspend(() => process(a)).pipe(
          // Only the item's own failure, defect, or interruption lands here and
          // the loop continues; interrupting the worker fiber still stops it.
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("DrainableWorker item failed", cause),
          ),
          Effect.ensuring(TxRef.update(outstanding, (n) => n - 1)),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    const drain: DrainableWorker<A>["drain"] = TxRef.get(outstanding).pipe(
      Effect.flatMap((n) => (n > 0 ? Effect.txRetry : Effect.void)),
      Effect.tx,
    );

    const enqueue = (element: A): Effect.Effect<boolean, never, never> =>
      TxQueue.offer(queue, element).pipe(
        Effect.tap((offered) => (offered ? TxRef.update(outstanding, (n) => n + 1) : Effect.void)),
        Effect.tx,
      );

    return { enqueue, drain } satisfies DrainableWorker<A>;
  });

// loom: coalescing trigger worker — one idempotent pass, bounded backlog.
/**
 * Create a **coalescing** trigger worker: one idempotent pass, at most one pass
 * running, at most one pass pending.
 *
 * This is the opt-in alternative to {@link makeDrainableWorker} for the case
 * where the queued item is a bare wake-up and the pass recomputes everything it
 * needs from durable state. A queueing worker turns a burst of N triggers into N
 * identical passes; when the arrival rate can exceed the pass rate that queue
 * diverges without bound and a restart silently discards the backlog. Coalescing
 * makes the steady-state cost the *pass* rate, not the *trigger* rate.
 *
 * **No-lost-wake invariant.** A trigger arriving at any time always causes at
 * least one FULL pass to *start* after it arrived. The pending flag is cleared
 * in the same transaction that marks the pass running, i.e. strictly BEFORE the
 * pass body reads anything. So a trigger either (a) arrives before that clear,
 * and the pass it starts reads state at least as new as the trigger, or (b)
 * arrives after it, re-sets the flag, and is honoured by the follow-up pass that
 * the flag guarantees. A trigger can therefore cause one redundant pass, but can
 * never be absorbed into a pass that had already read its snapshot.
 *
 * `drain` resolves only when no pass is running and none is pending, so the
 * deterministic-test contract is unchanged.
 *
 * @param process - The idempotent pass to run per (coalesced) trigger.
 */
export const makeCoalescingWorker = <E, R>(
  process: Effect.Effect<void, E, R>,
): Effect.Effect<DrainableWorker<void>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    // `running`: a pass body is executing. `pending`: at least one trigger has
    // arrived that no started pass has claimed yet. Both live in ONE TxRef so
    // the claim (pending → running) is a single atomic transition.
    const state = yield* TxRef.make({ running: false, pending: false });

    // Claim the pending trigger: block until one exists, then mark the pass
    // running and clear the flag atomically. Everything the pass reads happens
    // after this transaction commits, which is what makes the invariant hold.
    const claimPass = TxRef.get(state).pipe(
      Effect.flatMap((current) =>
        current.pending ? TxRef.set(state, { running: true, pending: false }) : Effect.txRetry,
      ),
      Effect.tx,
    );

    yield* claimPass.pipe(
      Effect.andThen(
        Effect.ensuring(
          process,
          TxRef.update(state, (current) => ({ ...current, running: false })),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    const drain: DrainableWorker<void>["drain"] = TxRef.get(state).pipe(
      Effect.tap((current) => (current.running || current.pending ? Effect.txRetry : Effect.void)),
      Effect.tx,
    );

    const enqueue = (): Effect.Effect<void> =>
      TxRef.update(state, (current) => ({ ...current, pending: true })).pipe(Effect.tx);

    return { enqueue, drain } satisfies DrainableWorker<void>;
  });
