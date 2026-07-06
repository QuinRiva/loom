import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * WorkstreamFanInReactor — reacts to an isolated child's plan lane reaching a
 * terminal state and merges its `ws/…` branch back into the parent branch
 * (worktree-isolation plan §3). On a clean merge it records `fanInState`
 * `completed` (releasing dependents) and removes the child worktree + branch
 * (occupancy-gated); on conflict it aborts and records `conflicted`, keeping the
 * worktree for the orchestrator to resolve. A cancelled isolated child gets its
 * worktree committed + removed — deferred until its provider session is
 * quiescent (cancel-race hardening) — keeping the branch recoverable.
 */
export interface WorkstreamFanInReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /** Resolves when the internal processing queue is empty and idle (tests). */
  readonly drain: Effect.Effect<void>;
}

export class WorkstreamFanInReactor extends Context.Service<
  WorkstreamFanInReactor,
  WorkstreamFanInReactorShape
>()("t3/orchestration/Services/WorkstreamFanInReactor") {}
