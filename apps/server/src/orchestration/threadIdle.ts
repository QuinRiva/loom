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

/**
 * Thread fork (MVP) — the lazy first-fork-launch gate. A forked child copies its
 * SOURCE's live pi session file via `pi --fork`, so forking while the source is
 * mid-turn risks capturing an unclosed tool call. This decides, at the child's
 * first launch, whether that launch must be refused.
 *
 * It is NOT gated at fork creation (the agent tool is called by the source
 * thread DURING its own turn, so the source is expectedly busy then and nothing
 * has been forked yet). It fires only at the child's FIRST launch — identified
 * by the child having no session file yet — and never on a later resume (the
 * child's own file exists, so no re-fork happens regardless of source state).
 */
export const shouldRefuseForkLaunch = (input: {
  readonly forkFromThreadId: ThreadId | null;
  readonly childSessionFileExists: boolean;
  readonly source: IdleGateThread | undefined;
  readonly pendingTurnStartThreadIds: ReadonlySet<ThreadId>;
}): boolean =>
  input.forkFromThreadId !== null &&
  !input.childSessionFileExists &&
  input.source !== undefined &&
  !isThreadIdle(input.source, input.pendingTurnStartThreadIds);
