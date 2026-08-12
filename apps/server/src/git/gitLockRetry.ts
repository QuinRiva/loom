import * as Duration from "effect/Duration";
import * as Schedule from "effect/Schedule";

/**
 * Bounded retry for a git operation that lost a lock file (`index.lock`,
 * `packed-refs.lock`) to another git process — typically an agent's OWN git
 * subprocess in the same worktree, which the in-process `WorktreeMutationLock`
 * cannot serialise against. That contention is brief and self-resolving, so
 * 3 attempts (~150ms → 300ms backoff, sub-second total) absorb it while a
 * genuinely-broken operation still fails promptly and settles as a real
 * failure.
 *
 * Only ever apply it to an IDEMPOTENT operation: `commitAll` on a now-clean
 * tree reports a no-op, `update-ref delete` of a missing ref exits 0.
 */
export const GIT_LOCK_RETRY = Schedule.exponential(Duration.millis(150)).pipe(Schedule.take(2));
