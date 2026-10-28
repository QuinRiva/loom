# Shipping changes (commit → PR → merge → cleanup)

This is the single source of truth for landing approved work on `main` in this
repo: the sequence, the repo-specific gotchas, and the judgement calls the
mechanical steps leave to a person. The `shipper` role (the delegated path),
the `ship` skill (the inline path) and `AGENTS.md` all point here and do not
restate the procedure.

- The mechanical sequence is encoded in [`scripts/ship.ts`](../../scripts/ship.ts),
  run as `pnpm ship`. The script is the authoritative source for the exact
  commands and enforces the guards below; do not ship the steps by hand from
  memory.
- The judgement parts (when to ship, PR framing, spotting an upstream-sync
  branch, resolving a conflict) stay here as prose, because they need context
  the script does not have.

## Who may merge (project policy)

Merge authority is per-project, declared in `.t3code/ship.json` and resolved by
walking up from the working directory (missing file: the safe default):

```jsonc
{ "merge": { "authority": "human" } } // default: agents stop at an open PR
{ "merge": { "authority": "agent" } } // opt-in: an agent may merge after approval + checks
```

- **`human`** (the platform default): an agent's ceiling is an open, review-ready
  PR. Open it, transition any tracker card to _In Review_, then stop and hand
  back the PR URL. Never merge, even when a brief's definition of done says
  "merged".
- **`agent`**: an agent may merge once approved and green, then clean up the
  branch. This repo (loom) is `agent`, which is why the sequence below carries
  through the merge.

The policy is injected into every thread's system prompt (the SHIPPING POLICY
block), so a thread knows its merge boundary however it ships. It is guidance,
not enforcement: a human-only repo should also protect `main` so an agent token
cannot merge regardless of prompts.

### Reference links (`.t3code/links.json`)

The same walk-up resolves `.t3code/links.json`, which turns ticket keys and
PR/issue numbers in rendered agent output (chat, MDX documents, goal task text)
into links: `{ "links": [{ "pattern": "<JS regex>", "url": "…$0…$1…" }] }`,
where `$0` is the whole match and `$1`… its groups; the first rule wins at a
position, and code spans, code blocks and authored links are never linkified.
The server re-reads it each time a client connects. Loom's own file maps `#N`
to this repo's issues (GitHub redirects a PR number to the PR).

## Before you ship

- **Ship only once the change is approved.** Landing work on `main` is not a step
  you take on your own initiative: the human (or, in a workstream, the
  orchestrator acting on the human's approval) must have signed off first.
- **Honour the project's merge authority** (above).
- **The work must be ready.** If the checks fail, or the working tree carries
  changes beyond what you are shipping, stop and report that rather than
  shipping around it. The script commits every pending change (`git add -A`),
  but before any step, `--dry-run` included, it refuses while untracked (not
  gitignored) files exist, naming them and the ways out.
- **Agent commits are marked as such, automatically.** A pi process Loom launches
  commits as author `Loom agent` (the configured email, so GitHub credit is
  unchanged); its `git commit` calls add `Loom-Thread:` and `Pi-Session:`
  trailers naming the thread and session, while merge, rebase and cherry-pick
  commits get the author name only. Do not override the git identity, and read
  a commit under the human's email as agent-made unless it says otherwise.

## The gate

`vp check` and `vp run typecheck` must pass on the rebased branch; native mobile
changes also need `vp run lint:mobile`. "Checks passed" on a stale base proves
nothing, which is why the script runs the gate after the rebase. The script
also runs the unmarked-delta sweep
([`unmarkedsweep.sh`](../upstream-sync/pull7-tools/unmarkedsweep.sh)): a loom
hunk in an upstream-owned file without a `// loom:` marker fails the ship,
because the next upstream pull would drop it silently. Run `lint:mobile`
yourself when you have touched native mobile code.

## The sequence (what `scripts/ship.ts` does)

Run `pnpm ship -m "<commit message>" --summary "<one line>" --kind noticeable|behind`;
add `--merge-only` for an upstream-sync branch (below), `--pr-only` to stop at
the open PR (steps 1 to 6: the `human` ceiling, or when the human has said they will merge or close the PR themselves),
`--dry-run` to preview the steps and `--include-untracked` to commit untracked
files too (above). In order, the script:

1. `gh repo set-default QuinRiva/loom`: pins the PR target to `origin`, not the
   upstream fork parent (see the gotcha below).
2. Commits any pending changes with your commit message (skipped when the
   tree is clean).
3. Fetches and rebases onto current `origin/main` (skipped with `--merge-only`).
4. Runs the gate: `vp check`, `vp run typecheck`, the unmarked-delta sweep.
5. Pushes the branch with `git push --force-with-lease -u origin HEAD` (the
   lease lets a rebased, already-pushed branch update without clobbering
   anyone else's push).
6. Creates the PR into `main`, titled `--title` or the first line of `-m`, its
   body your `--body` then the `Loom-Summary:` / `Loom-Kind:` trailers; a
   branch that already has an open PR, such as one opened with `--pr-only`,
   reuses it instead.
7. Merges it (`gh pr merge --merge`), repeating the trailers in the merge
   commit, where deployctl reads them for the deploy toast, and confirms the
   merged state.
8. Deletes the remote branch explicitly once the merge is confirmed.

## Repo gotchas (each has bitten before)

- **Never push directly to `main`.** This is mechanical, not advisory: the tracked
  pre-push hook [`.vite-hooks/pre-push`](../../.vite-hooks/pre-push) (run by
  the Vite+ hook dispatcher, so every worktree of this clone inherits it) fails
  any push whose destination ref is `refs/heads/main`, however it is spelled
  and whichever remote it targets. Feature-branch pushes, tags and the
  `--delete` cleanup are untouched; `gh pr merge` is server-side and
  unaffected. The script also refuses to run on `main`. A genuine emergency can
  set `ALLOW_PUSH_TO_MAIN=1` for one push; if you reach for it, say so in your
  report.
- **Never `gh pr merge --delete-branch`.** These are shared-clone worktrees with
  `main` checked out elsewhere, so `--delete-branch` fails mid-way and leaves
  the remote branch undeleted. Delete the remote branch explicitly after a
  confirmed merge, which is what the script does.
- **Stacked PRs: retarget before you delete the base.** After merging the bottom
  PR of a stack, run `gh pr edit <next> --base main` before deleting the merged
  branch. GitHub does not reliably retarget a dependent PR when its base branch
  disappears (it closed #324 during pull 8), and a closed PR's base cannot be
  changed; recovery meant re-pushing the deleted head temporarily.
- **`gh repo set-default QuinRiva/loom` is mandatory.** This clone has an
  `upstream` remote (`pingdotgg/t3code`). Without the `set-default` (or an
  explicit `--repo QuinRiva/loom` on every `gh pr` call), `gh` resolves the PR
  base to the fork parent and fails with "No commits between…".
- **`gh pr merge` prints nothing on success in a piped shell**: silence is
  success, errors go to stderr. Confirm with `gh pr view --json state` before
  deleting the branch (the script does this).
- **Ahead/behind counts.** The script never needs them; the rebase settles the
  question. If you report them, use the one-sided ranges after a fetch:
  `git rev-list --count origin/main..HEAD` is commits ahead and
  `git rev-list --count HEAD..origin/main` commits behind (`X..Y` reads "in Y,
  not in X"). The two-number `git rev-list --left-right --count A...B` form is
  ordered by argument and has been misattributed before.

## Judgement calls (yours, not the script's)

- **PR framing.** When the PR wants a clearer
  title or a body that explains the change for a reviewer, pass `--title` /
  `--body`. GitHub renders every newline in a PR body or comment as a line
  break, so write one line per paragraph or list item rather than hard-wrapped
  prose, and check the posted body for mid-sentence breaks.
- **Upstream-sync branches are merge-only.** A branch that carries a
  `git merge upstream/main` commit must not be rebased or squash-merged. Ship
  it with `--merge-only` so the rebase step is skipped, and say so in your
  report. Detecting one is a judgement call: look for a
  `Merge remote-tracking branch 'upstream/main'` commit in the branch's history.
- **Merge conflicts escalate.** The script handles a clean rebase automatically; on
  a real conflict it runs `git rebase --abort`, names the conflicting files and
  exits non-zero rather than guessing. Resolving it needs the goal context the
  script does not have, so escalate to the orchestrator / human with the
  conflicting files and what each side is trying to do. In a delegated shipper
  thread that is a `mcp__t3-code__workstream_submit` with outcome
  `merge_conflict`, a yield to the orchestrator, which finishes the ship itself.
- **Resolving a conflict by hand.** Rebase again (`git fetch origin main && git
  rebase origin/main`), edit each conflicted file, stage those files by
  explicit path (never `git add -A`/`-u` mid-rebase: a wildcard marks every
  conflicted file resolved, markers and all), and `git rebase --continue`.
  Re-stage any file you edit after staging; `git commit` records the index,
  not the working tree. Confirm `git status` is clean, then run `pnpm ship`
  again; its rebase is now a no-op.
