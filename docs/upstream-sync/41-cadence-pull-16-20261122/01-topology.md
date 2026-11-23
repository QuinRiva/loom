## 1. Topology and invariants

- **Branch:** `t3/next-upstream-pull`, this worktree
  (`/home/Carl/.t3/cockpit/worktrees/loom/t3-7634b056-c406da5c5d164d3e`). It
  carries this runbook commit on top of `origin/main` `7305fc654e`. Pull 15's
  branch of the same name was deleted when PR #537 merged.
- **First parent of the merge:** the branch tip after S0 (this runbook
  commit), whose first-parent line is `origin/main`
  `7305fc654e9161e42a8c90e93a059d48af5e2096` (PR #591, 20 Nov). The cockpit
  runs `20261120-015646-6be88bb` (PR #589), two Loom PRs behind (#590 inline
  diff editing, #591 Query author on any line); §8.1 recommends deploying
  them before this pull lands. If `origin/main` moves before S1 opens, merge
  it in (never rebase) and add a DL row; re-run the sizing only if a merged
  PR touches a conflicted path.
- **Second parent:** `upstream/main` pinned at
  `a09738fb435120d08707db0142ca55b3b7b5c7ec` (2026-11-22 14:46 −0800,
  "fix(claude): start the updated Claude Code CLI when a thread changes model
  (#41086)", `v0.1.12-nightly.20261122.5111-20`). Upstream moves about 240
  commits a day; hold the pin (DL-902's precedent) unless a later commit
  touches a Loom seam that S1 would otherwise resolve twice.
- **Merge-base:** `3fa57b92a238cdd8e079af925b673b2f99618b98` = `UPSTREAM_BASE`
  (verified with `git merge-base`; pull 15's target).
- **Never rebased.** The branch lands with `pnpm ship --merge-only`.
- **Merge command:**
  `git -c rerere.enabled=false -c merge.renameLimit=30000 merge --no-commit --no-ff a09738fb435120d08707db0142ca55b3b7b5c7ec`.
  It is run once, by the S1 lead, in this worktree.
- **One merge, one merge commit, several coders (§2, §7.2).** The merge stays
  uncommitted while the lanes resolve their zones. Only the S1 lead runs git
  commands that write the index or the tree. Nobody runs `git stash`, `git
  merge --abort`, `git reset` or a branch switch in this worktree while S1 is
  open.
- **Migration lanes:** `apps/server/src/persistence/Migrations.ts`
  auto-merges and is byte-identical to upstream's in the trial tree
  (verified). Upstream adds 081 to 108 and edits 026, 064, 071, 072, 075 in
  place (§5.5). Loom's lane on `origin/main` and on the cockpit runs to
  **1072 `LoomThreadCodeQuery`** (the cockpit is at 80 / 1072); this pull
  adds **no fork migration** and edits one (1066, §5.3).
- **Every Loom hunk in an upstream file carries `// loom:`.** `pnpm ship`
  enforces it (`docs/upstream-sync/pull7-tools/unmarkedsweep.sh`). Files that
  cannot carry a marker are listed in §8.2. New this pull: the marked line in
  upstream's new `PullRequestWatchService.ts` (§4.4), the i18n exclusion
  block in the root `vite.config.ts` (§5.1), and Loom's hunk inside
  upstream's `@pierre/diffs` 1.7 patch (§6.1).
- **The trial-merge worktree**
  `/home/Carl/.t3/cockpit/worktrees/loom/t3-7634b056-pull16-trial` (a `git
  worktree` of this repo on a detached `origin/main`, mid-merge) is
  measurement-only: S1 merges in _this_ worktree, and the lead removes the
  trial worktree (`git worktree remove --force <path>`) once S1 has
  committed. Until then it is the reference every zone file's "trial line"
  numbers point at.
- **No installs before the lead's lockfile step.** Effect 4.1.5, the i18n
  packages, `@pierre/diffs` 1.7 and the new mobile packages arrive with
  upstream's `pnpm-lock.yaml`; `vp i` after `git checkout --theirs
  pnpm-lock.yaml` and §5.4's manifest lines is the first install on the
  merged tree (DL-1220). The worktree's current `node_modules` cannot
  typecheck or lint the merged tree and proves nothing about it.
- **Captures** are in `.artifacts/pull16-measure/` in this worktree
  (gitignored; Appendix A reproduces them). The measurement scripts that
  earlier pulls lost in `/tmp` are committed this time, in
  [`tools/`](tools/).
