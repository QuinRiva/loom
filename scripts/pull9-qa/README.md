# Pull 9 QA world — `scripts/pull9-qa/`

> **QA-ONLY — NEVER RUN ANY OF THIS AGAINST THE COCKPIT HOME, AND NEVER AS PART OF A
> CUT-OVER.** These scripts build and run a _relocated copy_ of production at
> `/home/Carl/.t3/qa-pull9`, inside a sandbox. Production (`/home/Carl/.t3/cockpit`) is only
> ever read: its database through one read-only `VACUUM INTO`, everything else by copy.
> `build-home.sh` refuses any target that is not `/home/Carl/.t3/qa-<name>`.

Authority: `plans/upstream-pull9-phase4-import/plan.mdx` §2 (the relocation checklist
r0–r9, the sandbox, keeping it running) and §3 (rollback). Decisions taken here are
DL-530–549 in `docs/upstream-sync/32-cadence-pull-9-phase4.md`.

## Order

| Step | Command                                                            | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `build-home.sh`                                                    | r0–r7: preconditions (target absent and allow-listed, free space, port 13940 free); read-only `VACUUM INTO` snapshot; counts-in; copies of reports, briefs, launch identity, `settings.json` (auto-pull neutralised) and the `usage-limit-source-*.bin` secret only; relocation of every recorded path; session manifest and flat byte copy (`sessions.py`); the QA pi agent dir (`build-pi-agent.sh`); `git clone --no-local` of loom with origin at GitHub; the pre-boot allow-list gate. Report: `<qa>/qa/preview.txt`. |
| 2    | `build-loom.sh --ref <integration commit>`                         | r8: clone, `CI=true vp i --no-frozen-lockfile`, `pnpm build` into `<qa>/build/loom`. Never the release store.                                                                                                                                                                                                                                                                                                                                                                                                              |
| 3    | `probe.sh`                                                         | r9: the containment gate. A throwaway unit with exactly the QA unit's sandbox tries every forbidden thing and one real pi one-shot; writes `<qa>/qa/probe.log` ending `PROBE PASSED sandbox=<digest>`.                                                                                                                                                                                                                                                                                                                     |
| 4    | `start.sh`                                                         | The only way the QA server starts: bridge unit `loom-qa-pull9-bridge`, then sandboxed unit `loom-qa-pull9` running `node apps/server/dist/bin.mjs serve --base-dir <qa> --port 13940` from `<qa>/build/loom`. Refuses without a passing probe for the _current_ sandbox definition, without `PrivateUsers=yes`, when a unit is active, or when `server-runtime.json` names a live host server for this home.                                                                                                               |
| 5    | `sqlite3 'file:<qa>/userdata/statev2.sqlite?mode=ro' < verify.sql` | Post-import assertions (server stopped or read-only).                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 6    | `materialise-worktree.sh <threadId>`                               | `git worktree add` in the QA clone at the thread's relocated path and branch; refuses paths outside `<qa>/worktrees/` and threads of uncloned projects.                                                                                                                                                                                                                                                                                                                                                                    |
| —    | `stop.sh`                                                          | Stops both units and waits (the unit's cgroup — server, pi children, relays — goes with it).                                                                                                                                                                                                                                                                                                                                                                                                                               |

Logs: `journalctl --user -u loom-qa-pull9 -f`. Pairing: from `<qa>/build/loom`,
`node apps/server/dist/bin.mjs pair --base-dir /home/Carl/.t3/qa-pull9`. The browser reaches the
server at `127.0.0.1:13940` on the host (SSH-forward it the way 13900 is reached).

## The sandbox

One definition in `lib.sh` (`qa_unit_properties`, `qa_unit_env`, `qa_exec_prefix`), used by
both `start.sh` and `probe.sh`; `start.sh` refuses unless `probe.log` records a pass for the
same definition's digest.

| Layer          | Setting                                                                                                                                                                            | Stops                                                                                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| user namespace | `PrivateUsers=yes`                                                                                                                                                                 | nothing on its own — but on this host's systemd 247 every path property below is silently ignored without it                                                  |
| filesystem     | `ProtectHome=read-only` + `ReadWritePaths=<qa>`; `ReadOnlyPaths=<qa>/build` and production's paths; `InaccessiblePaths=` production's `userdata`, git/gh/ssh/Slack/GCP credentials | writes anywhere outside the QA home (allow-list, not deny-list); reading production's DB, signing keys and every credential                                   |
| `/run`, `/tmp` | `TemporaryFileSystem=/run`, `PrivateTmp=yes`                                                                                                                                       | the user and system bus (`systemctl --user`), `docker.sock` (Carl is in `docker`), every host socket                                                          |
| privileges     | `NoNewPrivileges=yes`                                                                                                                                                              | `sudo` (passwordless on this host)                                                                                                                            |
| network        | `PrivateNetwork=yes` + two unix-socket relays (`bridge.sh` outside, `sandbox-entry.sh` inside)                                                                                     | production's inspector `127.0.0.1:9229`, its HTTP/MCP on 13900/tailnet, databases and every other port; the only flows are cliproxy 8317 (out) and 13940 (in) |
| processes      | `unshare --user --map-current-user --mount --pid --fork --mount-proc`                                                                                                              | seeing, signalling or reading `/proc/<pid>/environ` of production's processes                                                                                 |
| environment    | `env -i` with an explicit allow-list                                                                                                                                               | any inherited credential variable; no `GH_TOKEN`, no Google/Vertex variable                                                                                   |

**Consequence:** QA has no internet. Every `cliproxy/*` model works (all presets except
`coder-direct`); `openai-codex/*`, Vertex models and embeddings, GitHub fetch, PR watch and the
npm registry do not. Shipping from QA fails at the push, loudly.

## Refresh, teardown, rollback

- **Refresh is a rebuild, never a re-point**: `stop.sh; rm -rf /home/Carl/.t3/qa-pull9; build-home.sh …`.
  A server never re-copies `state.sqlite` into an existing `statev2.sqlite`, so a fresh snapshot
  dropped into an old home is silently ignored; `build-home.sh` refuses an existing target.
- **New build, same data**: `stop.sh`, update `<qa>/build/loom` (`git fetch`/`checkout`, `vp i`,
  `pnpm build`) outside the unit, `probe.sh`, `start.sh`.
- **Teardown**: `stop.sh; rm -rf /home/Carl/.t3/qa-pull9` — clone, worktrees, sessions and the
  pi agent dir are all inside it; nothing is left in production.

## Dry run

`fixture.sh <src-dir> /home/Carl/.t3/qa-<name>` builds a tiny V1 "production" and runs
`build-home.sh` against it (gate passing), then shows the refusals and the gate catching an
un-relocated path. Delete both directories afterwards.
