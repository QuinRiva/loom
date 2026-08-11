/**
 * Path-based orphan detection for workstream child worktree directories.
 *
 * Every existing GC mechanism reaches worktrees through an INDEX, and there is a
 * class of residue that appears in none of them:
 *
 *  - `WorkstreamFanInReactor` walks thread rows, so it only sees directories some
 *    thread still points at.
 *  - `WorktreeReaper` walks `git worktree list` per active project, so it only
 *    sees directories git still has registered.
 *
 * A directory that has fallen out of BOTH indexes is unreachable: nothing will
 * ever enumerate it again, and it stays on disk forever. Measured on the live
 * cockpit: 43 of 51 `ws-*` directories (~14 GB) were referenced by no thread row
 * and present in no `git worktree list` — several of their parent directories were
 * no longer git worktrees either. Two mechanisms produce them: `finaliseRemoval`
 * wraps `removeWorktree` in `Effect.ignoreCause` and repoints the thread
 * regardless (so a failed removal loses its only pointer), and an orphaned
 * process can recreate a skeleton directory after removal.
 *
 * The predicate is deliberately the plain intersection of "in no index", with two
 * conservative properties:
 *
 *  - `referencedPaths` is LIFECYCLE-BLIND (it includes deleted and archived
 *    threads' paths), because a row-owned checkout is the thread lifecycle's to
 *    remove, not this sweep's.
 *  - the caller must skip the sweep entirely when it could not enumerate git for
 *    every project, since an unreadable registry makes every one of that repo's
 *    worktrees look unreferenced.
 *
 * All paths in and out are fully resolved.
 */

/**
 * Directory-name prefix of a workstream child worktree. Child branches are
 * `ws/<project>/<goal>/<role>-<id8>` and `git worktree add` sanitises `/` to `-`,
 * so the directory is `ws-…` — the one shape this sweep claims. A user-created
 * worktree under the server's worktrees dir never matches it.
 */
export const WORKSTREAM_WORKTREE_DIR_PREFIX = "ws-";

export interface OrphanWorktreeSweepInput {
  /** Resolved `<worktreesDir>/<parent>/ws-*` directories found on disk. */
  readonly candidatePaths: ReadonlyArray<string>;
  /** Resolved `worktree_path` of EVERY thread row, any lifecycle state. */
  readonly referencedPaths: ReadonlySet<string>;
  /** Resolved paths from `git worktree list` across every active project. */
  readonly gitRegisteredPaths: ReadonlySet<string>;
}

export const selectOrphanWorktreeDirs = (input: OrphanWorktreeSweepInput): ReadonlyArray<string> =>
  input.candidatePaths.filter(
    (path) => !input.referencedPaths.has(path) && !input.gitRegisteredPaths.has(path),
  );
