# Shipping changes (commit → PR → merge → cleanup)

This is the **single source of truth** for landing approved work on `main` in
this repo: the sequence, the repo-specific gotchas, and the judgment calls the
mechanical steps deliberately leave to a human. Everything else points here —
`roles/shipper.md` (the delegated path), the `ship` skill (the inline path), and
`AGENTS.md` all reference this document; none of them restate the procedure.

- The **mechanical** sequence is encoded in [`scripts/ship.ts`](../../scripts/ship.ts)
  (run it with `pnpm ship`). The script is the authoritative source for the exact
  commands and enforces the footgun guards below — do not ship the steps by hand
  from memory.
- The **judgment** parts (when to ship, PR framing, spotting an upstream-sync
  branch, resolving a merge conflict) stay here as prose, because they need
  context the script does not have.

## Who may merge (project policy)

Merge authority is **per-project**, declared in `.t3code/ship.json` and resolved
by walking up from the working directory (missing file → the safe default):

```jsonc
{ "merge": { "authority": "human" } } // default: agents stop at an open PR
{ "merge": { "authority": "agent" } } // opt-in: an agent may merge after approval + checks
```

- **`human`** (the platform default) — an agent's ceiling is an **open,
  review-ready PR**. Open it, transition any tracker card to _In Review_, then
  stop and hand back the PR URL. Never merge, even when a brief's definition of
  done says "merged". This is what other projects (e.g. `fathom-platform`) want.
- **`agent`** — an agent may merge once approved and green, then clean up the
  branch. **This repo (loom) is `agent`** (see `.t3code/ship.json`), which is why
  the sequence below carries through the merge.

The policy is injected into every thread's system prompt (the SHIPPING POLICY
block), so a thread knows its merge boundary however it ships. It is guidance,
not enforcement: a human-only repo should also protect `main` so an agent token
_cannot_ merge regardless of prompts. `pnpm ship` is loom's own path and loom is
`agent`, so the sequence below merges.

## Before you ship

- **Ship only once the change is approved.** Landing work on `main` is not a
  step you take on your own initiative — the human (or, in a workstream, the
  orchestrator acting on the human's approval) must have signed off first.
- **Honour the project's merge authority** (above). Under a `human` policy,
  "shipping" means opening the PR and stopping — not merging.
- **The work must be ready.** If the checks fail, or the working tree carries
  unexpected changes beyond what you are shipping, stop and report that rather
  than shipping around it.
- Intermediate `wip: workstream snapshot` / `wip(<role>): …` and `merge ws/…`
  commits on the goal branch are expected — they are the workstream's per-child
  worktree isolation and fan-in bookkeeping (writer children merge back with
  `git merge --no-ff`). They are not stray work.

## The gate

`vp check` and `vp run typecheck` must pass before the branch is pushed. Native
mobile changes also need `vp run lint:mobile`. Re-run the gate whenever a rebase
replays commits — "checks passed" on a stale base proves nothing. `scripts/ship.ts`
runs `vp check` and `vp run typecheck` after the rebase for exactly this reason;
add `lint:mobile` yourself when you have touched native mobile code.

## The sequence (what `scripts/ship.ts` does)

Run `pnpm ship -m "<concise summary>"`. For an upstream-sync branch (see below)
run `pnpm ship -m "<summary>" --merge-only`. In order, the script:

1. **`gh repo set-default QuinRiva/loom`** — pins the PR target to `origin`, not
   the upstream fork parent (see the gotcha below).
2. **Commits** any pending changes with your summary message (skipped when the
   tree is already clean).
3. **Rebases onto current `origin/main`** (`git fetch origin main` +
   `git rebase origin/main`) _before_ pushing — unless `--merge-only` is set.
4. **Runs the gate** (`vp check`, `vp run typecheck`).
5. **Pushes** the branch with `git push -u origin HEAD`.
6. **Creates the PR** into `main` (`gh pr create --base main`, using `--fill`
   unless you pass `--title`/`--body`).
7. **Merges** it (`gh pr merge --merge`) and confirms the merged state.
8. **Deletes the remote branch explicitly** once the merge is confirmed.

## Repo gotchas (each has bitten before)

- **Never push directly to `main`.** This is now mechanical, not advisory: the
  tracked pre-push hook [`.vite-hooks/pre-push`](../../.vite-hooks/pre-push)
  (run by the Vite+ hook dispatcher, so every worktree of this clone inherits
  it) fails any push whose destination ref is `refs/heads/main`, however it is
  spelled and whichever remote it targets. Feature-branch pushes, tags and the
  `--delete` cleanup are untouched, and `gh pr merge` is server-side so the
  merge is unaffected. The script also refuses to run on `main`; keep both that
  way when doing anything by hand. A genuine emergency can set
  `ALLOW_PUSH_TO_MAIN=1` for one push — if you reach for it, say so in your
  report.
- **Never `gh pr merge --delete-branch`.** These are shared-clone worktrees with
  `main` checked out elsewhere, so `--delete-branch` fails mid-way and leaves the
  remote branch undeleted. Delete the remote branch explicitly _after_ a
  confirmed merge, which is what the script does.
- **`gh repo set-default QuinRiva/loom` is mandatory.** This clone has an
  `upstream` remote (`pingdotgg/t3code`). Without the `set-default` (or an
  explicit `--repo QuinRiva/loom` on every `gh pr` call), `gh` resolves the PR
  base to the fork parent and fails with "No commits between…".
- **`gh pr merge` prints nothing on success in a piped shell** — silence is
  success; errors go to stderr. Confirm with `gh pr view --json state` before
  deleting the branch (the script does this).

## Judgment calls (yours, not the script's)

- **PR framing.** `--fill` reuses the commit message. When the PR wants a
  clearer title or a body that explains the change for a reviewer, pass
  `--title` / `--body` instead.
- **Upstream-sync branches are merge-only.** A branch that carries a
  `git merge upstream/main` commit must **not** be rebased or squash-merged —
  merge-commit only. If you are shipping one, run with `--merge-only` so the
  rebase step is skipped, and say so in your report. Detecting one is a judgment
  call: look for a `Merge remote-tracking branch 'upstream/main'` commit in the
  branch's history.
- **Merge conflicts escalate.** `scripts/ship.ts` handles a trivially clean
  rebase automatically. On anything beyond that — a real conflict — it does
  **not** guess: it runs `git rebase --abort`, names the conflicting files, and
  exits non-zero. Resolving the conflict needs the goal context the script (and
  the person shipping mechanically) does not have, so when this happens,
  **escalate to the orchestrator / human** with the conflicting files and what
  each side is trying to do. In a delegated shipper thread, that means a
  `workstream_submit` with outcome `needs_human`; point the orchestrator back at
  this document so it can finish the ship itself.
