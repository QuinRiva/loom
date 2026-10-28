---
name: ship
description: >-
  Land approved work on main in this repo: commit, push, open the PR, merge,
  delete the branch. Use whenever you are about to commit, push, PR or merge a
  change here, inline or through a shipper child, so the guarded script runs
  instead of a sequence reconstructed from memory.
---

# Ship (commit → PR → merge → cleanup)

Run the guarded script from the repo root; never reconstruct the sequence by
hand, which is how the footguns (pushing without rebasing, wrong `gh` base,
undeleted remote branches) creep back in:

```sh
pnpm ship -m "<commit message>" --summary "<what a Loom user gets, one line>" --kind <noticeable|behind>
pnpm ship … --merge-only # upstream-sync branch (see below)
pnpm ship … --dry-run    # preview the exact steps
```

It pins the PR target (`gh repo set-default QuinRiva/loom`), commits, rebases
onto current `origin/main`, runs the gate (`vp check`, `vp run typecheck`, the
unmarked-delta sweep), pushes, opens the PR into `main`, merges, confirms the
merged state and deletes the remote branch explicitly. Run `vp run lint:mobile`
yourself when you touched native mobile code.

Merge authority is per-project. loom is `agent` (`.t3code/ship.json`), so the
script carries through the merge. Under the platform default `human`, an
agent's ceiling is an open, review-ready PR, even if a brief says "done when
merged". Your system prompt's SHIPPING POLICY block states the active policy;
honour it however you ship.

## What the script leaves to you

[`docs/operations/shipping.md`](../../docs/operations/shipping.md) is the
source of truth; its "Judgement calls" section has the detail. In short:

- Ship only after approval, with only your work in the tree.
- PR framing: the PR title is the first line of `-m` and its body only the
  trailers; pass `--title` / `--body` when that would not tell a reviewer enough. Write a body or comment one line per
  paragraph; GitHub renders every newline as a line break.
- Upstream-sync branches (a `git merge upstream/main` commit in history) must
  not be rebased or squash-merged: run with `--merge-only`.
- Real rebase conflicts: the script aborts and names the files. Escalate to the
  orchestrator/human rather than guessing; the doc's "Resolving a conflict by
  hand" (explicit-path staging, `git status` clean, then `pnpm ship` again) is
  the procedure for whoever holds the goal context.

## Delegated path

In a workstream you may instead hand the release to a `shipper` child
(`roles/shipper.md`). It follows the same document and the same script, so the
inline and delegated paths never drift.
