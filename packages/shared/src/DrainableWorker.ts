/**
 * DrainableWorker - A queue-based worker that exposes a `drain()` effect.
 *
 * Wraps the common `Queue.unbounded` + `Effect.forever` pattern and adds
 * a signal that resolves when the queue is empty **and** the current item
 * has finished processing. This lets tests replace timing-sensitive
 * `Effect.sleep` calls with deterministic `drain()`.
 *
 * Two constructors, sharing one interface:
 * - {@link makeDrainableWorker} — the queueing default: every enqueued item is
 *   processed, in order, exactly once. Use it whenever items carry a payload.
 * - {@link makeCoalescingWorker} — for a payload-free *trigger* that runs one
 *   idempotent pass: any number of triggers arriving while a pass runs collapse
 *   into at most ONE follow-up pass. Use it when N queued triggers would only
 *   do the same work N times and the pass can saturate under bursty arrival.
 *
 * @module DrainableWorker
 */
import * as Scope from "effect/Scope";
import * as Effect from "effect/Effect";
import * as TxQueue from "effect/TxQueue";
import * as TxRef from "effect/TxRef";

export interface DrainableWorker<A> {
  /**
   * Enqueue a work item and track it for `drain()`.
   *
   * This wraps `Queue.offer` so drain state is updated atomically with the
   * enqueue path instead of inferring it from queue internals.
   */
  readonly enqueue: (item: A) => Effect.Effect<void>;

  /**
   * Resolves when the queue is empty and the worker is idle (not processing).
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * Create a drainable worker that processes items from an unbounded queue.
 *
 * The worker is forked into the current scope and will be interrupted when
 * the scope closes. A finalizer shuts down the queue.
 *
 * @param process - The effect to run for each queued item.
 * @returns A `DrainableWorker` with `queue` and `drain`.
 */
export const makeDrainableWorker = <A, E, R>(
  process: (item: A) => Effect.Effect<void, E, R>,
): Effect.Effect<DrainableWorker<A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const queue = yield* Effect.acquireRelease(TxQueue.unbounded<A>(), TxQueue.shutdown);
    const outstanding = yield* TxRef.make(0);

    yield* TxQueue.take(queue).pipe(
      Effect.tap((a) =>
        Effect.ensuring(
          process(a),
          TxRef.update(outstanding, (n) => n - 1),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    const drain: DrainableWorker<A>["drain"] = TxRef.get(outstanding).pipe(
      Effect.tap((n) => (n > 0 ? Effect.txRetry : Effect.void)),
      Effect.tx,
    );

    const enqueue = (element: A): Effect.Effect<boolean, never, never> =>
      TxQueue.offer(queue, element).pipe(
        Effect.tap(() => TxRef.update(outstanding, (n) => n + 1)),
        Effect.tx,
      );

    return { enqueue, drain } satisfies DrainableWorker<A>;
  });

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
