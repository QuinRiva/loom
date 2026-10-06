# Pull 9 — fixes from Carl's QA pass

Bugs Carl found pairing with the Phase 4 QA instance (`http://localhost:13940`,
`docs/upstream-sync/33-pull9-phase4-qa-guide.md`), and what was done about each. Decision
numbering continues from DL-600. The PR is the rollback boundary; nothing here is merged or
deployed.

## Decision log

- **DL-600 — PR retargeted.** A GitHub PR's head branch cannot be changed, so #332
  (head `ws/t3code/plan-next-upstream-merge/orchestrator-05cb7527` @ `bcee87ca65`) was
  closed with a pointer and replaced by **#333**, head `t3code/plan-next-upstream-merge`
  (= `bcee87ca65` + the Phase 4 fan-in merge `580362746c`). History is unchanged; every QA
  fix lands on this branch. Not merged.
- **DL-601 — Goal task tree accidentally wiped and restored (2026-10-06 21:40Z).** Adding the
  verification subtree with `goal_tasks_rewrite` from the unanchored goal owner replaced the
  whole tree, soft-deleting 54 tasks. They were read back read-only from
  `projection_goal_tasks` (`deleted_at = 2026-10-06T21:40:33.870Z`) and re-added with the same
  text, done-state, nesting and order. Deleted ids cannot be revived, so **every restored
  task has a new id** (e.g. the QA-fix task `c47fd0ab` is now `ef2e3d0d`); old ids quoted in
  earlier docs and reports no longer resolve. The two "PR #332" task texts now say #333.
- **DL-602 — "Bootstrap worktree: pnpm requires Node ≥ 22.13, current 22.12" is QA-sandbox
  only.** The sandbox mounts an empty `/home/Carl`, so the login shell that resolves the
  worktree environment never reads Carl's `~/.bashrc` (which puts `~/.n/bin` first), and
  `/etc/profile.d/env.sh` puts `/opt/conda/bin` (conda's Node 22.12.0) ahead of `/usr/bin`
  (24.12). Reproduced on the host: `env -i HOME=/tmp/emptyhome bash -lc 'node --version'` →
  v22.12.0, `HOME=/home/Carl` → v24.21.0 (`~/.n/bin/node`). Production boots with the real
  home, so not a cut-over defect; and setup would fail in QA anyway (no npm registry, guide
  §4). No change.
