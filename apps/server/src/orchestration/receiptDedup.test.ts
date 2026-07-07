import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { describe, expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";

import { OrchestrationCommandDeferredError, OrchestrationCommandInvariantError } from "./Errors.ts";
import {
  DEFAULT_WAKE_RATE_GUARD,
  makeReceiptDedupedDelivery,
  makeWakeRateBudget,
} from "./receiptDedup.ts";

// A never-accepting receipt store: dedup then rests entirely on the local
// delivered/suppressed caches (the common case within one process).
const noReceipts = { hasAcceptedReceipt: () => Effect.succeed(false) };

const deferred = new OrchestrationCommandDeferredError({
  commandType: "thread.turn.start",
  detail: "parent busy",
});

describe("ReceiptDedupedDelivery — through the interface", () => {
  effectIt.effect("deliverOnce delivers once, then reports already-handled", () =>
    Effect.gen(function* () {
      const dedup = yield* makeReceiptDedupedDelivery(noReceipts);
      const runs = yield* Ref.make(0);
      const dispatch = Ref.update(runs, (n) => n + 1);

      const first = yield* dedup.deliverOnce("cmd-1", dispatch);
      const second = yield* dedup.deliverOnce("cmd-1", dispatch);

      expect(first).toBe("delivered");
      expect(second).toBe("already-handled");
      // The dispatch effect ran exactly once — the second call short-circuits.
      expect(yield* Ref.get(runs)).toBe(1);
      expect(yield* dedup.alreadyHandled("cmd-1")).toBe(true);
      expect(yield* dedup.wasDelivered("cmd-1")).toBe(true);
    }),
  );

  effectIt.effect(
    "a deferred dispatch reports deferred and records nothing; a retry delivers",
    () =>
      Effect.gen(function* () {
        const dedup = yield* makeReceiptDedupedDelivery(noReceipts);
        const attempts = yield* Ref.make(0);
        // First attempt defers (busy parent), second attempt succeeds.
        const dispatch = Effect.gen(function* () {
          const n = yield* Ref.updateAndGet(attempts, (x) => x + 1);
          if (n === 1) return yield* Effect.fail(deferred);
          return undefined;
        });

        const first = yield* dedup.deliverOnce("cmd-defer", dispatch);
        expect(first).toBe("deferred");
        // Nothing recorded: the deterministic id stays redeliverable.
        expect(yield* dedup.alreadyHandled("cmd-defer")).toBe(false);
        expect(yield* dedup.wasDelivered("cmd-defer")).toBe(false);

        const second = yield* dedup.deliverOnce("cmd-defer", dispatch);
        expect(second).toBe("delivered");
        expect(yield* dedup.wasDelivered("cmd-defer")).toBe(true);
      }),
  );

  effectIt.effect(
    "a non-deferred dispatch failure propagates (deliverOnce swallows only the deferred error)",
    () =>
      Effect.gen(function* () {
        const dedup = yield* makeReceiptDedupedDelivery(noReceipts);
        const invariant = yield* dedup
          .deliverOnce(
            "cmd-fail",
            Effect.fail(
              new OrchestrationCommandInvariantError({
                commandType: "thread.turn.start",
                detail: "boom",
              }),
            ),
          )
          .pipe(Effect.flip);
        expect(invariant._tag).toBe("OrchestrationCommandInvariantError");
        // A real failure records nothing.
        expect(yield* dedup.alreadyHandled("cmd-fail")).toBe(false);
      }),
  );

  effectIt.effect(
    "markSuppressed makes alreadyHandled true but wasDelivered false — the poisoning class as a test",
    () =>
      Effect.gen(function* () {
        const dedup = yield* makeReceiptDedupedDelivery(noReceipts);
        yield* dedup.markSuppressed("cmd-parked");

        // A rail loop skips it (already handled locally this process)...
        expect(yield* dedup.alreadyHandled("cmd-parked")).toBe(true);
        // ...but a cross-rail "was the parent actually told?" is NEVER fooled by
        // a suppression — this is exactly the hazard the old raw-set discipline
        // defended by comment, now unrepresentable through the interface.
        expect(yield* dedup.wasDelivered("cmd-parked")).toBe(false);
      }),
  );

  effectIt.effect(
    "a fresh instance (simulated restart) with an accepted receipt reports handled + delivered",
    () =>
      Effect.gen(function* () {
        // The durable receipt store has the command; the in-memory caches are
        // empty (fresh process). Both checks fall through to the receipt.
        const durable = new Set<string>(["cmd-restart"]);
        const dedup = yield* makeReceiptDedupedDelivery({
          hasAcceptedReceipt: (id) => Effect.succeed(durable.has(id)),
        });

        expect(yield* dedup.alreadyHandled("cmd-restart")).toBe(true);
        expect(yield* dedup.wasDelivered("cmd-restart")).toBe(true);
        // A deliverOnce for it is a no-op (already durable).
        const ran = yield* Ref.make(false);
        const outcome = yield* dedup.deliverOnce("cmd-restart", Ref.set(ran, true));
        expect(outcome).toBe("already-handled");
        expect(yield* Ref.get(ran)).toBe(false);
      }),
  );

  effectIt.effect("a receipt hit is cached into the delivered set (not re-read every check)", () =>
    Effect.gen(function* () {
      const reads = yield* Ref.make(0);
      const dedup = yield* makeReceiptDedupedDelivery({
        hasAcceptedReceipt: () => Ref.updateAndGet(reads, (n) => n + 1).pipe(Effect.as(true)),
      });
      yield* dedup.wasDelivered("cmd-cache");
      yield* dedup.wasDelivered("cmd-cache");
      yield* dedup.alreadyHandled("cmd-cache");
      // Only the first check hit the receipt store; the rest served the cache.
      expect(yield* Ref.get(reads)).toBe(1);
    }),
  );
});

describe("WakeRateBudget", () => {
  it("does not trip on a slow-cadence job, records deliveries only when told", () => {
    const budget = makeWakeRateBudget();
    const now = 10_000_000;
    // Record 50 slow-cadence wakes (5 min apart) — never trips.
    for (let i = 0; i < 50; i++) budget.recordDelivery("parent", now - i * 5 * 60_000);
    expect(budget.wouldTrip("parent", now)).toBe(false);
  });

  it("trips on a tight spin-loop within the rolling window", () => {
    const budget = makeWakeRateBudget();
    const now = 10_000_000;
    for (let i = 0; i < DEFAULT_WAKE_RATE_GUARD.maxInWindow; i++) {
      budget.recordDelivery("parent", now - 100);
    }
    expect(budget.wouldTrip("parent", now)).toBe(true);
  });

  it("trips on the absolute backstop regardless of cadence", () => {
    const budget = makeWakeRateBudget();
    const now = 10_000_000;
    for (let i = 0; i < DEFAULT_WAKE_RATE_GUARD.absoluteBackstop; i++) {
      budget.recordDelivery("parent", now - i * 60 * 60_000);
    }
    expect(budget.wouldTrip("parent", now)).toBe(true);
  });

  it("keeps a separate budget per parent", () => {
    const budget = makeWakeRateBudget();
    const now = 10_000_000;
    for (let i = 0; i < DEFAULT_WAKE_RATE_GUARD.maxInWindow; i++) {
      budget.recordDelivery("busy", now - 100);
    }
    expect(budget.wouldTrip("busy", now)).toBe(true);
    // A different parent with no history is unaffected.
    expect(budget.wouldTrip("quiet", now)).toBe(false);
  });

  it("wouldTrip is a pure check — it does not consume budget", () => {
    const budget = makeWakeRateBudget();
    const now = 10_000_000;
    for (let i = 0; i < 5; i++) budget.recordDelivery("parent", now);
    // Repeated checks never mutate; the answer is stable.
    expect(budget.wouldTrip("parent", now)).toBe(false);
    expect(budget.wouldTrip("parent", now)).toBe(false);
  });
});
