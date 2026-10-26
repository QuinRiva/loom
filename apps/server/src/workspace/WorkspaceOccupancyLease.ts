// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

/**
 * The only gate a worktree removal passes; a terminal plan lane never means safe-to-delete. Starts
 * `hold` a path before spawning; removal runs in `withExclusive`, which fails fast while any hold
 * is out and blocks new holds, so check+remove is atomic. Nest inside `WorktreeMutationLock`
 * (deadlock-free: it never queues). Named apart from upstream's `workspaceLease.ts` (case clash).
 */

export interface WorkspaceHold {
  /** Resolved workspace path this hold protects. */
  readonly path: string;
  readonly holder: string;
  /** Idempotent — releasing twice is a no-op. */
  readonly release: Effect.Effect<void>;
}

export interface WorkspaceLeaseShape {
  /**
   * Register an occupant of `path` and return its releasable handle. Waits
   * while a removal of that path is in flight (never while holding another
   * lock — see the module note on ordering).
   */
  readonly hold: (path: string, holder: string) => Effect.Effect<WorkspaceHold>;
  /**
   * Run `effect` with `path` exclusively reserved for removal: `Option.none`
   * when any hold is outstanding (caller skips; the next pass retries), and no
   * new hold on that path can be granted until it completes.
   */
  readonly withExclusive: <A, E, R>(
    path: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E, R>;
  /**
   * Release every hold registered by `holder`. The death-time path: a provider
   * process that exited holds nothing, whether or not it exited cleanly.
   */
  readonly releaseHolder: (holder: string) => Effect.Effect<void>;
  /** Advisory snapshot of occupied paths, for classification/display only. */
  readonly occupiedPaths: Effect.Effect<ReadonlySet<string>>;
  /**
   * Holders currently holding `path`. Diagnostic: lets a test assert the
   * one-live-hold-per-owner invariant directly rather than inferring it from
   * whether removal happens to be refused.
   */
  readonly holdersOf: (path: string) => Effect.Effect<ReadonlyArray<string>>;
}

export class WorkspaceLease extends Context.Service<WorkspaceLease, WorkspaceLeaseShape>()(
  "t3/workspace/WorkspaceOccupancyLease/WorkspaceLease",
) {}

/**
 * Permit pool per path: holds take one, an exclusive removal takes all. Sized
 * far above any plausible number of concurrent processes in one workspace so
 * "all permits" is genuinely "no occupants".
 */
const HOLD_PERMITS = 1_000_000;

interface PathState {
  readonly semaphore: Semaphore.Semaphore;
  /** holdId → holder; membership IS the hold, so release is idempotent. */
  readonly holds: Map<number, string>;
}

/**
 * Build a standalone lease. Exported so a test can hold the very instance it
 * hands to the reactor under test and drive real reservation races through it.
 */
export const makeWorkspaceLease = Effect.gen(function* () {
  const states = yield* SynchronizedRef.make(new Map<string, PathState>());
  let nextHoldId = 0;

  const stateFor = (key: string) =>
    SynchronizedRef.modifyEffect(states, (current) => {
      const existing = current.get(key);
      if (existing !== undefined) return Effect.succeed([existing, current] as const);
      return Semaphore.make(HOLD_PERMITS).pipe(
        Effect.map((semaphore) => {
          const state: PathState = { semaphore, holds: new Map() };
          const next = new Map(current);
          next.set(key, state);
          return [state, next] as const;
        }),
      );
    });

  const releaseHold = (state: PathState, holdId: number) =>
    Effect.suspend(() =>
      state.holds.delete(holdId) ? Effect.asVoid(state.semaphore.release(1)) : Effect.void,
    );

  const hold: WorkspaceLeaseShape["hold"] = Effect.fn("WorkspaceOccupancyLease.hold")(
    function* (path, holder) {
      const key = NodePath.resolve(path);
      const state = yield* stateFor(key);
      const holdId = nextHoldId++;
      // Waiting for the permit stays interruptible, but once `take` returns the map entry is
      // recorded with no interruption point. No interrupt compensation: an interrupted `take`
      // acquired nothing, and crediting it overfills the pool so `withExclusive` deletes live work.
      yield* Effect.uninterruptibleMask((restore) =>
        restore(state.semaphore.take(1)).pipe(
          Effect.flatMap(() => Effect.sync(() => state.holds.set(holdId, holder))),
        ),
      );
      return { path: key, holder, release: releaseHold(state, holdId) } satisfies WorkspaceHold;
    },
  );

  const withExclusive: WorkspaceLeaseShape["withExclusive"] = (path, effect) =>
    Effect.flatMap(stateFor(NodePath.resolve(path)), (state) =>
      state.semaphore.withPermitsIfAvailable(HOLD_PERMITS)(effect),
    );

  const releaseHolder: WorkspaceLeaseShape["releaseHolder"] = (holder) =>
    Effect.flatMap(SynchronizedRef.get(states), (current) =>
      Effect.forEach(
        [...current.values()].flatMap((state) =>
          [...state.holds.entries()]
            .filter(([, entry]) => entry === holder)
            .map(([holdId]) => releaseHold(state, holdId)),
        ),
        (release) => release,
        { discard: true },
      ),
    );

  const occupiedPaths = SynchronizedRef.get(states).pipe(
    Effect.map(
      (current) =>
        new Set(
          [...current.entries()].filter(([, state]) => state.holds.size > 0).map(([key]) => key),
        ) as ReadonlySet<string>,
    ),
  );

  const holdersOf: WorkspaceLeaseShape["holdersOf"] = (path) =>
    SynchronizedRef.get(states).pipe(
      Effect.map((current) => [...(current.get(NodePath.resolve(path))?.holds.values() ?? [])]),
    );

  return WorkspaceLease.of({ hold, withExclusive, releaseHolder, occupiedPaths, holdersOf });
});

export const layer = Layer.effect(WorkspaceLease, makeWorkspaceLease);
