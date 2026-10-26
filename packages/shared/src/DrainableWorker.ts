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
 * @param options.capacity - loom: bound the queue; `enqueue` suspends while it is full.
 */
export const makeDrainableWorker = Effect.fn("DrainableWorker.makeDrainableWorker")(function* <
  A,
  E,
  R,
>(
  process: (item: A) => Effect.Effect<void, E, R>,
  options?: { readonly capacity?: number }, // loom: optional bound
): Effect.fn.Return<DrainableWorker<A>, never, Scope.Scope | R> {
  const outstanding = yield* TxRef.make(0);
  const queue = yield* Effect.acquireRelease(
    // loom: optional bound; `TxQueue.offer` retries while a bounded queue is full.
    options?.capacity === undefined ? TxQueue.unbounded<A>() : TxQueue.bounded<A>(options.capacity),
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
 * A coalescing trigger worker for bare wake-ups whose idempotent pass rereads durable state: one
 * pass running and one pending at most, so cost tracks the pass rate. The pending flag clears in
 * the transaction marking the pass running, before it reads, so no trigger is lost. `drain`
 * resolves once nothing runs or is pending.
 */
export const makeCoalescingWorker = Effect.fn("DrainableWorker.makeCoalescingWorker")(function* <
  E,
  R,
>(
  process: Effect.Effect<void, E, R>,
): Effect.fn.Return<DrainableWorker<void>, never, Scope.Scope | R> {
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
