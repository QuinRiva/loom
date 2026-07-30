// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

/**
 * WorkspaceLease — the single authority on "is a process actually using this
 * directory?", and the only gate a worktree removal may pass through
 * (post-completion engagement plan §7).
 *
 * Why a lease and not a predicate: occupancy used to be inferred from the plan
 * lane (terminal ⇒ nobody home), which is false for the case this exists to
 * protect — a human resuming a `done` sub-thread to ask it a question. But a
 * *snapshot* liveness check is still check-then-act: a process can start
 * between the check and `git worktree remove --force`, which is exactly the
 * three-second window that deleted a worktree under a live pi process. So
 * reservation and removal share one lease instead of one predicate evaluated
 * twice:
 *
 * - {@link WorkspaceLeaseShape.hold} is taken by the session-start path BEFORE
 *   the provider process is spawned (a driver can only register a child after
 *   spawn, so the pre-spawn gap is part of the race) and by provisioning for
 *   the tree it just created. Many concurrent holds per path are fine — this is
 *   an occupant lease, not a mutex.
 * - {@link WorkspaceLeaseShape.withExclusive} is the only way to run a removal.
 *   It fails fast (returns `Option.none`) while any hold is outstanding and
 *   blocks new holds for its duration, which is what makes check+remove atomic
 *   with respect to starts. Both removers are periodic and idempotent, so a
 *   skip simply retries on the next pass.
 *
 * Plan lane appears nowhere here: terminal must never imply safe-to-delete.
 *
 * Relationship to `WorktreeMutationLock` (its closest cousin): that lock
 * serialises *git mutations* per repo cwd between the provisioner and the
 * fan-in reactor and knows nothing about processes; this lease is about
 * *process occupancy* of a workspace directory. Every site that uses both
 * nests them the same way — mutation lock OUTSIDE, `withExclusive` INSIDE —
 * and that order is deadlock-free for two independent reasons: `withExclusive`
 * never queues (it fails fast), and the one place that waits on a lease while
 * holding a lock (provisioning taking a hold on the tree it just cut, under the
 * parent's lock) can only be waiting on a removal that does not need that
 * parent lock, so no cycle can close.
 *
 * In-memory and server-owned: a restart drops every hold, which is correct —
 * no provider process outlives the server that spawned it.
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
  "t3/workspace/WorkspaceLease",
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

  const hold: WorkspaceLeaseShape["hold"] = (path, holder) =>
    Effect.gen(function* () {
      const key = NodePath.resolve(path);
      const state = yield* stateFor(key);
      const holdId = nextHoldId++;
      // Waiting for the permit stays interruptible — a hold queued behind an
      // in-flight removal must remain cancellable — but once `take` returns, the
      // map entry must be recorded with no interruption point in between.
      //
      // `uninterruptibleMask` + `restore` is the whole mechanism, and there is
      // deliberately NO interrupt compensation here: `Semaphore.take`
      // (`Semaphore.ts:227-246`) increments `taken` only on the path that
      // actually acquires, and an interrupted queued waiter merely deletes its
      // own observer. So an interrupted `take` has taken nothing and needs no
      // release. "Compensating" it credits a permit no one held, and a pool one
      // permit OVER capacity lets `withExclusive` succeed while a live process
      // holds the tree — the production incident, re-armed. Under-crediting
      // would merely immortalise a worktree; over-crediting deletes live work,
      // so this direction of the invariant is the load-bearing one.
      yield* Effect.uninterruptibleMask((restore) =>
        restore(state.semaphore.take(1)).pipe(
          Effect.flatMap(() => Effect.sync(() => state.holds.set(holdId, holder))),
        ),
      );
      return { path: key, holder, release: releaseHold(state, holdId) } satisfies WorkspaceHold;
    });

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
