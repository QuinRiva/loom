# Scripts

- `bun run dev` — Starts contracts, server, and web in `turbo watch` mode.
- `bun run dev:server` — Starts just the WebSocket server (uses Bun TypeScript execution).
- `bun run dev:web` — Starts just the Vite dev server for the web app.
- Dev commands default `T3CODE_STATE_DIR` to `~/.t3/dev` to keep dev state isolated from desktop/prod state.
- Override server CLI-equivalent flags from root dev commands with `--`, for example:
  `bun run dev -- --base-dir ~/.t3-2`
- `bun run start` — Runs the production server (serves built web app as static files).
- `bun run build` — Builds contracts, web app, and server through Turbo.
- `bun run typecheck` — Strict TypeScript checks for all packages.
- `bun run test` — Runs workspace tests.
- `bun run dist:desktop:artifact -- --platform <mac|linux|win> --target <target> --arch <arch>` — Builds a desktop artifact for a specific platform/target/arch.
- `bun run dist:desktop:dmg` — Builds a shareable macOS `.dmg` into `./release`.
- `bun run dist:desktop:dmg:x64` — Builds an Intel macOS `.dmg`.
- `bun run dist:desktop:linux` — Builds a Linux AppImage into `./release`.
- `bun run dist:desktop:win` — Builds a Windows NSIS installer into `./release`.

## Desktop `.dmg` packaging notes

- Default build is unsigned/not notarized for local sharing.
- The DMG build uses `assets/macos-icon-1024.png` as the production app icon source.
- Desktop production windows load the bundled UI from `t3://app/index.html` (not a `127.0.0.1` document URL).
- Desktop packaging includes `apps/server/dist` (the `t3` backend) and starts it on loopback with an auth token for WebSocket/API traffic.
- Your tester can still open it on macOS by right-clicking the app and choosing **Open** on first launch.
- To keep staging files for debugging package contents, run: `bun run dist:desktop:dmg -- --keep-stage`
- To allow code-signing/notarization when configured in CI/secrets, add: `--signed`.
- Windows `--signed` uses Azure Trusted Signing and expects:
  `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`,
  `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`, and `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`.
- Azure authentication env vars are also required (for example service principal with secret):
  `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`.

## Running multiple dev instances

Set `T3CODE_DEV_INSTANCE` to any value to deterministically shift all dev ports together.

- Default ports: server `3773`, web `5733`
- Shifted ports: `base + offset` (offset is hashed from `T3CODE_DEV_INSTANCE`)
- Example: `T3CODE_DEV_INSTANCE=branch-a bun run dev:desktop`

If you want full control instead of hashing, set `T3CODE_PORT_OFFSET` to a numeric offset.

## Worktree development

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
  the path**. When `pnpm install` runs in *any* worktree, its linking phase
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
