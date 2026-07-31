/**
 * ThreadDeletionReactor - Thread terminal-state cleanup reactor service interface.
 *
 * Owns background workers that react to a thread reaching a terminal state and
 * perform best-effort runtime cleanup for provider sessions and terminals.
 *
 * loom: the trigger set is broader than the upstream name suggests. Upstream
 * reacted to `thread.deleted` only; the fork also reclaims on
 * `thread.plan-lane-set` (`done`/`cancelled`) and `thread.archived`, because in
 * a workstream those are the *normal* ends of a thread's life and deletion is
 * the rare one — leaving a finished thread's PTYs running leaked ~21 GB of dev
 * servers on the cockpit host and OOM-killed the unit. The module keeps its
 * upstream filename and service tag deliberately: both files are byte-identical
 * to upstream apart from this, and renaming them would trade a real merge
 * conflict surface on every upstream pull for a cosmetic gain.
 *
 * @module ThreadDeletionReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * ThreadDeletionReactorShape - Service API for thread terminal-state cleanup.
 */
export interface ThreadDeletionReactorShape {
  /**
   * Start reacting to the orchestration domain events that put a thread into a
   * terminal state (`thread.deleted`, `thread.archived`, and
   * `thread.plan-lane-set` for the `done`/`cancelled` lanes).
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * ThreadDeletionReactor - Service tag for thread terminal-state cleanup workers.
 */
export class ThreadDeletionReactor extends Context.Service<
  ThreadDeletionReactor,
  ThreadDeletionReactorShape
>()("t3/orchestration/Services/ThreadDeletionReactor") {}
