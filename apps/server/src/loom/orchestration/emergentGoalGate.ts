/**
 * A goal-less root's FIRST emergent-goal derivation, shared by the two callers that race for
 * it: the emergent-goal reactor (at the thread's first message) and the session composer (at
 * the thread's first launch, which waits for it so the goal lands in the launch identity).
 * Whoever asks first starts it; the other joins it, so it runs once per thread per process.
 *
 * A service of its own because the composer sits below the orchestrator the derivation
 * dispatches through: `EmergentGoalsLive` binds the deriver when it is built. Unbound (a test
 * composer, or a boot without the control plane), `settle` returns at once.
 *
 * @module loom/orchestration/emergentGoalGate
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class EmergentGoalGate extends Context.Service<
  EmergentGoalGate,
  {
    readonly bind: (derive: (threadId: ThreadId) => Effect.Effect<void>) => Effect.Effect<void>;
    /** Starts or joins the thread's first derivation; done when it has settled either way. */
    readonly settle: (threadId: ThreadId) => Effect.Effect<void>;
  }
>()("t3/loom/orchestration/emergentGoalGate") {}

export const layer = Layer.effect(
  EmergentGoalGate,
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    let derive: ((threadId: ThreadId) => Effect.Effect<void>) | undefined;
    const started = new Map<ThreadId, Deferred.Deferred<void>>();
    return {
      bind: (deriver) =>
        Effect.sync(() => {
          derive = deriver;
        }),
      settle: (threadId) =>
        Effect.suspend(() => {
          const existing = started.get(threadId);
          if (existing !== undefined) return Deferred.await(existing);
          if (derive === undefined) return Effect.void;
          const done = Deferred.makeUnsafe<void>();
          started.set(threadId, done);
          // Forked into the gate's scope: a caller that stops waiting never cuts it short.
          return derive(threadId).pipe(
            Effect.ensuring(Deferred.succeed(done, undefined)),
            Effect.forkIn(scope),
            Effect.andThen(Deferred.await(done)),
          );
        }),
    };
  }),
);
