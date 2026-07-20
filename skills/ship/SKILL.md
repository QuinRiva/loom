---
name: ship
description: >-
  Land approved work on main in this repo the right way — ship it, land this,
  open a PR, merge it, cut the release branch, get it into main. Loads the
  canonical ship procedure (rebase onto current origin/main, gate on checks,
  push, PR, merge, then delete the remote branch explicitly) so the commit → PR
  → merge → cleanup flow runs through the guarded script instead of from memory.
  Use whenever you are about to commit/push/PR/merge a change, so this repo's
  fork/worktree footguns (never push main, never gh pr merge --delete-branch,
  gh repo set-default, upstream-sync merge-only, escalate real conflicts) are
  not skipped. Covers both the inline path and the delegated shipper thread.
---

# Ship (commit → PR → merge → cleanup)

Land approved work on `main` without shipping from memory. **Never reconstruct
the sequence by hand** — that is exactly how the footguns (pushing without
rebasing, wrong `gh` base, undeleted remote branches) creep back in.

## Do this

Run the guarded script from the repo root:

```sh
pnpm ship -m "<concise summary>"              # standard feature branch
pnpm ship -m "<concise summary>" --merge-only # upstream-sync branch (see below)
```

It encodes and enforces the whole mechanical sequence:
`gh repo set-default QuinRiva/loom` → commit → rebase onto current
`origin/main` → gate (`vp check`, `vp run typecheck`) → push → open the PR into
`main` → merge → confirm the merged state → delete the remote branch explicitly.
Use `pnpm ship -m "…" --dry-run` to preview the exact steps first. Add
`vp run lint:mobile` yourself when you touched native mobile code.

**Merge authority is per-project.** loom itself is `agent` (`.t3code/ship.json`),
so this script carries through the merge. The platform default is `human`: there
an agent's ceiling is an open, review-ready PR — never merge by hand, even if a
brief says "done when merged". Your system prompt states the active policy (the
SHIPPING POLICY block); honour it however you ship.

## The judgment calls the script leaves to you

Read **[`docs/operations/shipping.md`](../../docs/operations/shipping.md)** — the
single source of truth for the full rationale. The three decisions it cannot make
for you:

- **Ship only after approval**, and only when the tree holds just the work you
  mean to ship.
- **PR framing.** Pass `--title` / `--body` when `--fill` (the commit message)
  would not tell a reviewer enough.
- **Upstream-sync branches are merge-only.** A branch carrying a
  `git merge upstream/main` commit must not be rebased or squash-merged — run
  with `--merge-only`.
- **Merge conflicts escalate.** The script auto-handles a clean rebase but
  aborts and exits non-zero on a real conflict, naming the files. Resolving it
  needs goal context the script does not have — escalate to the
  orchestrator/human rather than guessing.

## Delegated path

In a workstream you may instead hand the release to a `shipper` child (see
`roles/shipper.md`). It follows the same `docs/operations/shipping.md` procedure
and the same script, so the inline and delegated paths never drift.
