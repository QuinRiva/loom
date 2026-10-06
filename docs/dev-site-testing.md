# Dev-verify recipe (live frontend verification for agents)

Stand up an isolated T3 Code web instance, seed it with a realistic workstream,
and verify UI behaviour live in the browser — without touching the real cockpit
server/state (`13900`, `~/.t3/cockpit`). This is the exact flow used to catch the
`DiffPanel` "By coder" dropdown crash, a regression that passed every static
check.

> For pure render/CSS work on an isolated presentational component (e.g.
> `ChatMarkdown`, markdown tables) you usually don't need the full app — the
> dev-only component preview harness ([`docs/web-component-preview.md`](web-component-preview.md))
> renders components against fixtures with no backend in a ~seconds loop.
> Reach for this recipe when you need real threads, auth, or server state.

Everything below was run from a worktree with the cockpit's ambient
`T3CODE_HOME`/`T3CODE_PORT` present. No `env -u` fiddling is needed — the
collision-free dev runner handles the ambient env.

## 0. Pick a free server port

The dev runner keeps each web instance's state under a **port-scoped** home:
`<T3CODE_HOME>/dev-instances/<serverPort>/userdata/state.sqlite`. The seed must
land in that exact directory, so choose a server port up front and reuse it:

```sh
PORT=13950                       # a free server port; the web port is derived — read it from the banner
HOME_ROOT=/tmp/t3verify          # scratch T3CODE_HOME root
SEED_HOME="$HOME_ROOT/dev-instances/$PORT"
```

Confirm the port is actually free (`(exec 3<>/dev/tcp/127.0.0.1/$PORT) 2>/dev/null && echo busy || echo free`).
If it is busy, the runner will silently scan to a **different** port whose home
is **not** seeded, and the UI will show an empty database.

## 1. Seed the scratch home

```sh
mkdir -p "$SEED_HOME"
T3CODE_HOME="$SEED_HOME" vp run dev:seed
```

This writes a Loom workstream through the real V2 orchestrator (upstream and
Loom commands, never SQL): a goal with a nested task tree and, under one
project, an orchestrator root anchored to it; a done coder with a report; a
gated coder/reviewer pair mid-round (the reviewer looped findings, the coder
holds rework round 1); a quiescent researcher (synthesised report, attention
`awaiting_orchestrator`) with a blocked dependent; an unbriefed child; a
cancelled lead with its own cancelled grandchild; a root holding a stored
`needs_guidance`; and a staged (`held`) root with a kickoff brief. The root
carries one control card of each seam-6 kind (a digest with every item kind, a
synthesised yield, one notice per notice kind). Turns run against an in-process
stub adapter, so every started thread has real checkpoint refs (the Diff
surface) and the seed leaves nothing for a provider: booting a server on this
home starts no pi. The shared checkout lands under
`$SEED_HOME/worktrees/seed-workspace/` — that location is load-bearing, not
cosmetic: the foreign-home guard (below) decides provenance from whether any
recorded worktree path sits inside the running home's `worktreesDir`, so a seed
rooted anywhere else would boot the instance read-only. Prove the read model —
every thread's column and attention, the control cards, a checkpoint ref per
started thread, an empty outbox and no re-drive owed — without the UI:

```sh
T3CODE_HOME="$SEED_HOME" vp run dev:seed:verify
```

## 2. Start the dev stack (backgrounded, logged)

```sh
T3CODE_NO_BROWSER=1 \
  setsid pnpm dev --home-dir "$HOME_ROOT" --port "$PORT" > /tmp/t3verify-dev.log 2>&1 &
DEV_PID=$!                       # for step 6; may already be gone if setsid re-forked
```

Notes:

- **`--home-dir`, not `T3CODE_HOME`.** Inside a worktree the runner's home
  precedence is `--home-dir` > that worktree's gitignored `.t3` > ambient
  `T3CODE_HOME` (`scripts/dev-runner.ts`, `@t3tools/shared/devHome`), so an
  exported `T3CODE_HOME` is silently outranked and the instance comes up on
  `<worktree>/.t3/dev-instances/<port>` — an empty database that looks exactly
  like a failed seed. The seeder in step 1 is a plain script that reads
  `T3CODE_HOME` directly, which is why the two steps spell the home differently.
- Pass the **root** (`$HOME_ROOT`), not the per-port subdir — the runner appends
  `dev-instances/<serverPort>` itself.
- An explicitly **free** `--port` is honoured exactly, so `serverPort` matches
  your seeded home. Confirm this in the banner (step 3).
- `setsid` starts a new process group so you can kill the whole tree in step 6.
  `node --watch` spawns child processes that outlive a bare `kill` of the
  parent and keep ports busy otherwise.

## 3. Read the URLs and pairing token from stdout

```sh
grep -E 'dev-runner|Listening|pairingUrl|Local:' /tmp/t3verify-dev.log
```

You get two `[dev-runner]` banner lines (web + server URLs, and the port the
runner actually chose) and, a few seconds later, the server's pairing line:

```
[dev-runner] ... serverPort=13950 webPort=5733 baseDir=/tmp/t3verify/dev-instances/13950
[dev-runner] web: http://localhost:5733 | server: http://localhost:13950 | pairing URL is printed below ...
  ➜  Local:   http://127.0.0.1:5733/
Listening on http://127.0.0.1:13950
  pairingUrl: http://localhost:5733/pair#token=DDX6VN6NV8BX
```

Verify `serverPort` equals your `$PORT` (i.e. the port was free). If the banner
shows `requestedPort=<PORT>(busy, scanned instead)`, stop, free the port, and
restart — the scanned port's home is unseeded.

## 4. Pair in the browser

Open the **pairingUrl exactly as printed, using `localhost`** (not
`127.0.0.1`). The token rides the URL hash and auto-fills + submits.

```
http://localhost:5733/pair#token=<TOKEN>
```

**Origin gotcha:** the web app and the server API must agree on host. The runner
sets `VITE_DEV_SERVER_URL`/`VITE_HTTP_URL` to `localhost`, so opening the app on
`127.0.0.1` makes every API call cross-origin and pairing fails with an HTTP 500
(`Primary environment request failed`). Always use `localhost`.

**Single-use token gotcha:** each pairing token is one-time. Any `node --watch`
restart (e.g. you edit a watched source file) mints a **new** token and logs a
fresh `pairingUrl` line — always grab the latest from the log. If a pair attempt
fails or the token is spent, mint another without restarting:

```sh
T3CODE_HOME="$SEED_HOME" node apps/server/src/bin.ts auth pairing create
```

## 5. Verify the seeded workstream

1. Open the **Seed Fixture Project → "Deliver the workstream fixture"**
   orchestrator thread. Its header should show **Git actions** (Commit),
   confirming the shared checkout is a repo — if it shows "Initialize Git", the
   Diff surface is gated off and the seed's `git init` did not run.
2. Its timeline carries the seeded control messages (digest, synthesised
   yield, one per notice kind), and the right panel's **Lineage** lists its
   children.
3. The client state holds the goal and every thread's `workstream`: the shell
   cache in IndexedDB (`t3code:connection-runtime` → `shell`) mirrors it, so a
   `browser_evaluate` that reads that store and prints `snapshot.goals` and each
   thread's `workstream` is a quick check. The board, goal panel and control
   cards that render this state arrive with the Phase 3 web re-hang.

## 6. Clean up

Never kill by pattern (`pkill -f`, `pgrep | kill`): your own agent process and
several other dev servers on this machine carry matching worktree paths in their
argv. Kill the PID you captured at spawn, or the owner of **your** port after
confirming it is yours:

```sh
# The PID that owns your port, cross-checked against this worktree before anything dies.
DEV_PID=${DEV_PID:-$(ss -H -ltnp "sport = :$PORT" | grep -oP 'pid=\K[0-9]+' | head -1)}
readlink "/proc/$DEV_PID/cwd"                       # must be this worktree
kill -TERM -"$(ps -o pgid= -p "$DEV_PID" | tr -d ' ')"   # the whole process group
rm -rf "$HOME_ROOT"                                 # scratch state
```

Then confirm the ports are free again. `node --watch` children are the usual
culprit for a port that stays busy — kill the whole group, not just the parent.

## Verifying against a copy of the cockpit database

The seed is the default: it is reproducible and owns nothing. When you need
**real** data (hundreds of threads, real projects, real worktree rows), run a
server against a copy of the cockpit database — never against
`~/.t3/cockpit/userdata` itself.

The copy must land in the **port-scoped** home the runner will actually open
(`--home-dir` is the root; the runner appends `dev-instances/<serverPort>`), so
pick the free port first and spell the path with it — a copy at
`$COPY_HOME/userdata/state.sqlite` is simply never read and the UI comes up
empty.

```sh
PORT=13951                                   # a free 139xx port; never 13900 (the live cockpit)
COPY_HOME=/tmp/t3dbcopy
COPY_STATE="$COPY_HOME/dev-instances/$PORT/userdata"
mkdir -p "$COPY_STATE"
rm -f "$COPY_STATE/state.sqlite"*            # VACUUM INTO refuses to overwrite
bun -e "new (require('bun:sqlite').Database)(process.env.HOME + '/.t3/cockpit/userdata/state.sqlite', { readonly: true }).run(\"VACUUM INTO '$COPY_STATE/state.sqlite'\")"
T3CODE_NO_BROWSER=1 setsid pnpm dev --home-dir "$COPY_HOME" --port "$PORT" > /tmp/t3dbcopy-dev.log 2>&1 &
```

`VACUUM INTO` is safe while the cockpit has the file open and yields one
consistent snapshot; a plain `cp` of a live database is a corrupt copy. Copy in,
never out.

**The copy carries the cockpit's recorded paths, branches and provider
sessions** (unlike the seed, whose recorded paths are its own), so a naive
server on it would act on the live checkouts of every thread running on this
machine — it has twice attempted `git worktree remove`
and `git branch -d` against sibling worktrees of this clone. The server now
detects that by itself: a database whose recorded worktree paths all sit outside
the running home's `worktreesDir` did not come from this home, and the
first-class side effects refuse (`apps/server/src/workspace/foreignHomeGuard.loom.ts`).
Expect this at boot:

```
WARN foreign-home guard: this database was copied from another T3 home; mutating side effects are refused
WARN foreign-home guard refused a side effect  site=GitVcsDriver.removeWorktree target=/home/…/worktrees/…
```

Refused while the guard is on: worktree create/remove/prune, branch delete,
checkpoint capture/restore/delete, provider session start and recovery/resume,
project setup-script runs, and the boot `projects.auto-pull` phase's `git pull`.
Everything read-only — the sidebar, threads, timelines,
diffs of existing checkpoints — works normally, which is what a data-shaped
verification needs. If you need to drive an agent, use the seed instance
instead; a copy-DB instance is deliberately incapable of it.

The guard keys off recorded worktree paths, so a copied database that records
**no** worktree at all is indistinguishable from this home's own and stays
unguarded. And it is not a substitute for the two standing rules: never point a
server at `~/.t3/cockpit/userdata`, and **never `git stash`** in this repo —
every worktree of this clone shares one `.git`, so the stash stack is global and
a `pop` can hand you another thread's work.

### Toasts make a copy-DB instance unscreenshottable by default

Every guard refusal raises a **toast**, and a copied database keeps trying to resume
its threads, so refusals — and their toasts — keep arriving for as long as the
instance runs. There is no quiet moment to wait for: they land on top of
whatever you are capturing, and deleting the toast nodes just loses the race
with the next batch. Suppress the fixed-position viewports once per page load,
before capturing (`browser_evaluate`, or the devtools console):

```js
document.head.insertAdjacentHTML(
  "beforeend",
  '<style>[data-slot^="toast-viewport"]{display:none!important}</style>',
);
```

The `^=` covers both viewports (`toast-viewport` and `toast-viewport-anchored`
in `apps/web/src/components/ui/toast.tsx`). Re-apply after any navigation that
remounts the app.

### Usage and cost figures climb on their own — check the guard line before you react

The usage page's figures move in a copy-DB instance that has spent nothing, for
one of two causes with **opposite** correct responses. The boot log's
`WARN foreign-home guard` line (above) tells you which:

- **Guard line present — false alarm; leave it running.** The usage page scans
  transcripts from disk, not the database you pointed at: `UsageService` walks
  each provider's sessions root, and pi's is machine-global, so a scratch
  instance reports the **real** cockpit's live pi sessions. Finish your capture.
- **Guard line absent — a fire; shut it down.** You are unguarded, because the
  build predates the guard (an old release booted to capture a pre-change
  baseline) or because the snapshot records no worktree for the guard to key off
  (above). Startup reconciliation then resumes the sessions the copied database
  records — the cockpit's **real** ones, in their live checkouts, exactly what
  `ProviderService.recoverSessionForThread` refuses in guarded builds. That
  spends real tokens and puts a second driver on other threads' sessions.

Read the log rather than guessing in either direction: an agent has already
read the guarded case's moving numbers as its scratch server burning quota,
killed the instance mid-capture, and lost baseline evidence it could not rerun
— while leaving an unguarded one running costs tokens and other threads' session
state.

## Running several instances at once

Each `pnpm dev` picks its own free server/web port pair and its own state dir at
`<T3CODE_HOME>/dev-instances/<serverPort>/userdata/state.sqlite`, so concurrent
worktree instances coexist without sharing sqlite or colliding on ports. Seed
each one into its own per-port subdir. Never point a scratch web instance at the
live cockpit server unless that is explicitly the intent.

**Start them one at a time.** Only the _server_ port is pinned by `--port`; the
web port is scanned for. Two `pnpm dev` launched in the same instant both see
the same web port free and one of them loses it, so wait for the first
`[dev-runner] web: …` banner line before launching the next.
