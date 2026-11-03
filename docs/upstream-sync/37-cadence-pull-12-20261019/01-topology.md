## 1. Topology and invariants

- **Branch:** `t3/upstream-merge-pull` (this worktree's branch; DL-1200). It
  carries this runbook commit on top of `origin/main` `02a2297b61`.
- **First parent of the merge:** the branch tip after S0 (this runbook commit),
  whose first-parent line is `origin/main` `02a2297b61` (PR #406). If
  `origin/main` moves before S1, merge it in (never rebase) and add a DL row.
- **Second parent:** `upstream/main` pinned at
  `07d38b8d17167c8d17fba1184dbe13a307fada74` (2026-10-18 17:10 −0700,
  "a failed Codex turn no longer traps the queue behind its subagents", #21366).
  If upstream moves before S1, hold the pin (DL-902's precedent) unless the
  delta touches a Loom seam.
- **Merge-base:** `737192594f47d87f28b5f5a3fda3ef792a0d7972` = `UPSTREAM_BASE`.
- **Never rebased.** The branch lands with `pnpm ship --merge-only`.
- **Merge command:** `git -c rerere.enabled=false -c merge.renameLimit=30000 merge --no-commit --no-ff 07d38b8d17167c8d17fba1184dbe13a307fada74`.
- **Migration lanes:** `apps/server/src/persistence/Migrations.ts` auto-merges
  and is byte-identical to upstream's in the trial tree (verified; upstream
  adds 063 `DropUnusedV1Projections` and 064 `CanonicalizeThreadPullRequestLinks`).
  Loom's lane on `origin/main` is 1001–1059 in `LoomMigrations.ts`; this pull
  adds exactly one fork migration, 1060 `DropThreadSearchMessageTriggers`
  (DL-1251, DL-1320).
- **Every Loom hunk in an upstream file carries `// loom:`.** `pnpm ship`
  enforces it (`docs/upstream-sync/pull7-tools/unmarkedsweep.sh`).
- **Never `git stash`; never switch branches; never reset another thread's work.**
  The trial-merge worktree `/tmp/loom-pull12-trial` (a `git worktree` of this
  repo, mid-merge) is measurement-only: S1 merges in _this_ worktree, and the
  trial worktree is removed (`git worktree remove --force`) once S1 has
  committed.
