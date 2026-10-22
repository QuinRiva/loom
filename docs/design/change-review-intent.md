---
manager_sessions:
  - id: 01a160f7-6ea8-77e9-8933-16575c740ed1
    name: Redesign Diff View for Pre-PR Review
    role: intent
    authored_at: 2026-10-22T00:49:16.757Z
---

# Change review before a PR: intent brief

Status: intent, not a plan. Produced by a grilling session on 2026-10-02; the wayfinder
map that works its open questions is linked from the bottom.

## Business objective

Carl reviews agent-made code changes _before_ a PR exists, from the thread he is talking
to. Today that review fails in three ways:

1. **Wrong unit.** The Diff panel's "Turn" scope is one thread's checkpoint for one of its
   turns. That is upstream's one-agent-one-thread model. In a workstream Carl talks to an
   orchestrator and the edits are made by coder children across several of their turns in
   a shared worktree, so "what changed after I said _rewrite that function_" is no single
   thread's turn. Carl: "this is how turns was supposed to work in upstream T3 code, but
   because I delegate work it doesn't translate."
2. **Blind spots.** Every scope (Turn, By coder, Branch, Uncommitted, the sidebar's +/-
   count) is computed from the worktree's own git. Work in a nested repository
   (`workbench/` in fathom worktrees is its own git repo, gitignored by the monorepo) or in
   gitignored artefact paths (`.artifacts/` in loom) never appears. Concrete case: thread
   `84354f53-2f30-45c3-b449-84c1c86b5dce`, where every coder's diff reads "No net changes in
   this selection" while `workbench/tenant-audit-absence-model/explainer.html` was edited
   and committed in the nested repo (`e4470c87`).
3. **Clutter.** The selector lists every thread and every turn whether or not it changed
   anything, so finding the one that did is a hunt.

Separately, hunk-only diffs cut off the information hierarchy Carl reviews by: _which file
changed → where in it → what the enclosing function/class does → whether the change is
appropriate_. Carl: "I can see that we've changed the way that we handle these 3 lines, but
I don't even know what function those lines are in, so I've got no idea if the change is
relevant."

## Required system capability

From the thread Carl is talking to, for its worktree:

- **Two baselines**, one selector:
  - **Incremental**: the worktree since Carl's last message in this thread, whoever edited
    it, with the ability to step back through earlier such intervals.
  - **Branch**: everything vs the base branch (today's Branch scope).
- **Changed files are visible in the file tree**: a changed file is highlighted and a folder
  inherits the highlight (VS Code's model). A filter shows only changed files.
- **Opening a changed file shows the whole file, side by side, old vs new**, changes
  highlighted, so the enclosing context is on screen.
- **Changes outside the worktree's own git are included**: nested git repositories inside
  the worktree and declared artefact paths, behind a toggle that separates "repo code
  changes" from "everything the agents wrote".
- **The selector only offers things that changed.** No empty options.

## Local objective

- Web client: the Diff panel (`apps/web/src/components/DiffPanel.tsx`,
  `apps/web/src/diffPanelStore.ts`), the file tree (`apps/web/src/components/diffs/DiffFileTree.tsx`,
  `apps/web/src/components/files/FileBrowserPanel.tsx`), the diff renderer
  (`apps/web/src/components/diffs/StyledDiffCodeView.tsx` on `@pierre/diffs`), and the
  file viewer tabs.
- Server: checkpoint capture and diff queries (`apps/server/src/checkpointing/`,
  `CheckpointStore.ts`, `CheckpointDiffQuery.ts`, `Diffs.ts`) and the VCS diff endpoints the
  Branch scope uses.
- Contracts in `packages/contracts` for whatever new baseline, source and change-list shapes
  cross the wire.

## Proposed mechanism (shape only; the map decides the parts)

Change-awareness moves into the file surface Carl already uses rather than growing the
Diff panel into a second file viewer. One baseline selector governs both the tree markers
and the inline side-by-side view. The Diff panel shrinks towards "the list of what changed,
click to open". Capture of changes is extended from "this worktree's git" to an enumerated
set of sources: the worktree repo, nested repos found inside it, declared artefact paths.

## Key constraints

- **Bounded capture** (Carl): "we don't want to be running diff git's across the entire hard
  drive, or some top-level root folder". Sources are enumerated, never discovered by
  walking upward or across the disk; the search for nested repos is bounded to the
  worktree and skips ignored heavy trees (`node_modules`, `.venv`).
- **Toggle** (Carl): repo code changes vs other stuff must be separable.
- Performance posture of the repo (AGENTS.md): no over-sending on the websocket, large
  diffs load lazily, no continuous repaint.
- Loom hunk marking: anything added to a file that exists upstream carries `// loom:`;
  larger additions go in `*.loom.ts` or `apps/web/src/loom/`.
- Restore/rollback semantics are unchanged by this work.

## Important non-goals

- Reviewing an already-opened PR (the PR Code tab and guides stay as they are).
- Mobile parity for the whole-file side-by-side view. Changed-file markers and counts, yes.
- Replacing the chat-side per-turn diff summary cards.
- Git operations (commit, stage, push) from the review surface.

## Relevant existing code and docs

- `docs/user/source-control.md` "Review turn changes" describes today's per-turn semantics.
- `docs/architecture/checkpoint-git-isolation.md` for how checkpoints avoid touching the
  user's git state; any nested-repo capture must respect the same isolation.
- `docs/internals/overview.md` "Turn completion and checkpoints".
- Loom's "By coder" scope: `diffPanelStore.ts` (`kind: "coder"`, marker `3d-4`), the
  previous attempt at making delegation visible in the panel.

## Resolved terminology

- **Baseline**: the point in time a diff is measured from. Two kinds: _incremental_ (Carl's
  last message in this thread) and _branch_ (merge base with the base ref).
- **Source**: a place changes are captured from. The worktree repo, a nested repo, an
  artefact path.
- **Changed file**: a file that differs from the baseline in any enabled source.
- **Interval**: the span between two consecutive messages from Carl in the thread; the
  unit incremental review steps through.

## Open questions (the map's tickets)

1. How is the incremental baseline captured? A checkpoint of the whole worktree at each
   human message to the root thread, or a derived view over the children's existing
   checkpoints, or something else. Which is cheap, correct across concurrent children, and
   survives thread restarts.
2. How are nested repos and artefact paths captured, and how are they declared? Auto-detect
   `.git` directories inside the worktree at a bounded depth, or a per-project list in
   `.t3code/`, or both.
3. Toggle default: repo code only, or everything.
4. Does `@pierre/diffs` render a whole file side by side with acceptable performance for
   large files, or does the whole-file view need the file editor with change markers
   instead.
5. Where the "changed files only" filter lives: file tree or Diff panel, and what the Diff
   panel becomes.
6. What happens to the existing Turn and By coder scopes: removed, or folded into the
   interval history.
7. Which parts of this upstream T3 might adopt (so loom carries less), and which are
   loom-only.

## Rejected alternatives

- **Grow the Diff panel into a full-file viewer** while the file tabs stay change-blind.
  Rejected: duplicates the file viewer, and leaves the file tree, the first step of the
  information hierarchy, unaware of changes.
- **Fix only the capture blind spots and keep per-thread turns.** Rejected: the unit stays
  wrong for delegated work.

## Next

The wayfinder map (GitHub issue on `QuinRiva/loom`, label `wayfinder:map`) holds the open
questions above as tickets. When they are resolved, implementation is handed off as separate
goals, each ending in one reviewable PR.
