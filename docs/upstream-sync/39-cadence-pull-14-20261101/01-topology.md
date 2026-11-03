## 1. Topology and invariants

- **Branch:** `t3/weekly-upstream-merge` (this worktree's branch). It carries
  this runbook commit on top of `origin/main` `fe75bb6833`.
- **First parent of the merge:** the branch tip after S0 (this runbook
  commit), whose first-parent line is `origin/main`
  `fe75bb68330d32ba05dc568f75920056458c92b6` (PR #508, 29 Oct), also the build
  deployed on the cockpit (`~/loom-releases/current` →
  `20261029-033759-fe75bb6`). If `origin/main` moves before S1, merge it in
  (never rebase) and add a DL row.
- **Second parent:** `upstream/main` pinned at
  `fa31b66bbb2ae5234205a8628a78e038d917202f` (2026-11-01 22:07 +0000,
  "fix(server): Codex sessions get T3CODE_THREAD_ID like Claude sessions
  (#28604)"). If upstream moves before S1, hold the pin (DL-902's precedent)
  unless the delta touches a Loom seam.
- **Merge-base:** `b76a110aa4cf011345ec9d63d37c2dcdf4b751ad` = `UPSTREAM_BASE`
  (verified with `git merge-base`; pull 13's target).
- **Never rebased.** The branch lands with `pnpm ship --merge-only`.
- **Merge command:**
  `git -c rerere.enabled=false -c merge.renameLimit=30000 merge --no-commit --no-ff fa31b66bbb2ae5234205a8628a78e038d917202f`.
- **Migration lanes:** `apps/server/src/persistence/Migrations.ts` auto-merges
  and is byte-identical to upstream's in the trial tree (verified). Upstream
  adds 070 `PeerLinks`, 071 `PeerLinkFence`, 072 `WaitingLinkRequestIndex`,
  073 `ActiveTurnItemIndexes`, 074 `ExcludeAttachmentPlaceholdersFromSearch`,
  075 `SubagentDeliveryState`, 076 `ProjectionProjectsPinArchive` (§6.6).
  Loom's lane on `origin/main` runs to 1066 `DropHumanMessageDigestItems`
  (1068 `LoomGoalTreeReadAt` after the catch-up merge, DL-1727);
  this pull adds **no fork migration**.
- **Every Loom hunk in an upstream file carries `// loom:`.** `pnpm ship`
  enforces it (`docs/upstream-sync/pull7-tools/unmarkedsweep.sh`). Files that
  cannot carry a marker are listed in §8.2 (amended: `scripts/effect-budget.json`
  is gone).
- **Never `git stash`; never switch branches; never reset another thread's
  work.** The trial-merge worktree `/tmp/loom-pull14-trial` (a `git worktree`
  of this repo on a detached `origin/main`, mid-merge) is measurement-only: S1
  merges in _this_ worktree, and the trial worktree is removed
  (`git worktree remove --force /tmp/loom-pull14-trial`) once S1 has committed.
