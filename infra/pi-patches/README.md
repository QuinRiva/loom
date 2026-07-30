# Local patches to the pi CLI

This directory is the human-readable **source of truth** for _why_ Loom patches
pi (`@earendil-works/pi-coding-agent`) and how to re-derive each patch. pi ships
as compiled JS, so the patches target `dist/`.

## How the patch is actually applied (primary path)

Loom **bundles pi as a workspace dependency** and applies these patches
automatically at install time via pnpm's `patchedDependencies`:

- `apps/server/package.json` pins `@earendil-works/pi-coding-agent` at an **exact**
  version (no `^`): the pnpm patch key is version-scoped, so a version bump that
  forgets the patch fails `pnpm install` loudly instead of silently shipping an
  unpatched pi.
- `pnpm-workspace.yaml` → `patchedDependencies` maps that exact version to
  `patches/@earendil-works__pi-coding-agent@<version>.patch` (generated from the
  patch below — see "Re-deriving").
- `apps/server`'s `resolveBundledPiCliPath()` (`src/provider/Layers/Pi/Cli.ts`)
  prefers this node_modules copy, so the running RPC process is the bundled,
  patched binary — not whatever `pi` is on `PATH`.

This replaces the old machine-state coupling where the patch lived only in a
global `npm i -g` install and any `pi update` silently reverted it.

## `apply.sh` is legacy / dev-only

```bash
infra/pi-patches/apply.sh          # apply (idempotent)
infra/pi-patches/apply.sh --check  # check: are they applied?
infra/pi-patches/apply.sh --revert # back out
```

`apply.sh` patches a **globally installed** pi in place. Loom no longer needs it
— the bundled dependency is what Loom runs. Keep it only for patching a global
pi you use for _interactive_ `pi --session … --cwd …` at the terminal; it is not
part of Loom's build or runtime.

Authored against pi **0.82.1**; re-verified clean against **0.83.0** (the
currently bundled pin). If a patch stops applying cleanly, upstream has moved:
re-derive it against the new dist rather than force-applying.

## Re-deriving after a pi version bump

Because the pnpm patch key is exact-version-scoped, bumping the bundled pi
requires regenerating the pnpm patch:

```bash
pnpm patch @earendil-works/pi-coding-agent@<newVersion>
# apply the diff below into the printed editable dir, e.g.:
git apply -p1 --directory=<editable-dir> \
  infra/pi-patches/0001-pi-cwd-override-rpc-resume.patch
pnpm patch-commit <editable-dir>   # writes patches/… and registers it
pnpm install                        # confirm --cwd lands in the resolved copy
```

Then confirm `PiCwdOverride.contract.test.ts` runs (not skips) and passes.

## 0001 — `--cwd <dir>` for headless session resume

**Problem.** Loom deletes a completed sub-thread's worktree after fan-in. pi
welds a session to its birth cwd twice: the session directory is derived from
the launch cwd's slug (launching from anywhere else silently creates a _new
empty session with the same id_ — amnesia, not an error), and the header cwd
must exist or RPC startup hard-exits:

```
Stored session working directory does not exist: /…/ws-…-planner-0ab903d0
```

So a human could not reopen a finished thread to ask it a question.

**Fix.** pi already supports relocation — `SessionManager.open(path,
sessionDir, cwdOverride)`, which interactive mode uses as its official
missing-cwd fallback (`modes/interactive/interactive-mode.js`, the "cwd from
session file does not exist → continue in current cwd" prompt). Only the
headless path never exposed the parameter. The patch adds `--cwd <dir>`:

- valid **only** with an explicit `--session <path>`; rejected with
  `--session-id`, `--fork`, `--continue`, `--resume`, `--no-session` (each of
  those can create a session, which would make the cwd/session-dir semantics
  ambiguous);
- a missing or non-directory target is a usage error;
- when valid, the session opens with the override as the manager's cwd. The
  missing-session-cwd check then passes for free, because
  `getMissingSessionCwdIssue` reads `sessionManager.getCwd()`
  (`core/session-cwd.js`). Settings, extensions, and project trust already
  resolve against `sessionManager.getCwd()`, so they follow the override.
- The header is never rewritten and the file is never copied: it stays the
  faithful record of where the work originally happened, and the conversation
  continues by append. Relocation is per-launch and runtime-only.
- Absent the flag, behaviour is unchanged (including `--fork`, which
  `consult_thread` depends on).

Files: `dist/cli/args.js`, `dist/cli/args.d.ts`, `dist/main.js`.

Pinned by the contract test
`apps/server/src/provider/Layers/Pi/PiCwdOverride.contract.test.ts`, which
drives the bundled binary over RPC. Because pi is now a workspace dependency it
is always present, so the test runs (never skips) and **fails loudly** if the
bundled copy is unpatched — exactly the upstream drift we want to hear about.

Upstreamable as-is: "headless resume after the working directory moved" is
needed by any daemon embedding pi, and interactive mode's prompt shows the
semantics are already accepted.
