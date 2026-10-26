// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

/**
 * Per-worktree-path mutex. Provisioning and fan-in both mutate the parent worktree's git state
 * (`commit -A`, `merge`) on separate fibres; unserialised, a provisioning snapshot commit can race a
 * fan-in merge or commit another child's conflicted merge. Distinct worktrees stay concurrent.
 */
export class WorktreeMutationLock extends Context.Service<
  WorktreeMutationLock,
  {
    readonly withLock: <A, E, R>(
      worktreePath: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>()("t3/git/WorktreeMutationLock") {}

const make = Effect.gen(function* () {
  const locks = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());

  const semaphoreFor = (key: string) =>
    SynchronizedRef.modifyEffect(locks, (current) => {
      const existing = Option.fromNullishOr(current.get(key));
      return Option.match(existing, {
        onNone: () =>
          Semaphore.make(1).pipe(
            Effect.map((semaphore) => {
              const next = new Map(current);
              next.set(key, semaphore);
              return [semaphore, next] as const;
            }),
          ),
        onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
      });
    });

  const withLock = <A, E, R>(worktreePath: string, effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(semaphoreFor(NodePath.resolve(worktreePath)), (semaphore) =>
      semaphore.withPermit(effect),
    );

  return WorktreeMutationLock.of({ withLock });
});

export const layer = Layer.effect(WorktreeMutationLock, make);
