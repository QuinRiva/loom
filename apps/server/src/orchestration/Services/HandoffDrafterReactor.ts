import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * HandoffDrafterReactor — settles `/handoff` fork-drafter roots exactly once at
 * their turn end (plan `plans/2026-07-19-handoff-fork-drafter.md`, D5/D6).
 *
 * A drafter is a parentless `handoff-drafter` fork of a source pi thread; it
 * drafts brief(s), calls `goal_handoff` (each recorded as a durable
 * `thread.handoff-recorded` marker → `handoffDestinations`), and ends its turn. There
 * is no `turn.completed` domain event, so this reactor treats a drafter's
 * `thread.session-set` leaving `running` (its latest kickoff turn terminal) as
 * the authoritative turn-end and settles:
 *
 * - ≥1 recorded handoff ⇒ converge success: lane `done` → request
 *   `thread.session.stop` (mandatory — decider archive is metadata-only and
 *   would otherwise leak a live pi process) → `thread.archive`.
 * - 0 recorded handoffs ⇒ raise `needs_guidance` (visible failure).
 *
 * It also raises `needs_guidance` on a drafter's `thread.turn-start-failed`
 * (no existing rail covers roots) and, via a periodic timer, on a drafter whose
 * kickoff hung past a generous grace window. Settlement uses deterministic
 * command ids (drafter id + settled turn id) + a startup/periodic reconciliation
 * scan so a crash between done/stop/archive converges safely.
 */
export interface HandoffDrafterReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /** Resolves when the internal processing queue is empty and idle (tests). */
  readonly drain: Effect.Effect<void>;
}

export class HandoffDrafterReactor extends Context.Service<
  HandoffDrafterReactor,
  HandoffDrafterReactorShape
>()("t3/orchestration/Services/HandoffDrafterReactor") {}
