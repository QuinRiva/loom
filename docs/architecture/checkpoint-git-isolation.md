# Why the checkpointer's `git add -A` cannot touch your git state

If you are an agent (or a human) who noticed `git add -A` running in your
worktree that you did not start, and you are worried it is staging your files or
racing your commit: **it is not, and it cannot.** This document is the answer, so
nobody has to re-investigate it. The question has been asked and settled once
already.

## What you are seeing

Loom captures a filesystem checkpoint roughly **twice per turn** — a baseline at
turn start and a snapshot at turn end — to back the per-turn diff view and
revert-to-turn-N. Each capture runs, in your worktree:

```
git read-tree HEAD
git add -A -- .
git write-tree
git commit-tree <tree>
git update-ref refs/t3/checkpoints/<b64url threadId>/{turn,baseline}/<n> <commit>
```

That `add -A` is the alarming-looking line.

## Why it is safe: `GIT_INDEX_FILE`

Every one of those commands runs with `GIT_INDEX_FILE` pointed at a throwaway,
uniquely-named index inside the shared `.git` directory
(`apps/server/src/vcs/GitVcsDriver.ts` — `captureCheckpoint`, see the
`t3-checkpoint-index-<uuid>` path and `commitEnv`). The temp index is deleted in
an `Effect.ensuring` finaliser, and because it is named per capture, even two
simultaneous captures in one worktree cannot contend with each other.

So the `add -A` stages into _that file_, never into `.git/index`. Verified
empirically, not just read:

| Assertion                                                                | Result            |
| ------------------------------------------------------------------------ | ----------------- |
| `.git/index` content and mtime unchanged across a full capture           | unchanged         |
| Partial staging survives (staged `a.txt` only; `b.txt` left untracked)   | survives          |
| `b.txt` still reported `??` by `git status` afterwards                   | yes               |
| …while the checkpoint commit's tree nonetheless contains `b.txt`         | yes               |
| Mid-merge `UU` conflict: `MERGE_HEAD` + all three unmerged stages intact | intact            |
| Any `*.lock` file created under `.git` during a capture                  | none              |
| Capture run _while another process holds `.git/index.lock`_              | succeeds (exit 0) |

Consequences worth stating plainly:

- **Your staging is yours.** `git add <specific files>` followed by a bare
  `git commit` commits exactly what you staged, even if a capture fires in
  between. There is no window in which "everything" is staged.
- **In-progress merges, rebases and cherry-picks are undisturbed** — including
  the `pnpm ship` flow. A capture snapshots the conflict-markered tree into a
  checkpoint object, which is harmless and arguably the correct content for a
  "state of the tree at this moment" snapshot.
- **The checkpointer is neither a contender for nor a victim of
  `.git/index.lock`.** It never takes it, and it succeeds while you hold it.
- **It is not a poller.** `CheckpointReactor` contains no timer; it is driven
  purely by turn-start/turn-end events.

## If you _did_ hit an `index.lock` failure

The checkpointer is not the culprit. `fatal: Unable to create '…/index.lock':
File exists.` (exit 128) comes from a real-index writer. The candidates are:

- **`commitAll`** (`apps/server/src/vcs/GitVcsDriverCore.ts`) — the recognisable
  triple `git add -A`; `git diff --cached --quiet`; `git rev-parse HEAD`. Used by
  workstream fan-in and by worktree provisioning's base-commit snapshot. This is
  the real-index path: serialised in-process by `WorktreeMutationLock` and gated
  on child quiescence. An in-process lock cannot serialise against a separate
  process, so every one of these commit sites — provisioning's base commit and
  the fan-in reactor's child/parent commits alike — absorbs cross-process
  contention with the shared bounded retry `GIT_LOCK_RETRY`
  (`apps/server/src/git/gitLockRetry.ts`). The retry is the mechanism that
  matters here; a commit that still fails after it is a real failure and settles
  as one.
- **The commit-panel UI action**, which deliberately stages everything — but only
  when a user clicks it.

Nothing commits _your staging_ automatically. The only automatic commits are the
fan-in/provisioning `wip: workstream snapshot`-style commits above, which run
`commitAll` against the real index — so an unexplained `wip:` commit on your
branch is one of those, not the checkpointer (checkpoint captures are
`commit-tree` objects that no branch points at).

## The one checkpoint path that does mutate your worktree

**Revert** (`restoreCheckpoint`: `git restore --worktree --staged`, `git clean
-fd`, `git reset`) genuinely rewrites the worktree and index — but it is an
explicit user action, and `CheckpointReactor` refuses it outright when any other
live thread shares the worktree, precisely because it would destroy their
uncommitted work.

Revert is also the only path that deletes checkpoint refs. Because deleting a
**packed** ref needs `packed-refs.lock`, that deletion can lose a race with
another git process; a surviving stale baseline ref would win the once-per-turn
capture check at the next turn start and anchor the next diff to a pre-revert
tree. The deletion is therefore a single atomic batched `git update-ref --stdin`
transaction with a bounded retry, and it fails loudly (surfacing a revert-failure
activity) rather than silently leaving stale refs behind.
