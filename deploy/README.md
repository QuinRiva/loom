# Deploying Loom

Loom deploys itself through upstream T3 Code's service launcher, with Loom's own parts around it.
The design and its reasons are in `plans/loom-deploy-redesign/plan.mdx`; this page is how to
operate it. Everything here runs as Carl on the production machine, usually over SSH.

## The parts

- **The service** `loom-cockpit` (`deploy/systemd/loom-cockpit.service`) starts upstream's launcher
  from `~/loom-releases/current/deploy/runtime/t3 __service-launcher`.
- **The launcher** (upstream's `apps/server/src/serviceLauncher.ts`, unchanged) runs one release
  at a time. On a switch it stops the server, copies the database to
  `<home>/runtime/db-backup/<update id>/`, starts the new release and either accepts it or puts the
  old release and the database back. Its state is `<home>/runtime/service-state.json`.
- **The release runner** (`apps/server/src/loom/deploy/runner.ts`) is what the launcher starts as
  each release. It starts the server, keeps a hard-linked copy of the launcher's database copy
  (the kept copy), runs the five-minute watch before telling the launcher the release started,
  and holds a `--no-return` release that fails.
- **The command** `loom-deploy` (`deploy/loom-deploy`, linked from `~/.local/bin` and on the
  service's search path, so an agent shell in Loom finds it too) runs the deploy
  engine in its own transient unit, `loom-deploy.service`, so a restarting Loom or a dropped SSH
  session cannot kill a deploy half way.

Each release carries all of these, so the parts update with the release they ship in.

## The store

`~/loom-releases/` holds `deploy.json` (the one machine-specific file), `repo.git` (the mirror
releases are checked out from), `releases/<stamp>-<sha7>/` (each a built checkout), `current` and
`previous` (links to release folders), `manifest.json` (what Jacob's instance follows: exactly one
release is `current`, marked only after its watch has passed or after `back`) and
`deploy-history.jsonl` (one line per deploy, which the time estimate reads).

`deploy.json` names the home, state folder, unit, port, repository, search path, the trial port,
the watch (`watchSeconds`, `probeSeconds`, `startTimeoutSeconds`), retention (`keepReleases`,
`keepCopies`), `backupDir` (where the launcher's database copies and the kept copies live; it must
be on the database's own disk), the Slack bridge's unit and health address, the checkouts to
fast-forward, the pi skills folder and the agent slice to stop before each server start.
`engineUnit` names the engine's unit; it defaults to `loom-deploy` and a scratch store must set
its own.

A release's version is `100.<UTC date>.<n>`, stamped into its `apps/server/package.json` before
the build. `<home>/runtime/versions/<version>` is a link to that release's `deploy/runtime/`.

## The verbs

| Verb                                                                                                          | What it does                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loom-deploy deploy [ref] [--no-return] [--release <id>] [--wait] [--origin cli\|slack\|loom] [--who <name>]` | Starts a deploy of `ref` (default `main`) and returns once it has started. `--wait` follows it to the end. `--release` deploys a release already in the store without rebuilding it.                                                                                                              |
| `loom-deploy status [--wait] [--json]`                                                                        | What is running, what the last deploy did and why, and the kept copies. Writes nothing.                                                                                                                                                                                                           |
| `loom-deploy back [--wait]`                                                                                   | Returns to the release before the running one, with the database copy taken when the running one was switched to. Everything written in Loom since that switch is lost; it prints the time first. It runs in the engine's unit and returns once that has started; `--wait` follows it to the end. |
| `loom-deploy retry`                                                                                           | Runs a held release again after a fix.                                                                                                                                                                                                                                                            |
| `loom-deploy cancel`                                                                                          | Stops a deploy that is still building or checking. Loom is not stopped.                                                                                                                                                                                                                           |
| `loom-deploy adopt`                                                                                           | Makes the release it is run from the launcher's active version, with no probation. Used by `back`, at the cut-over and for a launcher protocol change.                                                                                                                                            |

From a Loom thread, run `deploy` and `back` without `--wait` and follow them with `status`: Loom
restarts under the command, and a turn resumed after the restart could otherwise run it a second
time.

`deploy` writes the new deploy's status before it returns, so a `status --wait` straight after it
follows this deploy; a deploy that fails before it builds (a ref that names no commit, a failed
fetch) is called off with its reason and `deploy` exits non-zero.

Do not start a Loom deploy while a bridge deploy is running or being watched, or the reverse:
nothing queues the two, and a Loom switch inside the bridge's watch makes the bridge roll itself
back, which can in turn fail Loom's Slack check. Nothing in Loom's deploy writes
`~/loom-releases/deploy-in-progress`.

A deploy goes through these stages, each written to `<stateDir>/deploy-status.json`, which Loom
pushes to every open client:

| Stage        | Meaning                                                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `building`   | Fetching, checking out, installing, building.                                                                                                                                   |
| `checking`   | The trial start: the new release on a slice of the live database and the real `settings.json`, on the trial port. A release that cannot read the settings is refused here.      |
| `called-off` | Ended before the switch; Loom was not stopped. The reason says why.                                                                                                             |
| `switching`  | The engine asked for the switch. With Loom up it asks the running server; with Loom down it stops the service, writes a pending update through upstream's writer and starts it. |
| `watching`   | The new release answers and is watched (probes every 5 s for 300 s). A failure puts the old release and database back.                                                          |
| `live`       | The watch passed: the launcher accepted the release and `manifest.json` marks it current.                                                                                       |
| `put-back`   | The old release and database are back; the reason says why.                                                                                                                     |
| `held`       | A `--no-return` release that could not run is held in place, with Loom down, for a fix.                                                                                         |

## When something goes wrong

- **Called off.** Nothing to do for Loom; read the reason, fix, deploy again. A routine deploy's
  failed release is kept until the next deploy for inspection.
- **Put back.** Loom is on the old release with the database from before the switch. The new
  release's folder is still there.
- **Held** (`--no-return` only). Loom is down. Fix the release in place under
  `~/loom-releases/releases/<id>/`, then `loom-deploy retry`. Or `loom-deploy back`.
- **A bad `loom-deploy`.** Run the previous release's own copy by its full path,
  `~/loom-releases/releases/<older id>/deploy/loom-deploy`, which needs no install.
- **The service will not start.** `journalctl --user -u loom-cockpit`. If the launcher cannot read
  its state, run the wanted release's own `loom-deploy adopt` with the service stopped, then start
  it.

## A launcher protocol change

Upstream numbers its launcher protocol (3 today). A pull that raises it fails
`apps/server/src/loom/deploy/launcherSeam.test.ts`, and a deploy across it is refused before
anything stops. That one deploy is done by hand, with no probation and no automatic return:

1. `loom-deploy deploy`: it builds and trial-starts the new release, is refused at the switch,
   and leaves the release in the store.
2. `systemctl --user stop loom-cockpit`.
3. Copy `statev2.sqlite` and its `-wal` and `-shm` files somewhere safe.
4. Run the new release's own `~/loom-releases/releases/<id>/deploy/loom-deploy adopt`.
5. `systemctl --user start loom-cockpit` and check `loom-deploy status`.

Going back is the same steps with the old release's `loom-deploy adopt` and the saved copy.

## The cut-over, and the way back to the old mechanism

The cut-over is in the plan's §8 and is started by Carl. Its way back, while the old mechanism is
still at hand: copy `~/.config/systemd/user/loom-cockpit.service.pre-launcher` over the service
file, `systemctl --user daemon-reload`, restart `loom-cockpit`, put the bridge's previous release
back with its own tool (`deployctl rollback bridge`) and start its worker.

The bridge borrows Loom's message definitions through `~/loom-releases/current`, so a Loom change to
those definitions needs the bridge deployed first, as before.
