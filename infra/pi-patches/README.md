# Local patches to the pi CLI

This directory is the human-readable **source of truth** for _why_ Loom patches
pi (`@earendil-works/pi-coding-agent`) and how to re-derive each patch. pi ships
as compiled JS, so the patches target `dist/`. The surrounding procedure — which
pi version to pick, every other place the pi version and model ids live, and
the order to touch them in — is
[`docs/operations/platform-update.md`](../../docs/operations/platform-update.md);
this file covers only the patches.

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
- `apps/server`'s `resolveLoomPiBinaryPath()`
  (`src/provider/Drivers/Pi/bundledPi.loom.ts`) rewrites the default `pi`
  binary path to this copy's `bin.pi` once, where `PiDriver` builds its config,
  so every pi spawn — the RPC session, discovery, the version probe, text
  generation — and the update resolver run the bundled, patched binary, not
  whatever `pi` is on `PATH`. The path is spawned directly through its
  `#!/usr/bin/env node` shebang (POSIX only); an explicit `binaryPath` setting
  overrides it. Upstream's maintenance resolver treats the `node_modules` path
  as manual-only, so `pi update --self` is never offered for the bundled copy
  (`src/provider/providerMaintenance.loom.test.ts`).

## ⚠️ Since pi 0.84, `bin.pi` is a pre-bundled file

pi used to ship `bin.pi = dist/cli.js`, the readable transpiled tree. From 0.84
it is `dist/bundle/cli.js`, an esbuild bundle of the whole CLI into
`dist/bundle/chunks/chunk-<hash>.js` files. The readable `dist/` tree still ships (it
is the package's `exports` entry), but **patching it alone leaves the binary
Loom runs unpatched** — silently, with no install-time error.

So each patch exists in two forms, and both are part of the pnpm patch:

- the readable diff below (`0001-…patch`, `0002-…patch`), applied to `dist/`;
- the same change applied to the bundle by `patch-bundle.mjs`, as anchored
  string replacements against the minified chunks. Since 0.99 the two patches
  land in different chunks (the auth storage and the CLI's `main()` were split
  apart; 0.84–0.87 had one), so the script finds each patch's chunk by content.
  It is idempotent, writes nothing unless every anchor of both patches matches
  its expected count, and `node --check`s the result — so a pi bump whose
  bundle drifted fails loudly.

The two forms must stay behaviourally identical, which means reusing pi's own
helpers in the bundle rather than re-implementing them: `--cwd` is resolved by
pi's `resolvePath` in both (a hand-rolled `path.resolve` clone silently dropped
bare `~` and `file://` targets that the readable patch accepts). The applier
asserts that name is still bound in the CLI chunk, declared there (≤0.87) or
imported unaliased (0.99+).

Keeping `bin.pi` on the bundle is deliberate: the unbundled entry boots ~275 ms
slower and holds ~23 MB more RSS per pi process (measured on 0.86.0), which Loom
pays on every spawned thread.

This replaces the old machine-state coupling where the patch lived only in a
global `npm i -g` install and any `pi update` silently reverted it.

## `apply.sh` — the global install

```bash
npm install -g @earendil-works/pi-coding-agent@<version>   # the bundled pin; not `pi update`
infra/pi-patches/apply.sh          # apply (idempotent): readable dist/, then the bundle
infra/pi-patches/apply.sh --check  # 0001: applied=yes  0002: applied=yes  chunk-…: already patched
infra/pi-patches/apply.sh --revert # back out the readable tree only — reinstall to undo the bundle
```

`apply.sh` patches the **globally installed** pi (`which pi`) in place. Loom's
runtime does not use that copy, but the global pi is still a required part of
every bump: `~/.pi/agent/auth.json` is shared by every pi process on the
machine, so an unpatched terminal pi writing it non-atomically can hand a
bundled cockpit thread an empty credential store — 0002 only works if _every_
writer has it. Install the exact bundled version with `npm install -g` (so the
re-derived diffs below apply at zero offset; `pi update` installs latest and
`--all` also reinstalls extensions, wiping their patches), then run `apply.sh`.

On this path `apply.sh` deliberately leaves a `*.orig` beside each patched file
for emergency restore — keep them (the bundled path is different, see step 2).
The atomic-write harness in step 3 imports the global install by default, so
for this copy it runs unmodified. Running pi processes keep the old code;
nothing needs killing.

Authored against pi **0.82.1**; both diffs were re-derived against **1.0.2**
(the currently bundled pin). If a patch stops applying cleanly, upstream has
moved: re-derive it against the new dist rather than force-applying.

**The global pi is still 0.99.2** (with its 0.99.2 patches) at the 1.0.2 bump:
the bump landed in the pull-9 branch, and moving the global install is part of
the human deploy, not of the bump commit. Until then `apply.sh` results on the
global install say nothing about the bundled copy (the diffs are derived
against 1.0.2), and the global pi lacks the RPC half of 0001 — harmless, since
only Loom's server sends `cwdOverride`, and it spawns the bundled copy.
pi 1.0.2's startup migrations touch only legacy layouts and skip when
`auth.json` exists, so the bundled 1.0.2 and the global 0.99.2 share
`~/.pi/agent` safely (settings/auth hashes unchanged across the 1.0.2 smoke).

## Re-deriving after a pi version bump

### 0. Check first whether the patch can be retired

Not optional, and it has paid off twice. Against the new pristine tarball
(`npm pack @earendil-works/pi-coding-agent@<newVersion>`):

- **0002** — if `dist/core/auth-storage.js` writes via `renameSync` (or any
  atomic replace) on _both_ the `withLock` and `withLockAsync` paths, drop the
  patch. `grep -n "writeFileSync\|renameSync" dist/core/auth-storage.js`.
- **0001** — if pi has a native `--cwd` on the headless `--session` path
  (`grep -n '"--cwd"' dist/cli/args.js`), drop the patch **only** if
  `PiCwdOverride.contract.test.ts` passes against stock. Retiring a patch that
  was still needed is silent amnesia (a resumed session creates a new empty
  session with the same id), so the bar is proof, not plausibility.

Record the outcome here either way.

**1.0.2 outcomes.** 0002: still needed — both `withLock` and `withLockAsync`
write `auth.json` with plain `writeFileSync`, no `renameSync` anywhere.
0001: still needed — stock `args.js` has no `--cwd`, and the contract test
against the stock 1.0.2 bundle fails 7 of 9 (the five CLI cases that need the
flag, and both RPC `cwdOverride` cases: stock ignores the unknown field, so
`switch_session` resumes into the dead recorded cwd and errors with "Stored
session working directory does not exist"). The two passing cases are the
controls (no override → refusal), which hold either way.

### 1. Move the version pins

Both places matter:

- `apps/server/package.json` — the exact pin (no caret).
- `pnpm-workspace.yaml` → `patchedDependencies` — the version-scoped patch key.
  Remove the old entry; never leave both versions registered.

### 2. Regenerate the pnpm patch

`pnpm patch <pkg>@<newVersion>` refuses unless that version is **already
installed**, and both `pnpm install` and `pnpm patch` refuse while
`patchedDependencies` names a patch file that does not exist yet. So the new
version has to land unpatched first, and the entry stays out until
`patch-commit` writes it:

Use a worktree-local editable dir (e.g. `.artifacts/pi-patch-<newVersion>`)
rather than `/tmp`, and install with `CI=true vp i --no-frozen-lockfile`; the
`/tmp` paths below are the historical form.

```bash
# patchedDependencies entry removed (or commented out) until patch-commit:
pnpm install                       # resolves the new version, unpatched — the moment to run the
                                   # step-0 retirement proofs against stock (contract test, harness)
rm -rf /tmp/pi-patch-<newVersion>  # never reuse a stale editable dir
pnpm patch @earendil-works/pi-coding-agent@<newVersion> --edit-dir /tmp/pi-patch-<newVersion>
diff -r --brief <pristine-tarball-dir> /tmp/pi-patch-<newVersion>   # must be empty
# 1. readable dist/ — both diffs, at zero fuzz so an upstream drift fails here rather than in step 3:
for p in infra/pi-patches/000*.patch; do patch -p1 -F 0 -d /tmp/pi-patch-<newVersion> < "$p"; done
# 2. the bundle that bin.pi actually runs:
node infra/pi-patches/patch-bundle.mjs /tmp/pi-patch-<newVersion>
find /tmp/pi-patch-<newVersion> -name '*.orig' -delete  # `patch` backs a file up when a hunk lands at an offset
pnpm patch-commit /tmp/pi-patch-<newVersion>      # writes patches/… and registers the entry
pnpm install                                      # confirm both land in the resolved copy
```

`pnpm patch-commit` rewrites the `patchedDependencies` entry with single quotes
and drops it above the `# loom:` comment — put the comment back on top and
requote. It also re-spaces the `supportedArchitectures` arrays (`[ current, x64 ]`);
restore those, then `vp check --fix` the YAML.

### 3. Re-derive the stored diffs and verify

Re-derive `0001`/`0002` from the patched copy (`diff -u` against the pristine
tarball) so `infra/pi-patches/` applies to the new dist at zero offset, then:

- the stored diffs plus `patch-bundle.mjs`, applied to a fresh pristine tarball,
  reproduce the `patch-commit` tree byte for byte (`diff -r`), and re-running
  `patch-commit` on it leaves `patches/…patch` unchanged;
- `node --check` every patched file, the minified chunk included;
- `PiCwdOverride.contract.test.ts` runs (not skips) and passes — it drives the
  resolved `bin.pi`, so it covers the bundle, not the readable tree;
- `--cwd` still resolves via pi's `resolvePath` in the bundle. Cheap proof
  against the resolved `dist/bundle/cli.js`: `--session x --cwd '~/nope'` and
  `--cwd 'file:///nope'` must report the _expanded_ path in the error;
- the auth write is atomic in the copy Loom resolves. The decisive check is
  `atomic-window.mjs` from `/home/Carl/pi-craft/local-patches/authlock-repro/`
  (separate-process readers; in-process readers falsely report clean): every
  `zeroByte`/`unparseable`/`emptyObject` count must be 0. Its import is
  hard-coded to the global install; for the bundled copy point it at the
  resolved package (`readlink -f apps/server/node_modules/@earendil-works/pi-coding-agent`)
  instead. That exercises the readable tree — the bundle's write path is proven
  by `grep -c __loomWriteAuthAtomic` on the auth chunk (expect 2) with no raw
  `writeFileSync(this.authPath,next,AUTH_FILE_WRITE_OPTIONS)` left. Stock pi is dramatically dirty for
  calibration: on 0.87.1 the same harness reports ~4–9 k zero-byte and ~600–800
  unparseable reads per 4 s reader, alongside ~5–6 k good ones. A stock run
  reporting _millions_ of zero-byte reads is usually a stalled writer leaving the file
  truncated, not a wider window — rerun it rather than record it. Stock 0.99.2
  was the exception: ~2–3 M zero-byte, ~50–90 unparseable and ~300 good reads
  per reader on 3 of 3 runs, so there the unparseable count carries the
  calibration. Patched 0.99.2 reads ~7 k good and zero of everything else;
- `pnpm install` is idempotent (lockfile unchanged on a second run), and
  `vp check` / `vp run typecheck` pass;
- every package pi pulls in has a license notice: `generateThirdPartyLicenseManifest`
  (`scripts/lib/third-party-licenses.ts`) over the web, server and desktop
  manifests succeeds. A new `@earendil-works/*` package has no LICENSE file and
  needs a `packageOverrides` entry in `third-party-licenses.config.json`.

All of the above must run in a worktree that has itself run `pnpm install`
since the bump: a sibling worktree that merely merged the commit still resolves
the **old** pi, and the model probes pass on it anyway (builtin models come from
`~/.pi/agent/models-store.json`, custom ones from the extensions). Assert
`grep '"version"' "$(readlink -f apps/server/node_modules/@earendil-works/pi-coding-agent)/package.json"`
before trusting any result.

## 0001 — `--cwd <dir>` for headless session resume, and `cwdOverride` on RPC `switch_session`

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
  `mcp__t3-code__consult_thread` depends on).

**The RPC half (added at 1.0.2).** Orchestration V2's `PiAdapterV2` does not
resume with `--session`: it starts pi fresh and sends `switch_session
{ sessionPath }`, and pi builds the resumed runtime in the session's _recorded_
cwd — so a reaped worktree fails the resume, and a recorded cwd that still
exists but differs from the thread's runs the thread's tools in the wrong
place. The runtime host already accepts `switchSession(path, { cwdOverride })`
(`core/agent-session-runtime.js` → `SessionManager.open(path, undefined,
cwdOverride)`); only the RPC command handler never passed it. The patch adds an
optional `cwdOverride` field to the `switch_session` command
(`modes/rpc/rpc-types.d.ts`) and passes it through (`modes/rpc/rpc-mode.js`):

- resolved against the pi process's cwd with pi's `resolvePath`, exactly as
  `--cwd` is;
- a missing or non-directory target throws, which the RPC command loop turns
  into an error response for that command id ("cwdOverride directory does not
  exist: …"); the process stays up and the current session is untouched;
- when valid, the same relocation semantics as `--cwd`: header never rewritten,
  conversation continues by append, tools run in the override;
- absent the field, behaviour is unchanged. A stock pi ignores the unknown
  field, so an unpatched bundle degrades silently to the old behaviour — only
  the contract test notices.

In the bundle the RPC edit lands in the same chunk as `main()` (since 0.99 the
CLI and the RPC loop share it), behind the helper `__loomResolveRpcCwdOverride`
in the 0001 header; that helper is now the 0001 idempotency marker, so a chunk
patched by an older copy of `patch-bundle.mjs` (CLI half only) reads as
unpatched.

Files: `dist/cli/args.js`, `dist/cli/args.d.ts`, `dist/main.js`,
`dist/modes/rpc/rpc-mode.js`, `dist/modes/rpc/rpc-types.d.ts`.

Pinned by the contract test
`apps/server/src/provider/Drivers/Pi/PiCwdOverride.contract.test.ts` — six CLI
`--cwd` cases plus three RPC `switch_session` cases — which drives the bundled
`bin.pi` resolved by `resolveBundledPiCliPath()`. Because pi is a workspace
dependency it is always present, so the test never skips and **fails loudly**
if the bundled copy is unresolvable or unpatched — exactly the upstream drift we
want to hear about.

Upstreamable as-is: "headless resume after the working directory moved" is
needed by any daemon embedding pi, and interactive mode's prompt shows the
semantics are already accepted.

0.86.0 drift: unchanged except that `createSessionManager` is now `export`ed, so
the signature hunk had to be re-derived. 0.87.1 drift: none in this patch's
territory — all nine bundle anchors matched first try and the readable hunks
applied at a pure line offset (0.87.1 only reworked `--mode` validation and
`prepareInitialMessage` nearby). 0.99.2 drift: the readable hunks applied at a
pure line offset (re-derived), but esbuild moved the CLI's `main()` into its own
chunk and `resolvePath` became an import there, so `patch-bundle.mjs` now
locates each patch's chunk separately. Still **not** retired: stock 0.99.2
rejects `--cwd` as an unknown option (the contract test fails 5 of 6 against
it), so there is still no `--cwd` on the headless path. The only cosmetic difference in the
bundle is that the two usage errors are plain text rather than chalk-red, since
chalk's binding there is mangled by esbuild; path resolution and every accepted
`--cwd` form are identical, because both forms call pi's `resolvePath`.
1.0.2 drift: `args.js` hunk 1 failed only because its context line
`result.models = args[++i].split(",")…` became a four-line chain (re-derived);
`args.js` hunk 2 moved three lines and two `main.js` hunks six; `args.d.ts` was
clean. The bundle's chunk layout is the 0.99 one (`main()` and the RPC loop in
`chunk-ZSBPJAJ2.js`, auth storage in `chunk-PDFMCAOZ.js`), all eight existing
0001 anchors matched exactly once, and the new RPC anchor
(`case"switch_session":{let result=await runtimeHost.switchSession(command.sessionPath);`)
matches once — `patch-bundle.mjs` reports `0001 … patched (9 edits)`.

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
lock acquisition loses to an in-flight OAuth refresh). Measured on stock 0.87.1:
~4–9 k zero-byte and ~600–800 unparseable observations per 4 s reader, ×3
readers, against ~5–6 k good reads — roughly one observation in two catches the
file mid-write. (The same harness on 0.86.0 reported ~8,000 / ~730; the absolute
counts track machine speed, the ratio is the point.)

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
confirmed still present in 0.87.1 — that file is byte-identical to 0.86.0, so
the patch applied unchanged and retirement was never on the table. Still present
in 0.99.2: both lock paths still `writeFileSync` with no rename, and the stored
diff re-derived byte-identical. Still present in 1.0.2 (same two call
sites, chunk `chunk-PDFMCAOZ.js`); the stored diff re-derived byte-identical
again, and `atomic-window.mjs` against the resolved 1.0.2 copy read ~6.9 k good
and zero zero-byte/unparseable/empty per reader.

> Note: `pnpm patch` byte-compares the whole package, so
> `patches/@earendil-works__pi-coding-agent@<version>.patch` is ~650–700 KB — the
> edited minified chunk lines dominate it. The readable diffs in this directory
> are the reviewable form of the same change.
