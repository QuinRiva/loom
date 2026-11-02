## 1. Topology and invariants

- **Branch:** `t3/upstream-merge-pull-13` (this worktree's branch). It carries
  this runbook commit on top of `origin/main` `b487d4319b`.
- **First parent of the merge:** the branch tip after S0 (this runbook
  commit), whose first-parent line is `origin/main` `b487d4319b25e93bfd52662301f0b56c1bf7aa11`
  (PR #436, 23 Oct), also the build deployed on the cockpit
  (`~/loom-releases/current` → `…-b487d43`). If `origin/main` moves before S1,
  merge it in (never rebase) and add a DL row.
- **Second parent:** `upstream/main` pinned at
  `b76a110aa4cf011345ec9d63d37c2dcdf4b751ad` (2026-10-25 15:45 −0700,
  "perf(mobile): compact persisted thread snapshots (#24265)"). If upstream
  moves before S1, hold the pin (DL-902's precedent) unless the delta touches
  a Loom seam.
- **Merge-base:** `07d38b8d17167c8d17fba1184dbe13a307fada74` = `UPSTREAM_BASE`
  (verified with `git merge-base`).
- **Never rebased.** The branch lands with `pnpm ship --merge-only`.
- **Merge command:** `git -c rerere.enabled=false -c merge.renameLimit=30000 merge --no-commit --no-ff b76a110aa4cf011345ec9d63d37c2dcdf4b751ad`.
- **Migration lanes:** `apps/server/src/persistence/Migrations.ts` auto-merges
  and is byte-identical to upstream's in the trial tree (verified). Upstream
  adds 065 `CodexUsageNativeTurnIndex`, 066 `RepairClientSettlementTimestamps`,
  067 `WebhookDedupe`, 068 `ShellStopRequestIndex`, 069 `ThreadMessageSearch`
  (§6.6). Loom's lane on `origin/main` runs to 1062 `ThreadSearchIndexV2`; this
  pull adds **no fork migration** under the recommended §8.1 row 1 answer (and
  exactly one, 1063, under its alternative that drops 069's objects).
  Upstream also un-exported `migrationEntries` (#24058); the two Loom tests
  that import it are repointed in S2a (§5.4), the file stays verbatim.
- **Every Loom hunk in an upstream file carries `// loom:`.** `pnpm ship`
  enforces it (`docs/upstream-sync/pull7-tools/unmarkedsweep.sh`). Files that
  cannot carry a marker (`package.json`, `scripts/effect-budget.json`,
  `routeTree.gen.ts`) are listed in §8.2 so the next pull keeps their Loom
  lines.
- **Never `git stash`; never switch branches; never reset another thread's
  work.** The trial-merge worktree `/tmp/loom-pull13-trial` (a `git worktree`
  of this repo on a detached `origin/main`, mid-merge) is measurement-only: S1
  merges in _this_ worktree, and the trial worktree is removed
  (`git worktree remove --force /tmp/loom-pull13-trial`) once S1 has committed.
