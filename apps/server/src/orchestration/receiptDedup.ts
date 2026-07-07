import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";

import type { OrchestrationDispatchError } from "./Errors.ts";

/**
 * The error channel a `deliverOnce` dispatch effect may carry: an engine
 * dispatch (`OrchestrationDispatchError`) plus the `PlatformError` its
 * preparation (crypto id / report read) contributes. `deliverOnce` swallows the
 * deferred case (reporting `"deferred"`), so its residual failure channel is
 * every other tag — matching the old per-rail `catchTag` on `engine.dispatch`.
 */
type DispatchInput = OrchestrationDispatchError | PlatformError.PlatformError;
type DispatchFailure = Exclude<
  DispatchInput,
  { readonly _tag: "OrchestrationCommandDeferredError" }
>;

/**
 * Shared receipt-dedup delivery module (LOOM-ONLY).
 *
 * The orchestration engine already receipt-dedups every command
 * (`OrchestrationEngine.processEnvelope` returns early on an accepted receipt),
 * so at-most-once is an *engine* guarantee for any deterministic `server:`
 * command id. What every wake/notice rail re-implements around it is the same
 * bookkeeping convention: an in-memory handled-set cache in front of the durable
 * receipt, an idle-gated dispatch that treats a deferral as "not delivered,
 * retry next pass — record nothing", and a park/skip path that suppresses
 * locally without any receipt behind it.
 *
 * The last of those is the documented hazard (the old WorkstreamDispatcher
 * `handledChildWakes` "poisoning" comment): a park path adds a command id to the
 * cache with no receipt, so any later "was X *actually delivered*?" question must
 * remember to consult the durable receipt, never the cache. This module makes
 * that distinction structural: `deliverOnce`/`markSuppressed` record into
 * disjoint sets, and `wasDelivered` reads only the delivered set (∪ receipt),
 * never the suppressed set — the poisoning class is unrepresentable through the
 * interface.
 */

export type DeliveryOutcome = "delivered" | "deferred" | "already-handled";

/**
 * Receipt-deduped delivery for one rail-owner closure. `RE` is the error channel
 * of the injected receipt lookup (propagated by the durable-check methods).
 */
export interface ReceiptDedupedDelivery<RE = never> {
  /**
   * Skip check for a rail loop: true when this command id was delivered durably
   * (local record or accepted receipt) OR suppressed locally this process
   * (park/known-noise). Caches durable hits so receipts are not re-read every
   * pass.
   */
  readonly alreadyHandled: (commandId: string) => Effect.Effect<boolean, RE>;

  /**
   * DURABLE-delivery check only: satisfied by a local delivery record or an
   * accepted receipt — NEVER by a local suppression. This is the primitive for
   * cross-rail "did the parent actually hear X?" questions (the `recovered`
   * rail, `alreadyNoticedByPriorRail`). The park path cannot poison it by
   * construction.
   */
  readonly wasDelivered: (commandId: string) => Effect.Effect<boolean, RE>;

  /**
   * Deliver at most once: no-op (`already-handled`) when handled; runs the given
   * dispatch effect otherwise. An `OrchestrationCommandDeferredError` is caught
   * and reported as `deferred` with NOTHING recorded, so the deterministic id
   * stays redeliverable on the next pass. Only a real delivery is recorded (as
   * delivered, durability backed by the engine's receipt write).
   */
  readonly deliverOnce: <R>(
    commandId: string,
    dispatch: Effect.Effect<unknown, DispatchInput, R>,
  ) => Effect.Effect<DeliveryOutcome, RE | DispatchFailure, R>;

  /**
   * Record as handled WITHOUT delivery — the explicit park/skip path. Local only
   * (a restart forgets it; the durable truth is that no receipt exists), and
   * invisible to `wasDelivered`. This is what the raw set-adds on the park paths
   * did implicitly.
   */
  readonly markSuppressed: (commandId: string) => Effect.Effect<void>;
}

export const makeReceiptDedupedDelivery = <RE>(deps: {
  readonly hasAcceptedReceipt: (commandId: string) => Effect.Effect<boolean, RE>;
}): Effect.Effect<ReceiptDedupedDelivery<RE>> =>
  Effect.sync(() => {
    // Two disjoint process-local caches of the recomputable durable state.
    // `delivered` caches durable hits (a local delivery or an accepted receipt);
    // `suppressed` records park/skip decisions that have NO receipt behind them.
    // Safe as plain mutable sets because every consumer runs on a serial worker
    // fibre. Both are only caches: a miss falls through to the receipt store, so
    // a fresh process recomputes the true delivered set from receipts (and
    // simply forgets suppressions — matching the old behaviour, where a genuine
    // runaway re-trips the guard and re-parks).
    const delivered = new Set<string>();
    const suppressed = new Set<string>();

    // Durable-only membership: local delivery record OR an accepted receipt.
    // Caches a receipt hit so it is not re-read every pass. NEVER consults
    // `suppressed`.
    const durablyDelivered = (commandId: string): Effect.Effect<boolean, RE> =>
      delivered.has(commandId)
        ? Effect.succeed(true)
        : deps
            .hasAcceptedReceipt(commandId)
            .pipe(
              Effect.tap((hit) =>
                hit ? Effect.sync(() => delivered.add(commandId)) : Effect.void,
              ),
            );

    const alreadyHandled = (commandId: string): Effect.Effect<boolean, RE> =>
      suppressed.has(commandId) ? Effect.succeed(true) : durablyDelivered(commandId);

    const deliverOnce = <R>(
      commandId: string,
      dispatch: Effect.Effect<unknown, DispatchInput, R>,
    ): Effect.Effect<DeliveryOutcome, RE | DispatchFailure, R> =>
      Effect.gen(function* () {
        if (yield* alreadyHandled(commandId)) return "already-handled" as DeliveryOutcome;
        return yield* dispatch.pipe(
          Effect.map((): DeliveryOutcome => {
            delivered.add(commandId);
            return "delivered";
          }),
          // A deferral (busy parent, idle-gated command) records nothing so the
          // deterministic id stays redeliverable on the next idle drain; every
          // other dispatch failure re-fails, exactly as the old per-call
          // `catchTag` left non-deferred failures to propagate.
          Effect.catchTag(
            "OrchestrationCommandDeferredError",
            (): Effect.Effect<DeliveryOutcome> => Effect.succeed("deferred"),
          ),
        );
      });

    return {
      alreadyHandled,
      wasDelivered: durablyDelivered,
      deliverOnce,
      markSuppressed: (commandId: string) => Effect.sync(() => void suppressed.add(commandId)),
    };
  });

// ---------------------------------------------------------------------------
// Wake rate budget (per-parent runaway guard).
// ---------------------------------------------------------------------------

export interface WakeRateGuardConfig {
  readonly windowMs: number;
  readonly maxInWindow: number;
  readonly absoluteBackstop: number;
}

/**
 * Runaway guard (decision 5): generously-defaulted, rate-based park-and-escalate.
 *
 * Two independent catches:
 * - **Rate window** — the primary, cadence-based signal. Real work has slow
 *   generations (minutes of child work each); a spin-loop fires many wakes in a
 *   short window. The window is tuned so a slow-cadence overnight job never
 *   trips it.
 * - **Absolute backstop** — a deliberately high interim ceiling that trips after
 *   `absoluteBackstop` total wakes for a parent **regardless of cadence**. This
 *   is an accepted interim limit, not a cadence signal: even a legitimate
 *   long-running job is parked once it has generated this many wake-generations.
 *   500 is set high enough that hitting it is a non-issue in practice; the
 *   stronger heartbeat/investigator solution (D-liveness) will replace it.
 */
export const DEFAULT_WAKE_RATE_GUARD: WakeRateGuardConfig = {
  windowMs: 60_000,
  maxInWindow: 30,
  absoluteBackstop: 500,
};

/**
 * Pure guard predicate: would delivering one more wake for this parent (whose
 * prior wake timestamps are `timestamps`) breach the rolling-window rate or the
 * absolute backstop? The backstop trips on total count alone, independent of
 * cadence.
 */
export const wakeRateGuardTrips = (
  timestamps: ReadonlyArray<number>,
  now: number,
  config: WakeRateGuardConfig = DEFAULT_WAKE_RATE_GUARD,
): boolean => {
  const inWindow = timestamps.reduce(
    (count, at) => (at >= now - config.windowMs ? count + 1 : count),
    0,
  );
  return inWindow + 1 > config.maxInWindow || timestamps.length + 1 > config.absoluteBackstop;
};

/**
 * Per-parent wake-rate budget: the `wakeTimestamps` history + `wakeRateGuardTrips`
 * choreography shared by the delta, per-child, and yield rails, extracted as a
 * small stateful object. Orthogonal to per-command dedup (a rail can use
 * `deliverOnce` without it — e.g. gate traversals), so it is a separate export.
 */
export interface WakeRateBudget {
  /** Would one more wake for this parent trip the guard? Pure check, no mutation. */
  readonly wouldTrip: (parentId: string, now: number) => boolean;
  /** Record a real delivery against the parent's budget. */
  readonly recordDelivery: (parentId: string, now: number) => void;
}

export const makeWakeRateBudget = (
  config: WakeRateGuardConfig = DEFAULT_WAKE_RATE_GUARD,
): WakeRateBudget => {
  const timestamps = new Map<string, number[]>();
  return {
    wouldTrip: (parentId, now) => wakeRateGuardTrips(timestamps.get(parentId) ?? [], now, config),
    recordDelivery: (parentId, now) => {
      const history = timestamps.get(parentId) ?? [];
      timestamps.set(parentId, [...history, now]);
    },
  };
};
