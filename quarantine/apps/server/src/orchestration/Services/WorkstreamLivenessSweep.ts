import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface WorkstreamLivenessSweepShape {
  /**
   * Start the background liveness sweep within the provided scope. The sweep
   * is the deterministic (no-LLM) D-liveness Stage-1 detector: it derives
   * dead-session / mid-turn-stall / stuck-loop / repeated-failure from the read
   * model + activity projection and sets the offending sub-thread `error`. It
   * does NOT deliver parent wakes — the `WorkstreamDispatcher` owns the per-child
   * wake rail and reacts to the `error` status it writes.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class WorkstreamLivenessSweep extends Context.Service<
  WorkstreamLivenessSweep,
  WorkstreamLivenessSweepShape
>()("t3/orchestration/Services/WorkstreamLivenessSweep") {}
