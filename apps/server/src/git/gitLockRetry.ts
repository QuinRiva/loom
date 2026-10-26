import * as Duration from "effect/Duration";
import * as Schedule from "effect/Schedule";

/**
 * Bounded retry for a git op that lost a lock file to another git process, typically the agent's
 * own git in the same worktree. 3 attempts (~150ms then 300ms) absorb that while a broken op still
 * fails promptly. IDEMPOTENT ops only.
 */
export const GIT_LOCK_RETRY = Schedule.max([
  Schedule.exponential(Duration.millis(150)),
  Schedule.recurs(2),
]);
