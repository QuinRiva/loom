import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface ExhaustionResumeSweepShape {
  /**
   * Start the background exhaustion-resume sweep within the provided scope. The
   * sweep scans the session projection for threads that stalled on a provider
   * subscription limit (`session.status === "error"` &&
   * `lastErrorClass === "quota_exhausted"`) and, once their intended provider is
   * healthy again, dispatches a control-plane resume turn so the never-delivered
   * work finishes. Restart-safe by construction: the trigger is the persisted
   * projection, not in-memory timers.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class ExhaustionResumeSweep extends Context.Service<
  ExhaustionResumeSweep,
  ExhaustionResumeSweepShape
>()("t3/orchestration/Services/ExhaustionResumeSweep") {}
