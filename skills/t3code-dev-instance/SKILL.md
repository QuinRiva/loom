---
name: t3code-dev-instance
description: >-
  Stand up an isolated scratch T3 Code dev instance (own T3CODE_HOME, own
  server + Vite web ports) and drive its web UI in a browser for live UI
  verification, without touching the real cockpit on port 13900 or
  ~/.t3/cockpit. Use when an agent needs to actually load a T3 Code page,
  verify rendered UI/UX, exercise pairing-URL auth, or seed ledger-backed views
  like /usage. Covers readiness signals, the CORS/credential and hostname
  gotchas, DB seeding constraints, and safe port-scoped cleanup.
---

# T3 Code scratch dev instance (for live UI verification)

Bring up a throwaway T3 Code web instance an agent can open in a browser, verify
against, and tear down — fully isolated from the real cockpit.

## Safety (read first)

- **Never** touch port **13900** or `~/.t3/cockpit` state — that is the real
  running cockpit. This skill only ever binds freshly-chosen high ports and a
  scratch `T3CODE_HOME` under `/tmp`.
- Cleanup uses **targeted port kills only**. Never `pkill -f node`, `pkill vite`,
  or any broad pattern that could kill the real cockpit or other agents' scratch
  instances.
- Concurrent agents may run this simultaneously, so **do not hardcode ports** —
  always allocate free ones (below).

## 1. Allocate a scratch home + two free ports

Fixed ports collide when two agents run at once. Grab two free ports atomically
(hold both sockets until both numbers are read) and a unique scratch home:

```sh
read SERVER_PORT WEB_PORT < <(python3 - <<'PY'
import socket
socks = [socket.socket() for _ in range(2)]
for s in socks: s.bind(("127.0.0.1", 0))
print(*[s.getsockname()[1] for s in socks])
for s in socks: s.close()
PY
)
export SERVER_PORT WEB_PORT
export T3CODE_HOME=$(mktemp -d /tmp/t3code-scratch.XXXXXX)
export WEB_URL="http://localhost:${WEB_PORT}"
echo "server=$SERVER_PORT web=$WEB_PORT home=$T3CODE_HOME"
```

## 2. Start the server

Run from the repo root. `VITE_DEV_SERVER_URL` is what makes the server treat
the web origin as same-origin for credentialed requests — it is **not optional**
(see failure modes).

```sh
T3CODE_HOME=$T3CODE_HOME T3CODE_PORT=$SERVER_PORT \
VITE_DEV_SERVER_URL=$WEB_URL T3CODE_NO_BROWSER=1 \
node apps/server/src/bin.ts > "$T3CODE_HOME/server.out" 2>&1 &
```

Server state lives at `$T3CODE_HOME/userdata/` (an explicitly-set `T3CODE_HOME`
always resolves the `userdata` subdir, even with `VITE_DEV_SERVER_URL` set): DB
at `$T3CODE_HOME/userdata/state.sqlite`, logs at
`$T3CODE_HOME/userdata/logs/server.log`.

## 3. Start the web (Vite)

The **same** `VITE_DEV_SERVER_URL` must be set here too. Run Vite from
`apps/web` (from the repo root it serves a 404 for `/`), bind with `--host` so
`localhost` resolves cleanly, and point the client at the server port:

```sh
(
  cd apps/web
  VITE_DEV_SERVER_URL=$WEB_URL \
  VITE_HTTP_URL=http://localhost:$SERVER_PORT VITE_WS_URL=ws://localhost:$SERVER_PORT \
  vp dev --port $WEB_PORT --host > "$T3CODE_HOME/web.out" 2>&1
) &
```

## 4. Wait for readiness, then authenticate

Readiness signals (approximate timings from a cold start):

| Side   | Ready when the log shows                                                                                | ~Time |
| ------ | ------------------------------------------------------------------------------------------------------- | ----- |
| Server | `Migrations ran successfully`, `Listening on http://127.0.0.1:$SERVER_PORT`, and a printed `pairingUrl` | ~15s  |
| Web    | `Local: http://localhost:$WEB_PORT/`                                                                    | ~12s  |

```sh
grep -m1 pairingUrl "$T3CODE_HOME/server.out"   # or tail -f the *.out files
```

- Open the **pairingUrl** the server printed. If the hash token does not
  auto-fill, paste it manually.
- After auth, a page may show **only the logo for several seconds** before it
  hydrates. `/usage` in particular took ~10s to fully render — wait/poll for
  real content before concluding anything is broken.
- Use **one hostname consistently** for everything (prefer `localhost`, since
  Vite is bound with `--host`). Do not mix `localhost` and `127.0.0.1`.

### Saving screenshot evidence

`browser_take_screenshot` returns the image inline by default (visible in the
transcript only). When a brief asks for screenshot **evidence you can reference
from a report or diff later**, pass the `filename` parameter — the image is
written to that path (relative paths resolve against cwd; parent dirs are
created) and the saved absolute path is returned in the result. Write evidence
under the run's output dir (e.g. a `_debug` subdir), not `/tmp`.

## 5. Seeding ledger-backed views (e.g. /usage)

Views like `/usage` read from projection tables. Seed the DB at
`$T3CODE_HOME/userdata/state.sqlite` (`sqlite3` CLI or `node:sqlite`). Seed rows must
satisfy the **projection schemas**, not just the one table you care about, or
the first load throws HTTP 500 `fetch-session-state`.

Minimum shape:

- A **project** row in `projection_projects`. `scripts_json` must be `'[]'`
  (empty JSON **array**), not `'{}'`.
- A **root thread** and at least one **child thread** in `projection_threads`
  (set `parent_thread_id`, `role`, `project_id`). `model_selection_json` must be
  **non-null**, e.g.
  `{"instanceId":"pi","model":"anthropic/claude-opus-4-8","options":[]}`.
- `projection_usage_ledger` rows spread across the window — e.g. one every ~6
  min for ~3h, plus one **old** row so the weekly view has data — with varied
  models/providers.

Note: usage **gauges** depend on live poller state, not just seeded rows, so in
a scratch instance expect trailing / no-gauge mode. The ledger tables/lists will
populate; the live gauge may not.

## 6. Cleanup (targeted only)

```sh
fuser -k ${WEB_PORT}/tcp
fuser -k ${SERVER_PORT}/tcp
rm -rf "$T3CODE_HOME"
ss -tln | grep -E "${WEB_PORT}|${SERVER_PORT}" || echo "ports free"
```

If you lost the port variables, recover them from the scratch home name / your
notes — never fall back to a broad `pkill`.

## Failure modes

| Symptom                                                                             | Cause                                                                                                                                                                                | Fix                                                                                                                                                  |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page loads but API calls fail — `net::ERR_FAILED` on `/api/auth/session`            | `localhost` vs `127.0.0.1` mismatch between page origin and configured URLs                                                                                                          | Use ONE hostname everywhere; prefer `localhost` (Vite bound with `--host`).                                                                          |
| `Access-Control-Allow-Origin must not be wildcard when credentials mode is include` | **The key gotcha.** `VITE_DEV_SERVER_URL` missing on the **web** side (or server side) — client treats the backend as cross-origin/credentialless even after server CORS looks fixed | Set the **same** `VITE_DEV_SERVER_URL=$WEB_URL` on **both** server and web, then restart both.                                                       |
| First Add project after pairing fails with `<host> is not connected`                | Local-environment WebSocket auth can take a few seconds to settle after pairing                                                                                                      | Reload once after auth (a usage gauge appearing means the WS is connected), then retry.                                                              |
| Stuck on `/pair`; retry says `Invalid pairing token`                                | Pairing tokens are **one-time**; a setup mistake already consumed it                                                                                                                 | Restart the scratch **server** to print a fresh `pairingUrl`; open that.                                                                             |
| HTTP 500 `fetch-session-state` on first load after manual seeding                   | Seed rows violate a projection schema                                                                                                                                                | `projection_projects.scripts_json` must be `'[]'` not `'{}'`; `projection_threads.model_selection_json` must be non-null (see §5). Fix rows, reload. |
