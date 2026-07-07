# Dev-verify recipe (live frontend verification for agents)

Stand up an isolated T3 Code web instance, seed it with a realistic workstream,
and verify UI behaviour live in the browser — without touching the real cockpit
server/state (`13900`, `~/.t3/cockpit`). This is the exact flow used to catch the
`DiffPanel` "By coder" dropdown crash, a regression that passed every static
check.

Everything below was run from a worktree with the cockpit's ambient
`T3CODE_HOME`/`T3CODE_PORT` present. No `env -u` fiddling is needed — the
collision-free dev runner handles the ambient env.

## 0. Pick a free server port

The dev runner keeps each web instance's state under a **port-scoped** home:
`<T3CODE_HOME>/dev-instances/<serverPort>/dev/state.sqlite`. The seed must land
in that exact directory, so choose a server port up front and reuse it:

```sh
PORT=13950                       # a free server port; web port is fixed at 5733+offset
HOME_ROOT=/tmp/t3verify          # scratch T3CODE_HOME root
SEED_HOME="$HOME_ROOT/dev-instances/$PORT"
```

Confirm the port is actually free (`(exec 3<>/dev/tcp/127.0.0.1/$PORT) 2>/dev/null && echo busy || echo free`).
If it is busy, the runner will silently scan to a **different** port whose home
is **not** seeded, and the UI will show an empty database.

## 1. Seed the scratch home

```sh
mkdir -p "$SEED_HOME"
T3CODE_HOME="$SEED_HOME" node apps/server/src/dev/seedWorkstream.ts
```

This populates an orchestrator + 5 coder sub-threads (multi-turn rework coder,
shared-isolation child, cancelled child) with real git checkpoint refs, and
`git init`s the orchestrator's own worktree so the Diff surface is reachable.
Optionally prove the read model and a per-turn diff without the UI:

```sh
T3CODE_HOME="$SEED_HOME" node apps/server/src/dev/verifySeed.ts
```

## 2. Start the dev stack (backgrounded, logged)

```sh
T3CODE_HOME="$HOME_ROOT" T3CODE_NO_BROWSER=1 \
  setsid pnpm dev --port "$PORT" > /tmp/t3verify-dev.log 2>&1 &
```

Notes:

- Pass `T3CODE_HOME` as the **root** (`$HOME_ROOT`), not the per-port subdir —
  the runner appends `dev-instances/<serverPort>` itself.
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

## 5. Verify the "By coder" diff dropdown

1. Open the **Seed Fixture Project → "Deliver diff-panel fixture"** orchestrator
   thread. Its header should show **Git actions** (Commit), confirming the
   worktree is a repo — if it shows "Initialize Git", the Diff surface is gated
   off and the seed's orchestrator `git init` did not run.
2. Bottom of the right panel: **Add panel surface → Diff**. (The Diff item is
   disabled unless the active thread's worktree is a git repo.)
3. Click the diff-scope dropdown (top-left of the diff panel, labelled with the
   current scope e.g. "Branch changes"). The menu must open — this is the exact
   Base UI composition that previously crashed.
4. Confirm the **By coder** section lists the seeded coders with badges:
   `approximate` on the shared-isolation coder, `not merged` on the cancelled
   one, and `+adds -dels` counts on each.
5. Hover the multi-turn coder ("Parser with rework") to open its **per-turn
   submenu** (All turns / Turn 3 / Turn 2 / Turn 1).
6. Select a turn and confirm a **non-empty diff** renders (e.g. `parser.ts -1
+1`).

## 6. Clean up

```sh
kill -- -"$(pgrep -f "dev-runner.*--port $PORT" | head -1)" 2>/dev/null  # kill the process group
pkill -f "dev-instances/$PORT"                                            # stray server children
rm -rf "$HOME_ROOT"                                                       # scratch state
```

Then confirm the ports are free again. `node --watch` children are the usual
culprit for a port that stays busy — kill the whole group, not just the parent.

## Running several instances at once

Each `pnpm dev` picks its own free server/web port pair and its own state dir at
`<T3CODE_HOME>/dev-instances/<serverPort>/dev/state.sqlite`, so concurrent
worktree instances coexist without sharing sqlite or colliding on ports. Seed
each one into its own per-port subdir. Never point a scratch web instance at the
live cockpit server unless that is explicitly the intent.
