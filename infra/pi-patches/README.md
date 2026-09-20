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

## ⚠️ Since pi 0.84, `bin.pi` is a pre-bundled file

pi used to ship `bin.pi = dist/cli.js`, the readable transpiled tree. From 0.84
it is `dist/bundle/cli.js`, an esbuild bundle of the whole CLI into
`dist/bundle/chunks/chunk-<hash>.js`. The readable `dist/` tree still ships (it
is the package's `exports` entry), but **patching it alone leaves the binary
Loom runs unpatched** — silently, with no install-time error.

So each patch exists in two forms, and both are part of the pnpm patch:

- the readable diff below (`0001-…patch`, `0002-…patch`), applied to `dist/`;
- the same change applied to the bundle by `patch-bundle.mjs`, as anchored
  string replacements against the minified chunk. The script is idempotent,
  refuses to write unless every anchor matches its expected count, and
  `node --check`s the result — so a pi bump whose bundle drifted fails loudly.

The two forms must stay behaviourally identical, which means reusing pi's own
helpers in the bundle rather than re-implementing them: `--cwd` is resolved by
pi's `resolvePath` in both (a hand-rolled `path.resolve` clone silently dropped
bare `~` and `file://` targets that the readable patch accepts). The applier
asserts that name still exists.

Keeping `bin.pi` on the bundle is deliberate: the unbundled entry boots ~275 ms
slower and holds ~23 MB more RSS per pi process (measured on 0.86.0), which Loom
pays on every spawned thread.

This replaces the old machine-state coupling where the patch lived only in a
global `npm i -g` install and any `pi update` silently reverted it.

## `apply.sh` is legacy / dev-only

```bash
infra/pi-patches/apply.sh          # apply (idempotent)
infra/pi-patches/apply.sh --check  # check: are they applied?
infra/pi-patches/apply.sh --revert # back out
```

`apply.sh` patches a **globally installed** pi in place (readable `dist/` first,
then the bundle via `patch-bundle.mjs`; `--revert` only backs out the readable
tree — reinstall the package to undo the bundle). Loom no longer needs it — the
bundled dependency is what Loom runs. Keep it only for patching a global pi you
use for _interactive_ `pi --session … --cwd …` at the terminal; it is not part
of Loom's build or runtime.

Authored against pi **0.82.1**; both diffs were re-derived against **0.86.0**
(the currently bundled pin). If a patch stops applying cleanly, upstream has
moved: re-derive it against the new dist rather than force-applying.

## Re-deriving after a pi version bump

Because the pnpm patch key is exact-version-scoped, bumping the bundled pi
requires regenerating the pnpm patch:

```bash
pnpm patch @earendil-works/pi-coding-agent@<newVersion>
# 1. readable dist/ — both diffs, into the printed editable dir:
for p in infra/pi-patches/000*.patch; do patch -p1 -d <editable-dir> < "$p"; done
# 2. the bundle that bin.pi actually runs:
node infra/pi-patches/patch-bundle.mjs <editable-dir>
pnpm patch-commit <editable-dir>   # writes patches/… and registers it
pnpm install                        # confirm both land in the resolved copy
```

Then re-derive the stored diffs from the patched copy (`diff -u` against the
pristine tarball) so `infra/pi-patches/` stays applicable to the new dist, and
verify:

- `PiCwdOverride.contract.test.ts` runs (not skips) and passes — it drives the
  resolved `bin.pi`, so it covers the bundle, not the readable tree;
- the auth write is atomic in the copy Loom resolves. The decisive check is
  `atomic-window.mjs` from `/home/Carl/pi-craft/local-patches/authlock-repro/`
  (separate-process readers; in-process readers falsely report clean): every
  `zeroByte`/`unparseable` count must be 0. On stock 0.86.0 the same harness
  reports ~8,000 zero-byte and ~730 unparseable reads per 4 s reader.

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

0.86.0 drift: unchanged except that `createSessionManager` is now `export`ed, so
the signature hunk had to be re-derived. The only cosmetic difference in the
bundle is that the two usage errors are plain text rather than chalk-red, since
chalk's binding there is mangled by esbuild; path resolution and every accepted
`--cwd` form are identical, because both forms call pi's `resolvePath`.

## 0002 — atomic `auth.json` write

**Symptom.** A thread dies at launch with `Model not found:
openai-codex/gpt-5.6-sol` (or any auth-gated provider's model), and stays broken
for that process's whole life; re-sending works because that is a _fresh_ pi
process. Loom's fan-out is the trigger — many pi processes boot while another is
writing or refreshing credentials.

**Root cause.** `FileAuthStorageBackend` writes `auth.json` with plain
`writeFileSync`, which opens `O_TRUNC` and then streams, so the file is
observably empty or partial for most of each write. `parseStorageData("")`
returns `{}` with no error, so that window is indistinguishable from a real
"no credentials" store for every reader that does not hold the lock — and pi has
several (`readStoredCredential`, `ReadOnlyAuthStorage`, plus any reader whose
lock acquisition loses to an in-flight OAuth refresh). Measured on stock 0.86.0:
~8,000 zero-byte and ~730 unparseable observations per 4 s reader.

**Fix.** `writeFileAtomic()` writes a sibling `auth.json.tmp-<pid>-<ts>` and
`renameSync()`s it over the target; `rename()` is atomic on POSIX, so a reader
sees either the complete old file or the complete new one. Used by both write
paths (`withLock`, `withLockAsync`). The temp file inherits the target's mode so
an administrator-managed mode survives the replace, cleanup removes it on
failure, and a crash between write and rename can no longer destroy `auth.json`.

**Deliberately NOT changed: the OAuth refresh holds the auth lock across its
network call.** It looks like the cleaner fix to refresh outside the lock and
compare-and-swap, but OpenAI Codex rotates the refresh token on every refresh:
the lock is what guarantees exactly one process refreshes while the others
re-check expiry under it and skip. Concurrent refreshes reuse a rotated token and
can trip OAuth reuse-detection, revoking the whole token family. Atomic write is
the entire scope.

The patch this was ported from (authored against 0.82.1, in
`/home/Carl/pi-craft/local-patches/`) also carried reader-side resilience — a
lock-free reload fallback and a `loadFailed` retry — because 0.82.1 read
`auth.json` **once**, in the `AuthStorage` constructor, under a ~200 ms lock
budget, and swallowed the failure forever. 0.86.0 rewrote that: `readLatestData()`
re-reads whenever the file revision changes, under a lock acquisition that
retries for up to 30 s, and a failed read caches no revision so the next read
retries. The stickiness is gone upstream, so only the atomic write was ported.

File: `dist/core/auth-storage.js` (plus the bundle). Not yet filed upstream;
confirmed still present in 0.86.0.

> Note: `pnpm patch` byte-compares the whole package, so
> `patches/@earendil-works__pi-coding-agent@0.86.0.patch` is ~465 KB — the two
> edited minified chunk lines dominate it. The readable diffs in this directory
> are the reviewable form of the same change.
