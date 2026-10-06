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
- **DL-603 — The restored goal tasks have new ids, and ticks wait for QA.** A task under the
  QA-fix parent is ticked only when its fix is in PR #333 **and** in the rebuilt QA instance.
  A coder ticking its own task when it submits is reopened until then.
- **DL-634 — Consult forks keep the target's own tool set (Carl's direction).** Carl, on the
  QA plan `plans/consult-thread-fork-failure/plan.mdx` (written in QA worktree `t3-9e9fa432`):
  "I never liked the way that we limited which tools a consult thread could use … it caused
  problems where … that thread … would try to do something that it needed to do in order to
  answer the question but couldn't." So the `--tools read,grep,find,ls` narrowing and the
  appended read-only system prompt go; read-only becomes an instruction in the consult turn.
  The one kept limit is control-plane identity: the fork has no MCP credential, so it cannot
  submit, spawn or flag as the target. Side effect: no renamed core tool is removed
  mid-conversation, so the provider 400 (`tool_removal references unknown tool 'bash'`)
  cannot occur on the consult path. Coder's first cut (`ba10ec368c`) fixed it instead by
  patching the third-party `pi-anthropic-messages` bridge (which renames `bash`→`Bash` in the
  tool list but not in `tool_removal` blocks); that patch stays for QA agent dirs as a
  defence for other tool-shrinking paths, but the consult no longer depends on it. The plan's
  stub-and-block alternative was not taken. Sent back via the review gate.
- **DL-670 — Task-tree deletions are restorable by resubmitting the deleted line with its
  id; the removal echo lists the removed lines; `goal_update` is owner-only.** No
  confirmation flag, so normal prunes cost nothing extra. (Verifier F1/F2; DL-601 was this
  bug.)
- **DL-680 — The quiescence grace runs from the later of the last run's completion and the
  reopen time; a synthesised report never replaces a submitted report's path.** (Verifier
  B2.)
