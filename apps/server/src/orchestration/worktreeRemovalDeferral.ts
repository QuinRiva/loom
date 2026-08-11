import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

/**
 * Episode-scoped logging for a worktree removal that is deferred because the
 * workspace is occupied. Shared by the two removers — `WorkstreamFanInReactor`
 * and `WorktreeReaper` — because both pass through
 * `WorkspaceLease.withExclusive` and both used to log one line per attempt.
 *
 * Occupancy is normal, real and transient, and the retry is correct: the last
 * occupant of a fanned-in child's worktree is usually its ATTACHED reviewer,
 * whose provider session is stopped on an idle timer, so removal is legitimately
 * retried for minutes and then succeeds. A skipped attempt spawns no
 * subprocess (the lease short-circuits before any git command) — the only cost
 * was the log line, and at one INFO line per attempt this single message was
 * 560 of 1,062 INFO lines (53%) on a production boot.
 *
 * An EPISODE is the contiguous run of skips for one path, closed by the removal
 * that finally succeeds. The first skip and the close are INFO — so "removal was
 * deferred, and here is when it landed and how long it took" stays readable at
 * default level — and every attempt in between is DEBUG.
 *
 * The episode map is keyed by path and only ever holds paths currently being
 * deferred, so it is bounded by concurrent deferrals; an episode that never
 * closes (thread reopened, worktree removed by hand) leaks one small entry per
 * path for the process lifetime, exactly like the reactor's other
 * process-scoped bookkeeping sets.
 */
export const makeRemovalDeferralLog = (namespace: string) => {
  const episodes = new Map<string, { readonly sinceMs: number; attempts: number }>();
  return {
    /** Record one skipped removal attempt. INFO on the first of an episode, DEBUG after. */
    skipped: (path: string) =>
      Effect.gen(function* () {
        const episode = episodes.get(path);
        if (episode !== undefined) {
          episode.attempts += 1;
          return yield* Effect.logDebug(`${namespace}: worktree removal still deferred`, {
            path,
            attempts: episode.attempts,
          });
        }
        episodes.set(path, { sinceMs: yield* Clock.currentTimeMillis, attempts: 1 });
        yield* Effect.logInfo(`${namespace}: worktree removal deferred, workspace is occupied`, {
          path,
        });
      }),
    /** Close an episode: logs the deferral summary, or nothing when there was no deferral. */
    removed: (path: string) =>
      Effect.gen(function* () {
        const episode = episodes.get(path);
        if (episode === undefined) return;
        episodes.delete(path);
        yield* Effect.logInfo(`${namespace}: deferred worktree removal completed`, {
          path,
          attempts: episode.attempts,
          deferredForMs: (yield* Clock.currentTimeMillis) - episode.sinceMs,
        });
      }),
  };
};
