# Worktree development (loom)

Upstream retired `docs/internals/scripts.md` in #9755 ("keep internal guides
focused on architecture"); loom's worktree/dev-runner guidance that lived at its
tail is re-homed here.

When agents work in git worktrees while a dev server is running, two things keep
the running app stable and the worktrees ready.

### Why `apps/server` dev uses `--watch-path`

The server dev task is `node --watch-path=./src --watch-path=../../packages/<pkg>/src ... src/bin.ts`
rather than a bare `node --watch`. The reason is subtle but important:

- Bare `node --watch` watches the whole loaded module graph, which includes
  `node_modules` dependency files. pnpm hardlinks those files into the **shared
  global store**, so the same physical inode is referenced by every checkout
  (main + all worktrees).
- `node --watch` uses inotify, and **inotify watches are bound to the inode, not
  the path**. When `pnpm install` runs in _any_ worktree, its linking phase
  creates/removes hardlinks to those shared store inodes — an `IN_ATTRIB`
  (link-count) change — which the running server's watcher receives even though
  the write happened through a path it has never heard of. The server restarts,
  dropping WebSocket sessions and killing in-flight agent turns.
- `--watch-path` restricts watching to source directories. `node_modules` sits
  beside `src`, never inside it, so this whole failure class disappears while
  cross-package hot-reload is preserved. The watched paths must cover
  `apps/server/src` plus each `packages/*/src` the server imports (currently
  `contracts`, `shared`, `tailscale`, `effect-acp`, `effect-codex-app-server`);
  add a path when the server starts importing a new workspace package.

### Bootstrapping fresh worktrees

A fresh `git worktree add` contains only tracked files — no `node_modules`, no
gitignored local env. `scripts/bootstrap-worktree.sh` restores both (copy `.env`
from the primary checkout, then `pnpm install`).

Wire it to run automatically via T3 Code's **project scripts**: add a script with
`command: bash scripts/bootstrap-worktree.sh` and toggle **“Run automatically on
worktree creation”** on (in the chat-header scripts control). On worktree
creation T3 Code opens a terminal in the new worktree and runs the script, with
`T3CODE_PROJECT_ROOT` (primary checkout) and `T3CODE_WORKTREE_PATH` (new
worktree) in its env. Notes:

- Only the **first** script flagged for worktree creation runs; chain steps with
  `&&` in the one script.
- It is fire-and-forget into a terminal — it does not block the agent's first
  turn, so a long install can briefly race the agent.
- Project scripts are stored per-project in T3 Code state, not in the repo, so
  each project (including non-TypeScript ones) points its hook at its own
  `scripts/bootstrap-worktree.sh`.

With `--watch-path` in place, this bootstrap install no longer bounces the dev
server, so the cheap hardlinked `pnpm install` is safe. (If you ever run the dev
server without `--watch-path`, add `--package-import-method=copy` to the install
so no store inodes are shared.)
