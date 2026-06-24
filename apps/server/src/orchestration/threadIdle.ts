import type { OrchestrationSession, ThreadId } from "@t3tools/contracts";

/**
 * Minimal thread shape the idle gate needs. Both the read-model thread
 * (`OrchestrationThread`) and the shell summary (`OrchestrationThreadShell`)
 * satisfy it, so the same predicate drives the dispatcher's pre-filter and the
 * serialized command-boundary invariant — they cannot drift.
 */
export interface IdleGateThread {
  readonly id: ThreadId;
  readonly session: OrchestrationSession | null;
}

/**
 * The single "thread idle" predicate (D-notify decision 3). A turn injected
 * into a busy thread is forwarded immediately and clobbers the in-flight turn,
 * so a dispatcher-injected wake may only land on an idle parent.
 *
 * **idle ≝ no pending turn-start AND session not `running` AND no active turn.**
 * The pending-turn-start signal closes the window between a turn being requested
 * and the runtime reporting `turn.started` (where `activeTurnId` is still null);
 * it is sourced from the projection (`getPendingTurnStartThreadIds`).
 */
export const isThreadIdle = (
  thread: IdleGateThread,
  pendingTurnStartThreadIds: ReadonlySet<ThreadId>,
): boolean =>
  !pendingTurnStartThreadIds.has(thread.id) &&
  thread.session?.status !== "running" &&
  (thread.session === null || thread.session.activeTurnId === null);
