/**
 * WorkstreamDispatcher - Dependency-gated sub-thread scheduler interface.
 *
 * The sole authority over when a Workstream sub-thread starts running. Spawn is
 * create-only; this reactor watches thread created/status/dependency events and
 * fires the deferred kick-off turn for every un-started sub-thread whose
 * `blockedBy` dependencies have all reached `done`.
 *
 * @module WorkstreamDispatcher
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * WorkstreamDispatcherShape - Service API for the dependency-gated scheduler.
 */
export interface WorkstreamDispatcherShape {
  /**
   * Start reacting to thread created/status-set/dependencies-set events and
   * promoting ready sub-threads.
   *
   * The returned effect must be run in a scope so the worker fiber can be
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
 * WorkstreamDispatcher - Service tag for the dependency-gated scheduler.
 */
export class WorkstreamDispatcher extends Context.Service<
  WorkstreamDispatcher,
  WorkstreamDispatcherShape
>()("t3/orchestration/Services/WorkstreamDispatcher") {}
