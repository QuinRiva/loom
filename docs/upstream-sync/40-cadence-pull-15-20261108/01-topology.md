## 1. Topology and invariants

- **Branch:** `t3/next-upstream-pull` (this worktree's branch,
  `/home/Carl/.t3/cockpit/worktrees/loom/t3-77ce8748`). It carries this
  runbook commit on top of `origin/main` `ce1bdbcd96`. Pull 14's branch
  `t3/weekly-upstream-merge` still exists in another worktree and is not ours.
- **First parent of the merge:** the branch tip after S0 (this runbook
  commit), whose first-parent line is `origin/main`
  `ce1bdbcd96becb3922060615a7dde2363b97b8d5` (PR #536, 6 Nov). The cockpit
  runs `20261105-132859-30ec64c` (PR #533), three Loom PRs behind
  (#534 false needs-attention flags, #535 graph drag, #536 prose width); the
  deploy of this pull carries them (For deploy). If `origin/main` moves before
  S1, merge it in (never rebase) and add a DL row.
- **Second parent:** `upstream/main` pinned at
  `3fa57b92a238cdd8e079af925b673b2f99618b98` (2026-11-08 16:44 −0600,
  "fix(web): boring sidebar threads drag onto the composer again (#26724)").
  If upstream moves before S1, hold the pin (DL-902's precedent) unless the
  delta touches a Loom seam.
- **Merge-base:** `fa31b66bbb2ae5234205a8628a78e038d917202f` = `UPSTREAM_BASE`
  (verified with `git merge-base`; pull 14's target).
- **Never rebased.** The branch lands with `pnpm ship --merge-only`.
- **Merge command:**
  `git -c rerere.enabled=false -c merge.renameLimit=30000 merge --no-commit --no-ff 3fa57b92a238cdd8e079af925b673b2f99618b98`.
  The rename limit matters this week: upstream's `.repos/effect-smol` →
  `.repos/effect` rename is 16,673 rename pairs, and without the limit git
  reports them as delete-plus-add and the merge takes minutes longer.
- **Migration lanes:** `apps/server/src/persistence/Migrations.ts` auto-merges
  and is byte-identical to upstream's in the trial tree (verified). Upstream
  adds 077 `RepairBooleanSettledOverride`, 078 `DropOrchestrationEventCorrelationIndex`,
  079 `DelegatedRecoveryIndexes`, 080 `ScheduledTaskThreadMode` (§6.7). Loom's
  lane on `origin/main` runs to **1069 `LoomThreadLaunchStamps`** (the cockpit
  is at 76 / 1069); this pull adds **no fork migration**.
- **Every Loom hunk in an upstream file carries `// loom:`.** `pnpm ship`
  enforces it (`docs/upstream-sync/pull7-tools/unmarkedsweep.sh`). Files that
  cannot carry a marker are listed in §8.2.
- **Never `git stash`; never switch branches; never reset another thread's
  work.** The trial-merge worktree `/tmp/loom-pull15-trial` (a `git worktree`
  of this repo on a detached `origin/main`, mid-merge) is measurement-only: S1
  merges in _this_ worktree, and the trial worktree is removed
  (`git worktree remove --force /tmp/loom-pull15-trial`) once S1 has committed.
- **No installs before S1's lockfile step.** `@effect/tsgo` and Effect 4.1.2
  arrive with upstream's `pnpm-lock.yaml`; `vp i` after `git checkout --theirs
  pnpm-lock.yaml` is the first install on the merged tree (DL-1220). The
  worktree's current `node_modules` (Effect 4.0.5, tsc-rs) cannot typecheck
  the merged tree and must not be trusted for any measurement after the merge.
