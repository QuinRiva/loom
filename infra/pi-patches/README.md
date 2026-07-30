# Local patches to the installed pi CLI

pi (`@earendil-works/pi-coding-agent`) is installed globally as compiled JS, so
these patches target `dist/` and must be re-applied after every `pi update` or
reinstall:

```bash
infra/pi-patches/apply.sh          # apply (idempotent)
infra/pi-patches/apply.sh --check  # check: are they applied?
infra/pi-patches/apply.sh --revert # back out
```

Authored against pi **0.82.1**. If a patch stops applying cleanly, upstream has
moved: re-derive it against the new dist rather than force-applying.

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
drives the installed binary over RPC and skips if pi is absent or unpatched.

Upstreamable as-is: "headless resume after the working directory moved" is
needed by any daemon embedding pi, and interactive mode's prompt shows the
semantics are already accepted.
