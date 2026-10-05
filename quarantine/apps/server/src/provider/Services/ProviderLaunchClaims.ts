/**
 * loom: ProviderLaunchClaims — an in-process "a provider launch is in flight for
 * this thread" registry, and the final guard against a stuck-launch recovery
 * double-launching a turn.
 *
 * ## Why the compare-and-swap is not enough on its own
 *
 * The stuck-launch recovery (`orchestration/stuckLaunchRecovery.ts`) pins two CAS
 * tokens — the session's `updatedAt` and the thread's latest user-message stamp —
 * so any turn-start that *commits new state* after the recovery judged the wedge
 * makes the repair fail. That closes every window in which the world moves
 * forward. It does NOT close the window in which the world has already moved and
 * then simply **stops writing**:
 *
 * 1. A genuine turn-start commits `thread.message-sent` and the reactor writes
 *    `session.status = "starting"` (`ProviderCommandReactor` ~line 578).
 * 2. The reactor calls `providerService.startSession(...)` (~line 685) and
 *    **blocks there** — spawning a process, forking a pi session, handshaking MCP.
 *    While it is blocked it writes nothing: no further session event, no runtime
 *    binding (that lands in `bindSessionToThread` *after* the call resolves).
 * 3. The sweep now samples exactly the state step 1 left behind. `starting` with
 *    no active turn, past its grace, no adapter session, no binding. Both CAS
 *    tokens match, because nothing has changed *since* — the launch is mid-flight,
 *    not stale.
 * 4. Recovery's repair is applied and its `requireIdle` prompt is sent. Then
 *    `startSession` resolves and the original prompt lands too. **Two agents.**
 *
 * The distinguishing fact in step 3 is not in any projection or table — it is that
 * a call is on the stack. So the guard has to be an in-memory claim held across
 * that span, which is what this service is.
 *
 * ## Why in-memory (and not the durable lease that was considered)
 *
 * This window is strictly **in-process**: it only exists while *this* server has a
 * `startSession` call outstanding. The cross-process case — a provider that
 * outlived a previous server — is covered separately and durably by the
 * non-`stopped` `provider_session_runtime` binding check in `loom/startup.ts` and
 * the liveness sweep. So a durable lease would add persistence, expiry, and
 * crash-recovery semantics to cover a window that cannot outlive the process that
 * created it: if the process dies mid-launch, the child dies with it and the claim
 * *should* vanish. Ref-counted in-memory state is the honest model.
 *
 * Reads are fail-closed by construction: a held claim means "do not touch", and
 * the map is only ever consulted to *suppress* recovery, never to authorise it.
 *
 * @module ProviderLaunchClaims
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface ProviderLaunchClaimsShape {
  /**
   * Run `effect` while a launch claim is held for `threadId`. The claim is
   * released when the effect finishes **however it finishes** — success, failure,
   * defect, or interruption — so a crashed or interrupted launch cannot wedge the
   * thread as permanently unrecoverable.
   *
   * Ref-counted, so overlapping claims for one thread (the turn-start span and the
   * forked `sendTurn` it hands off to) nest correctly and the claim only clears
   * once the last holder is done.
   */
  readonly withClaim: <A, E, R>(
    threadId: ThreadId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  /** Is a provider launch in flight for this thread right now? */
  readonly isClaimed: (threadId: ThreadId) => Effect.Effect<boolean>;
}

export class ProviderLaunchClaims extends Context.Service<
  ProviderLaunchClaims,
  ProviderLaunchClaimsShape
>()("t3/provider/Services/ProviderLaunchClaims") {}

/**
 * The live registry. A plain `Map` of ref-counts is safe without a lock: Effect
 * fibres are cooperatively scheduled on one JS thread, and each mutation below is
 * a synchronous read-modify-write with no yield point inside it.
 */
export const ProviderLaunchClaimsLive = Layer.sync(ProviderLaunchClaims, () => {
  const counts = new Map<ThreadId, number>();

  const acquire = (threadId: ThreadId) =>
    Effect.sync(() => {
      counts.set(threadId, (counts.get(threadId) ?? 0) + 1);
    });

  const release = (threadId: ThreadId) =>
    Effect.sync(() => {
      const next = (counts.get(threadId) ?? 1) - 1;
      if (next <= 0) counts.delete(threadId);
      else counts.set(threadId, next);
    });

  return {
    // `acquireUseRelease` guarantees the release runs on every exit path,
    // including interruption — the property that keeps a claim from leaking.
    withClaim: (threadId, effect) =>
      Effect.acquireUseRelease(
        acquire(threadId),
        () => effect,
        () => release(threadId),
      ),
    isClaimed: (threadId) => Effect.sync(() => (counts.get(threadId) ?? 0) > 0),
  } satisfies ProviderLaunchClaimsShape;
});
