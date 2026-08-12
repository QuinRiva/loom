import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";

import { GIT_LOCK_RETRY } from "./gitLockRetry.ts";

// Git ops on a worktree race the agent's own git subprocess (index.lock /
// packed-refs.lock contention). The retry schedule must absorb a brief failure
// but stay bounded so a genuinely-broken op still surfaces promptly. The
// backoff runs against the test clock, so advance it past the total window to
// flush retries.
describe("GIT_LOCK_RETRY", () => {
  it.effect("absorbs a failing-then-succeeding op (transient index.lock race)", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const fiber = yield* Effect.gen(function* () {
        const n = yield* Ref.updateAndGet(attempts, (x) => x + 1);
        if (n < 3) return yield* Effect.fail("index.lock: File exists" as const);
        return "committed" as const;
      }).pipe(Effect.retry(GIT_LOCK_RETRY), Effect.exit, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(1));
      expect(yield* Fiber.join(fiber)).toStrictEqual(Exit.succeed("committed"));
      expect(yield* Ref.get(attempts)).toBe(3);
    }),
  );

  it.effect("gives up after 3 attempts total when the op keeps failing", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const fiber = yield* Ref.update(attempts, (x) => x + 1).pipe(
        Effect.andThen(Effect.fail("index.lock: File exists" as const)),
        Effect.retry(GIT_LOCK_RETRY),
        Effect.exit,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(1));
      expect(Exit.isFailure(yield* Fiber.join(fiber))).toBe(true);
      expect(yield* Ref.get(attempts)).toBe(3);
    }),
  );
});
