import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { makeCoalescingWorker, makeDrainableWorker } from "./DrainableWorker.ts";

describe("makeDrainableWorker", () => {
  it.live("waits for work enqueued during active processing before draining", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const releaseSecond = yield* Deferred.make<void>();

        const worker = yield* makeDrainableWorker((item: string) =>
          Effect.gen(function* () {
            if (item === "first") {
              yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
              yield* Deferred.await(releaseFirst);
            }

            if (item === "second") {
              yield* Deferred.succeed(secondStarted, undefined).pipe(Effect.orDie);
              yield* Deferred.await(releaseSecond);
            }

            processed.push(item);
          }),
        );

        yield* worker.enqueue("first");
        yield* Deferred.await(firstStarted);

        const drained = yield* Deferred.make<void>();
        yield* Effect.forkChild(
          worker.drain.pipe(
            Effect.tap(() => Deferred.succeed(drained, undefined).pipe(Effect.orDie)),
          ),
        );

        yield* worker.enqueue("second");
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(secondStarted);

        expect(yield* Deferred.isDone(drained)).toBe(false);

        yield* Deferred.succeed(releaseSecond, undefined);
        yield* Deferred.await(drained);

        expect(processed).toEqual(["first", "second"]);
      }),
    ),
  );
});

describe("makeCoalescingWorker", () => {
  it.live("collapses a burst of triggers arriving mid-pass into exactly one follow-up pass", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let passes = 0;
        const passStarted = yield* Deferred.make<void>();
        const releasePass = yield* Deferred.make<void>();

        const worker = yield* makeCoalescingWorker(
          Effect.gen(function* () {
            passes += 1;
            if (passes === 1) {
              yield* Deferred.succeed(passStarted, undefined).pipe(Effect.orDie);
              yield* Deferred.await(releasePass);
            }
          }),
        );

        yield* worker.enqueue();
        yield* Deferred.await(passStarted);

        // 20 triggers land while pass 1 is executing. A queueing worker would run
        // 20 more identical passes; coalescing must run exactly ONE.
        for (let i = 0; i < 20; i += 1) yield* worker.enqueue();

        yield* Deferred.succeed(releasePass, undefined);
        yield* worker.drain;

        expect(passes).toBe(2);
      }),
    ),
  );

  it.live("never loses a wake: a trigger landing mid-pass always starts a LATER pass", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The invariant under test is ordering, not counting: the trigger arrives
        // strictly after pass 1 began, so it must be honoured by a pass that
        // STARTS after it arrived — it may never be absorbed into pass 1, which
        // had already read its state.
        const starts: Array<number> = [];
        let triggeredAt: number | null = null;
        let tick = 0;
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();

        const worker = yield* makeCoalescingWorker(
          Effect.gen(function* () {
            tick += 1;
            starts.push(tick);
            if (starts.length === 1) {
              yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
              yield* Deferred.await(releaseFirst);
            }
          }),
        );

        yield* worker.enqueue();
        yield* Deferred.await(firstStarted);

        tick += 1;
        triggeredAt = tick;
        yield* worker.enqueue();

        yield* Deferred.succeed(releaseFirst, undefined);
        yield* worker.drain;

        expect(starts.length).toBe(2);
        // Pass 1 started before the trigger; pass 2 started after it.
        expect(starts[0]!).toBeLessThan(triggeredAt!);
        expect(starts[1]!).toBeGreaterThan(triggeredAt!);
      }),
    ),
  );

  it.live("drain resolves with no pass having run when nothing was ever triggered", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let passes = 0;
        const worker = yield* makeCoalescingWorker(Effect.sync(() => void (passes += 1)));
        yield* worker.drain;
        expect(passes).toBe(0);
      }),
    ),
  );

  it.live("a trigger after quiescence starts a fresh pass", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let passes = 0;
        const worker = yield* makeCoalescingWorker(Effect.sync(() => void (passes += 1)));

        yield* worker.enqueue();
        yield* worker.drain;
        expect(passes).toBe(1);

        yield* worker.enqueue();
        yield* worker.drain;
        expect(passes).toBe(2);
      }),
    ),
  );

  it.live("drain does not resolve while a pass is still running", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const worker = yield* makeCoalescingWorker(
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined).pipe(Effect.orDie);
            yield* Deferred.await(release);
          }),
        );

        yield* worker.enqueue();
        yield* Deferred.await(started);

        const drained = yield* Deferred.make<void>();
        yield* Effect.forkChild(
          worker.drain.pipe(
            Effect.tap(() => Deferred.succeed(drained, undefined).pipe(Effect.orDie)),
          ),
        );
        yield* Effect.yieldNow;
        expect(yield* Deferred.isDone(drained)).toBe(false);

        yield* Deferred.succeed(release, undefined);
        yield* Deferred.await(drained);
      }),
    ),
  );

  it.live("a failing pass does not wedge the worker: later triggers still run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The dispatcher wraps its pass so failures are logged, not raised, but the
        // worker must not depend on that: a defect in one pass must leave the
        // trigger loop alive (a wedged loop is a silent total stall).
        let passes = 0;
        const worker = yield* makeCoalescingWorker(
          Effect.suspend(() => {
            passes += 1;
            return passes === 1 ? Effect.fail("boom") : Effect.void;
          }).pipe(Effect.ignore),
        );

        yield* worker.enqueue();
        yield* worker.drain;
        yield* worker.enqueue();
        yield* worker.drain;

        expect(passes).toBe(2);
      }),
    ),
  );
});
