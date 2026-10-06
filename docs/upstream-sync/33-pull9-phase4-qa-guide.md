# Pull 9 Phase 4 — your QA instance: how to reach it, what to try, where to look

This is the hand-off for the QA world: a relocated copy of your production Loom
(snapshot taken **2026-10-06 14:32Z**) running the pull-9 build (Orchestration V2 +
Loom's layer + the V1 importer) inside a sandbox. You can drive it for days; nothing in
it can write to production. The decision record is
`docs/upstream-sync/32-cadence-pull-9-phase4.md` (DL-550–579 are this build); the plan is
`plans/upstream-pull9-phase4-import/plan.mdx`.

**What is running:** systemd user units `loom-qa-pull9` (the server, sandboxed) and
`loom-qa-pull9-bridge` (the relay), serving `127.0.0.1:13940`. Build commit
`cccb2395c7` (the Phase 4 integration branch head on 2026-10-06).

## 1. Reach it

1. Forward the port the way you reach 13900: `ssh -L 13940:127.0.0.1:13940 carl-dev`
   (or add `13940` to VS Code's forwarded ports).
2. **Pairing.** Every boot prints a one-time admin pairing URL, valid for **5 minutes**:

   ```bash
   journalctl --user -u loom-qa-pull9 --since -10min | grep 'Pairing URL'
   ```

   Open it as `http://localhost:13940/pair#token=…` in your browser. If the window has
   passed, restart (section 3) and use the new URL. Two routes that look right do **not**
   work: `node apps/server/dist/bin.mjs pair --base-dir /home/Carl/.t3/qa-pull9` refuses
   ("No running T3 Code server found" — the server's recorded pid is a pid inside the
   sandbox's own PID namespace), and Settings → Connections cannot mint links on a
   loopback-only server. Once paired, the browser session lasts 30 days, across restarts.

## 2. What you are looking at

| Thing                                                                       | Where                                                                                      |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| QA home (`--base-dir`)                                                      | `/home/Carl/.t3/qa-pull9/`                                                                 |
| V2 database (everything QA writes)                                          | `/home/Carl/.t3/qa-pull9/userdata/statev2.sqlite`                                          |
| V1 snapshot (relocated, read once at first boot, never again)               | `/home/Carl/.t3/qa-pull9/userdata/state.sqlite`                                            |
| pi sessions (byte copies of 4,013 production files + everything QA creates) | `/home/Carl/.t3/qa-pull9/pi-sessions/`                                                     |
| QA pi agent dir (auth, settings, models, the anthropic-messages bridge)     | `/home/Carl/.t3/qa-pull9/pi-agent/`                                                        |
| The only cloned repo — loom (origin → GitHub, unreachable)                  | `/home/Carl/.t3/qa-pull9/repos/loom`                                                       |
| Every other project                                                         | `/home/Carl/.t3/qa-pull9/repos/not-cloned/<project_id>` (does not exist: browsable, inert) |
| Worktrees (only those materialised or created in QA exist)                  | `/home/Carl/.t3/qa-pull9/worktrees/`                                                       |
| The server build                                                            | `/home/Carl/.t3/qa-pull9/build/loom` (read-only inside the sandbox)                        |
| Build reports (`preview.txt`, `probe.log`, session manifest, missing list)  | `/home/Carl/.t3/qa-pull9/qa/`                                                              |

What came across (first boot, 14:49Z): **4,227** V1 threads considered → **2,771**
workstream sidecars (every non-archived workstream thread), **3,604** lineage re-emits
(every non-deleted child, archived included), **4,003** sessions bound, **164** with no
session file, **0** corrupt, **4** non-pi (old anthropic/vertex children), **56** deleted
skipped, **0** failed; **488** goals and **3,479** tasks. By outcome: 2,243 done, 168
cancelled, 360 open — of which 19 held and 4 yielded (they carry `awaiting_orchestrator`).

## 3. Restart, rebuild, tear down

All of these run **from the build copy** — the scripts refuse anywhere else:

```bash
cd /home/Carl/.t3/qa-pull9/build/loom/scripts/pull9-qa
./stop.sh; ./start.sh        # restart (stop waits for the whole unit: server, pi children, relays)
journalctl --user -u loom-qa-pull9 -f        # the log
```

Never start the server by hand (`node … serve`), and never kill a QA process by name —
production's server has the same argv shape. `start.sh` refuses without a passing probe
for the current sandbox definition, so if anyone edits `lib.sh`, run `./probe.sh` first.

**New build, same data** (a Phase 3 fix lands): `./stop.sh`; in
`/home/Carl/.t3/qa-pull9/build/loom` run `git fetch /home/Carl/loom <branch> && git checkout --detach FETCH_HEAD && CI=true vp i --no-frozen-lockfile && pnpm build`;
then `./probe.sh` and `./start.sh` (from the build's `scripts/pull9-qa`, which is now the new build's copy).

**Refresh from a newer production snapshot** is a rebuild, never a re-point (a server never
re-copies `state.sqlite` into an existing `statev2.sqlite`):

```bash
/home/Carl/.t3/qa-pull9/build/loom/scripts/pull9-qa/stop.sh
rm -rf /home/Carl/.t3/qa-pull9
cd <a loom checkout containing scripts/pull9-qa at or after this commit>
scripts/pull9-qa/build-home.sh                   # ~10 min, needs ~25 GB free
scripts/pull9-qa/build-loom.sh --ref <commit>    # ~3 min
/home/Carl/.t3/qa-pull9/build/loom/scripts/pull9-qa/probe.sh   # must end PROBE PASSED
/home/Carl/.t3/qa-pull9/build/loom/scripts/pull9-qa/start.sh
```

Use a checkout that has DL-552 (this commit or later): without it, every new-worktree
thread fails at "Fetch base branch".

**Teardown is yours:** `stop.sh; rm -rf /home/Carl/.t3/qa-pull9`. The clone, worktrees,
sessions and agent dir are all inside it; nothing is left in production.

## 4. No network — what works and what does not

The sandbox has no internet (DL-502). Through the inference-only relay, every
`cliproxy/*` model works (all presets except `coder-direct`). These do not:
`openai-codex/*`, Vertex models and thread-search embeddings, GitHub (fetch, PR watch,
`gh`, shipping — a shipper fails at the push, loudly), the npm registry, the quota pollers.

Consequences you will see:

- **New worktrees start from your local branch**, not `origin/…` (the build sets
  `newWorktreesStartFromOrigin` off). If a thread shows _"Workspace preparation failed …
  Fetch base branch … Could not reach the remote"_, it was created with "from origin" —
  **Retry does not help** (it reuses the stored choice); start a new thread instead.
- **The setup script fails** ("Worktree ready, setup script failed") because `vp i` needs
  the registry. The agent still runs; the worktree simply has no `node_modules`, so agents
  in QA cannot run tests, typecheck or builds there. Keep QA briefs to local edits and git.
- The journal is noisy with `thread branch pull request lookup failed`, `Background Git
fetch failed`, `automatic thread settlement skipped` and favicon warnings for the
  un-cloned projects. All expected.

**Reversal** (if you want internet in QA): delete the line `-p PrivateNetwork=yes` in
`qa_unit_properties` in `scripts/pull9-qa/lib.sh` **of the build copy** — it is read-only
inside the sandbox but an ordinary file to you —, then `./stop.sh; ./probe.sh; ./start.sh`.
That also re-opens the network escapes the probe was built to close (production's
inspector on 9229, loopback services), so only do it deliberately.

## 5. The smoke checklist — what to try, what I saw on the dry run

I walked every row once on 2026-10-06 (15:00–15:27Z) so your walk is not the instance's
first. Screenshots and logs are under `.artifacts/pull9-p4/qa-world/` in the Phase 4
orchestrator's worktree. Where a row says _log_, it means
`journalctl --user -u loom-qa-pull9 | grep <string>`; a named query is in
`scripts/pull9-qa/verify.sql`; run SQL read-only:
`sqlite3 'file:/home/Carl/.t3/qa-pull9/userdata/statev2.sqlite?mode=ro'`.

| #   | Scenario                                     | Do                                                                                                                                                     | What you should see                                                                                                             | What I saw                                                                                                                                                                                                                                                                                                                                                                                                                  | If it fails, look at                                                                                                                    |
| --- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Imported graph on the board                  | Open the Workstream panel on a finished workstream (e.g. _Track 3c: Pi adapter economics_) and an unfinished one (e.g. _April Group PoV — next phase_) | Roots with their children, roles, columns, dependencies and gate routes as they were; yielded children flagged; archived absent | **Pass.** Track 3c: 6 sub-threads all in Done; April Group PoV: 32 sub-threads, 4 in progress with `awaiting re-review`; Graph tab renders the whole Pull 9 tree (102/106 settled). Children do not appear as sidebar roots                                                                                                                                                                                                 | verify.sql A, B, E; a wrong child: `SELECT warnings_json FROM loom_legacy_imports WHERE thread_id = '<id>'`                             |
| 2   | Goals and task trees                         | Right panel `+` → _Goal tasks_ on an imported root                                                                                                     | Goal, description and task tree with ticks as in production                                                                     | **Pass.** _Pull 9 strategy_ shows 96/108, matching production at snapshot time                                                                                                                                                                                                                                                                                                                                              | verify.sql H (488 goals / 3,479 tasks)                                                                                                  |
| 3   | Imported orchestrator remembers              | Open an imported orchestrator; ask, without tools, its goal and the last report it received; then `pwd`                                                | A specific, correct answer; `pwd` under `/home/Carl/.t3/qa-pull9/`                                                              | **Pass** on _Track 3c_ (`ddf92799`): named its goal and the 3c-3 gate verdict from reviewer `41b3cf4c` (clean) — correct; `pwd` = `/home/Carl/.t3/qa-pull9/worktrees/t3code-87358b97/ws-t3code-plan-next-upstream-merge-orchestrator-36d2f990`. Zero `Provider resume failed`; no `Context handoff` prefix; production's session file byte-identical afterwards                                                             | log: `Provider resume failed` (must be absent); `SELECT session_status, session_path FROM loom_legacy_imports WHERE thread_id = '<id>'` |
| 4   | Imported child remembers and keeps its place | Same on one of its children                                                                                                                            | Correct answer; board position unchanged; parent not woken                                                                      | **Pass** on _3c-1 quota classifier_ (`65112189`): correct goal and last receipt; stayed Done; parent got no message (28 messages before and after). It noticed it is now in its parent's checkout, not the per-child worktree it committed in — V1 recorded the parent's path for children                                                                                                                                  | verify.sql I (0)                                                                                                                        |
| 5   | Spawn a child                                | In a new root on loom, ask the orchestrator to spawn a coder with a small brief                                                                        | Child on the board, hidden from the sidebar, kicked off once, in the parent's checkout                                          | **Pass.** Root _Workstream Delegation Smoke Test_: `smoke-a` kicked off once (one `kickoff` message), committed in the root's worktree                                                                                                                                                                                                                                                                                      | `SELECT kickoff_at, kickoff_brief_path FROM loom_thread_workstream WHERE thread_id = '<child>'`                                         |
| 6   | Dependency release                           | Two children, the second blocked by the first                                                                                                          | Second starts only after the first is done                                                                                      | **Pass.** `smoke-a` done 15:09:53.682Z → `smoke-b` kicked off 15:09:54.430Z                                                                                                                                                                                                                                                                                                                                                 | `SELECT thread_id, blocked_by, outcome, kickoff_at FROM loom_thread_workstream WHERE parent_thread_id = '<root>'`                       |
| 7   | Gated review round                           | Coder + reviewer with a loop route; reviewer returns `needs_rework`, then `clean`                                                                      | Coder re-prompted without the orchestrator waking; both done; per-round reports                                                 | **Pass.** Reviewer round 1 `needs_rework` → coder reworked (`c` + `c2`) → round 2 `clean`; `.round-1.md` files for both; root got one digest at the end only                                                                                                                                                                                                                                                                | `SELECT gate_rounds, pending_rework, outcome, last_route FROM loom_thread_workstream WHERE thread_id IN (…)`; log: `workstream-gate`    |
| 8   | notify_thread                                | From a child, notify a busy sibling and an idle thread                                                                                                 | Busy: steered into its running turn; idle: starts a turn                                                                        | **Pass, with one defect (row 11).** Busy (`smoke-busy-2`, mid-`sleep 90`): "steered into running turn", delivered after the tool call returned. Idle: a root with no outcome started a turn and replied. A **done** child is refused ("finished or archived; it cannot be notified") by design. Coders must `enable_toolset delegation` first                                                                               | `SELECT * FROM loom_thread_peer_messages ORDER BY created_at DESC LIMIT 5`                                                              |
| 9   | ask_user_question on a root                  | Ask a root to ask you a structured question; answer it                                                                                                 | The agent gets the answer once and continues; a child is refused                                                                | **Pass.** Root asked "Pick a colour"; I picked blue; it received `{"q1":"blue"}` once. A child's `enable_toolset human-input` is refused: "This thread has no human reader … Consult your parent with consult_thread"                                                                                                                                                                                                       | `SELECT * FROM orchestration_v2_projection_runtime_requests WHERE thread_id = '<root>'`                                                 |
| 10  | Consult an imported thread                   | From a new root, `consult_thread` an imported child                                                                                                    | An answer grounded in its transcript                                                                                            | **Pass.** Asked _3c-2 reroute sweep_ (`a169ff2d`) which commit its work landed as: "`b3e3b18886` — feat(server): cross-vendor reroute sweep …", correct. The fork lives in `/home/Carl/.t3/qa-pull9/userdata/workstream-consults/`                                                                                                                                                                                          | the consult card; `ls -t /home/Carl/.t3/qa-pull9/userdata/workstream-consults`                                                          |
| 11  | Restart mid-run                              | `stop.sh` while a child is mid-turn with a pending notify; `start.sh`                                                                                  | The child continues with its pending steer; `needs_guidance` children not continued; imported threads untouched                 | **Phase 3 defect.** `smoke-busy` (mid-`sleep 300`, with `hello from notifier` steered in at 15:17:07) was cancelled at stop and continued after start with only "Continue where you left off." — **the accepted steer was lost** (absent from its session file; `pending-steering/` empty after boot). Imported threads untouched: no imported thread ran except the three I messaged; no `needs_guidance` thread continued | log after start: `recovery`; `ls /home/Carl/.t3/qa-pull9/userdata/pending-steering/`                                                    |
| 12  | Archived import                              | Unarchive an archived imported root (Settings → Archive); send it a message                                                                            | It remembers its transcript                                                                                                     | **Pass** on _Create Loom Issue-Reporting Skill_ (`d3fcf30b`, materialised first): named its goal and the shipper's report (PR #286 merged); `pwd` in QA; no resume failure. I left it **unarchived** — re-archive it if you like                                                                                                                                                                                            | `SELECT status, session_status FROM loom_legacy_imports WHERE thread_id = '<id>'`                                                       |
| 13  | Rebuild check                                | After the soak: tear down and rebuild from a fresh snapshot                                                                                            | A fresh world; the old one gone                                                                                                 | **Not run** (by design — it would destroy this world). `build-home.sh` refuses an existing home; `preview.txt` is regenerated                                                                                                                                                                                                                                                                                               | section 3                                                                                                                               |

Things you will trip over:

- **Continuing an imported thread needs its worktree first.** Only `ddf92799`/`65112189`
  (shared path) and `d3fcf30b` are materialised. For any other imported loom thread:
  `/home/Carl/.t3/qa-pull9/build/loom/scripts/pull9-qa/materialise-worktree.sh <threadId>`
  (refuses threads of un-cloned projects, and a thread whose branch the clone has checked
  out — `main`). Threads of other projects can be read but not continued.
- **An imported child that ran isolated in V1 continues in its root's checkout**, on the
  root's branch — V1 stored the root's `worktree_path`/`branch` on such children (701 of
  the live imported children; 15 are not finished) and derived the child's own worktree
  by convention, which V2 does not. Harmless in QA; a follow-up that commits lands on the
  root's branch. It matters at cut-over (DL-578).
- Starting a root takes two messages to stamp its `kickoffAt` (Phase 3 rule); the board
  is fine meanwhile.
- **Settings → Archive lists archived children individually** (their lineage is correct —
  `subagent` with the right parent; it is the page, not the import).
- **The _Start from origin_ switch** in Settings → General did not toggle when I drove it
  from a headless browser; I set it in `settings.json` with the server stopped instead.
  Worth one click by hand to see whether it is a real UI defect.
- The first smoke root (_Workstream Delegation Smoke Test_, shown **Failed**, on `main`) is
  the casualty of the start-from-origin default; archive or delete it.
- Imported Loom control messages (kickoffs, digests) render as if you had typed them
  (plan §4 — a known cosmetic, left for your decision).
- `verify.sql` is an **import-time** check. After you use the instance, A/B/H counts grow
  and C's `episode_stamps_set` / `started_without_kickoff` pick up new and unarchived
  threads — that is drift by design, not a failure. G, I and J must stay 0.

## 6. Where to look when something fails

- **The log:** `journalctl --user -u loom-qa-pull9 --since -1h`; relay:
  `journalctl --user -u loom-qa-pull9-bridge`. Useful greps: `Provider resume failed`,
  `Loom V1 workstream import`, `recovery completed`, `ERROR`, `kickoff`, `quiescen`.
- **Import ledger** per thread: `SELECT status, session_status, session_path, warnings_json FROM loom_legacy_imports WHERE thread_id = '<id>'`.
  Six rows carry warnings: three children of deleted parent `d568d0c6` and three
  dependencies/routes on archived-done threads that were dropped.
- **The workstream row:** `SELECT * FROM loom_thread_workstream WHERE thread_id = '<id>'`.
- **What the agent actually saw:** the session file in `/home/Carl/.t3/qa-pull9/pi-sessions/`
  (imported threads keep their production file name `<timestamp>_<threadId>.jsonl`).
- **Containment check, any time:** the server's open files never name the cockpit —
  `CG=/sys/fs/cgroup/user.slice/user-1001.slice/user@1001.service/app.slice/loom-qa-pull9.service; for p in $(cat $CG/cgroup.procs); do ls -l /proc/$p/fd 2>/dev/null | grep cockpit; done` (expect nothing).

## 7. Lists for your review (from `preview.txt` and the first boot)

**Genuine holds — 19 planned children that never started** (imported `held`; release them
from the board if you want them to run): Staging validation pre-PE-2309 prior
(`16b6214b`), W2a schema additions (`2188668d`), Pipeline failure-data corpus
(`35d00c7d`), Cross-lens finding reconciliation (`39d9f758`), Classifier-lens full pass
(`521e74d6`), A12 review gate (`546ba507`), Final artefact gate (`6d5b4083`),
Missing-doc-lens full pass (`6ddf215d`), W1 quote-validated evidence (`6e781f18`), W2a PR
(`7ca87cb1`), Design-decisions register collation (`86d1cdd7`), W1 evidence review gate
(`aed63e87`), Dependency-resolver-lens full pass (`affa53ae`), A12 required non-string
leaves (`c21f41dd`), Full-pass defect ledger decision doc (`caabc861`), W1 PR
(`cef97a7c`), A12 PR (`d210bf1d`), Explain the AIT-35 patch (`d39db5d2`), W2a schema review
gate (`f67bcf14`).

**Would-be kickoffs — 8 briefed, never-started children.** Seven are among the holds above
(so they wait for you). The eighth, _QA-world evidence gate_ (`51b9285d`, ready), is
blocked by this build's own thread (`cb528d50`), which is in progress in the snapshot — it
will not start unless that imported thread is continued to `done` in QA. Nothing was
kicked off on the first pass (verify.sql I = 0; no quiescent report after 18 minutes of
uptime across two boots).

**Active goals without threads:** none (verify.sql H's review list is empty).

**Threads with no session file — 164** (`/home/Carl/.t3/qa-pull9/qa/sessions-missing.txt`
lists them plus the 4 non-pi): 103 live imported threads (13 are from October, mostly
the never-started children above; the rest are July–September threads whose pi session
is gone), 60 archived children, 1 archived root. They open and read fine; continuing one
falls back to upstream's legacy hand-off (the transcript replayed as context) instead of
resuming its session.

**Dropped at import:** three dependencies and three review routes pointing at archived,
done threads (`90b1f78e`, `b01305cd`, `be6b0933`).

## 8. Two runbook lines for you to paste (plan §4)

Phase 4 does not write to `~/loom-releases`, so these are yours to add to `~/loom-releases/RUNBOOK.md`:

- _If production is ever rolled back to a pre-V2 release and later re-cut, delete
  `~/.t3/cockpit/userdata/statev2.sqlite*` first — a second boot does not re-copy `state.sqlite`._
- _`scripts/pull9-qa/build-home.sh` is QA-only: never run it against the cockpit home._

## Appendix A — `preview.txt` (build-home.sh report, verbatim)

```text
# QA world build 2026-10-06T14:32:07Z by scripts/pull9-qa/build-home.sh @ cccb2395c7
sources: db=/home/Carl/.t3/cockpit/userdata/state.sqlite state=/home/Carl/.t3/cockpit/userdata worktrees=/home/Carl/.t3/cockpit/worktrees sessions=/home/Carl/.pi/agent/sessions repo=/home/Carl/loom → target /home/Carl/.t3/qa-pull9
r0 preconditions ok: target absent and allow-listed; 71 GiB free (need 22); port 13940 free
r1 snapshot: VACUUM INTO /home/Carl/.t3/qa-pull9/userdata/state.sqlite (5867 MiB; source opened read-only)
r2 counts-in: goals 488, goal tasks 3479, threads 4227 (in scope: 2771); per-lane counts in the preview section below
r4 copied workstream-reports: 4212 files
r4 copied workstream-briefs: 2925 files
r4 copied workstream-launch-identity: 6467 files
r4 copied NO secrets (the usage-limit source credential is cliproxy's management key — DL-547) and NO attachments
r3 projects: 1 → repos/loom (the only clone), 37 → repos/not-cloned/<project_id> (does not exist: browsable, inert)
r3 worktrees: 3706 recorded; 3435 rebased under /home/Carl/.t3/qa-pull9/worktrees/, 271 outside /home/Carl/.t3/cockpit/worktrees/ → NULL
  721aa361-1c3e-4859-a66b-41228fe993e1 report_path: 721aa361-1c3e-4859-a66b-41228fe993e1.md → /home/Carl/.t3/qa-pull9/userdata/workstream-reports/721aa361-1c3e-4859-a66b-41228fe993e1.md
  3b2b07d9-eb72-4c43-9d3e-9cf5590eb2ac report_path: 3b2b07d9-eb72-4c43-9d3e-9cf5590eb2ac.md → /home/Carl/.t3/qa-pull9/userdata/workstream-reports/3b2b07d9-eb72-4c43-9d3e-9cf5590eb2ac.md
  9c0b8198-1dcf-4bb6-aefc-42ecd1ca26c2 report_path: 9c0b8198-1dcf-4bb6-aefc-42ecd1ca26c2.md → /home/Carl/.t3/qa-pull9/userdata/workstream-reports/9c0b8198-1dcf-4bb6-aefc-42ecd1ca26c2.md
  af403c17-b087-4184-9ff4-dafadd4839f1 report_path: af403c17-b087-4184-9ff4-dafadd4839f1.md → /home/Carl/.t3/qa-pull9/userdata/workstream-reports/af403c17-b087-4184-9ff4-dafadd4839f1.md
  932d13c8-554f-4cf9-a12c-a25754b0cdf3 report_path: 932d13c8-554f-4cf9-a12c-a25754b0cdf3.md → /home/Carl/.t3/qa-pull9/userdata/workstream-reports/932d13c8-554f-4cf9-a12c-a25754b0cdf3.md
  4edc8247-edb9-4e6f-9b30-2bc45ab89cee report_path: 4edc8247-edb9-4e6f-9b30-2bc45ab89cee.md → /home/Carl/.t3/qa-pull9/userdata/workstream-reports/4edc8247-edb9-4e6f-9b30-2bc45ab89cee.md
  592443da-c766-4d6a-892f-7d321b0d49c4 report_path: 592443da-c766-4d6a-892f-7d321b0d49c4.md → /home/Carl/.t3/qa-pull9/userdata/workstream-reports/592443da-c766-4d6a-892f-7d321b0d49c4.md
  d5fa9632-d05c-4dbb-ba28-a909df8b8ab8 report_path: d5fa9632-d05c-4dbb-ba28-a909df8b8ab8.md → /home/Carl/.t3/qa-pull9/userdata/workstream-reports/d5fa9632-d05c-4dbb-ba28-a909df8b8ab8.md
  ea49aa3b-e54c-4948-b99e-b4e79dda0fd9 report_path: ea49aa3b-e54c-4948-b99e-b4e79dda0fd9.md → /home/Carl/.t3/qa-pull9/userdata/workstream-reports/ea49aa3b-e54c-4948-b99e-b4e79dda0fd9.md
  c382ca6d-7480-4302-a03c-568226f0f653 report_path: c382ca6d-7480-4302-a03c-568226f0f653.md → /home/Carl/.t3/qa-pull9/userdata/workstream-reports/c382ca6d-7480-4302-a03c-568226f0f653.md
  281c5cf4-8641-415e-a27c-22145730cb12 report_path: 281c5cf4-8641-415e-a27c-22145730cb12.md → /home/Carl/.t3/qa-pull9/userdata/workstream-reports/281c5cf4-8641-415e-a27c-22145730cb12.md
  bcb70c39-1a52-4619-966f-d64e5720bac7 report_path: bcb70c39-1a52-4619-966f-d64e5720bac7.md → /home/Carl/.t3/qa-pull9/userdata/workstream-reports/bcb70c39-1a52-4619-966f-d64e5720bac7.md
  37c86cda-253e-4957-8724-45c932bc07f5 report_path: 37c86cda-253e-4957-8724-45c932bc07f5.md → /home/Carl/.t3/qa-pull9/userdata/workstream-reports/37c86cda-253e-4957-8724-45c932bc07f5.md
  9aff9595-99c9-4fc4-8037-b7d0651e2f93 report_path: 9aff9595-99c9-4fc4-8037-b7d0651e2f93.md → /home/Carl/.t3/qa-pull9/userdata/workstream-reports/9aff9595-99c9-4fc4-8037-b7d0651e2f93.md
  03d1fc6f-1ba4-45b9-8e3f-87540f8c3755 report_path: 03d1fc6f-1ba4-45b9-8e3f-87540f8c3755.md → /home/Carl/.t3/qa-pull9/userdata/workstream-reports/03d1fc6f-1ba4-45b9-8e3f-87540f8c3755.md
  ee68e5ec-38df-406a-9b8d-77020823d408 report_path: ee68e5ec-38df-406a-9b8d-77020823d408.md → /home/Carl/.t3/qa-pull9/userdata/workstream-reports/ee68e5ec-38df-406a-9b8d-77020823d408.md
  b0b42251-5781-4ef3-9341-1cbe96e7affc report_path: b0b42251-5781-4ef3-9341-1cbe96e7affc.md → /home/Carl/.t3/qa-pull9/userdata/workstream-reports/b0b42251-5781-4ef3-9341-1cbe96e7affc.md
  499e5347-af2d-460b-a1bd-839c8dc5690a report_path: 499e5347-af2d-460b-a1bd-839c8dc5690a.md → /home/Carl/.t3/qa-pull9/userdata/workstream-reports/499e5347-af2d-460b-a1bd-839c8dc5690a.md
  f7e1cb88-9757-42ec-a941-d0103f84db39 report_path: f7e1cb88-9757-42ec-a941-d0103f84db39.md → /home/Carl/.t3/qa-pull9/userdata/workstream-reports/f7e1cb88-9757-42ec-a941-d0103f84db39.md
  8af137f1-15db-469e-bd2c-53d6eff16030 report_path: 8af137f1-15db-469e-bd2c-53d6eff16030.md → /home/Carl/.t3/qa-pull9/userdata/workstream-reports/8af137f1-15db-469e-bd2c-53d6eff16030.md
  55905131-d673-4bfb-98a1-dd7be3f9c7c7 report_path: 55905131-d673-4bfb-98a1-dd7be3f9c7c7.md → /home/Carl/.t3/qa-pull9/userdata/workstream-reports/55905131-d673-4bfb-98a1-dd7be3f9c7c7.md
  e3268574-9301-4add-8c3f-50601b039539 report_path: e3268574-9301-4add-8c3f-50601b039539.md → /home/Carl/.t3/qa-pull9/userdata/workstream-reports/e3268574-9301-4add-8c3f-50601b039539.md
  13cabbd3-58cc-4ad8-892e-31f5d9840aa4 report_path: 13cabbd3-58cc-4ad8-892e-31f5d9840aa4.md → /home/Carl/.t3/qa-pull9/userdata/workstream-reports/13cabbd3-58cc-4ad8-892e-31f5d9840aa4.md
  92a4e33b-ebfd-43dd-98b5-7a62134264ed report_path: 92a4e33b-ebfd-43dd-98b5-7a62134264ed.md → /home/Carl/.t3/qa-pull9/userdata/workstream-reports/92a4e33b-ebfd-43dd-98b5-7a62134264ed.md
  eac26c2e-76bb-4c2e-b3cb-8bcc059f38e1 report_path: eac26c2e-76bb-4c2e-b3cb-8bcc059f38e1.md → /home/Carl/.t3/qa-pull9/userdata/workstream-reports/eac26c2e-76bb-4c2e-b3cb-8bcc059f38e1.md
  96fff6d5-c4d3-4ba9-a81d-659b855c1a81 report_path: 96fff6d5-c4d3-4ba9-a81d-659b855c1a81.md → /home/Carl/.t3/qa-pull9/userdata/workstream-reports/96fff6d5-c4d3-4ba9-a81d-659b855c1a81.md
  d82f731f-975d-4c52-9e6e-008928cd4687 report_path: d82f731f-975d-4c52-9e6e-008928cd4687.md → /home/Carl/.t3/qa-pull9/userdata/workstream-reports/d82f731f-975d-4c52-9e6e-008928cd4687.md
  3eea68c0-ed6e-4227-b198-85ac53c74931 report_path: 3eea68c0-ed6e-4227-b198-85ac53c74931.md → /home/Carl/.t3/qa-pull9/userdata/workstream-reports/3eea68c0-ed6e-4227-b198-85ac53c74931.md
  e40bfc66-d43c-4b24-ad37-32e953d872f9 report_path: e40bfc66-d43c-4b24-ad37-32e953d872f9.md → /home/Carl/.t3/qa-pull9/userdata/workstream-reports/e40bfc66-d43c-4b24-ad37-32e953d872f9.md
  2e36aea1-48d6-4aec-919b-e44a0453eb5b report_path: 2e36aea1-48d6-4aec-919b-e44a0453eb5b.md → /home/Carl/.t3/qa-pull9/userdata/workstream-reports/2e36aea1-48d6-4aec-919b-e44a0453eb5b.md
  d3c3c691-cd69-4297-b82b-92dfc2959050 report_path: d3c3c691-cd69-4297-b82b-92dfc2959050.md → /home/Carl/.t3/qa-pull9/userdata/workstream-reports/d3c3c691-cd69-4297-b82b-92dfc2959050.md
  dbda9209-314b-4cbc-aa97-241e9fc99879 report_path: dbda9209-314b-4cbc-aa97-241e9fc99879.md → /home/Carl/.t3/qa-pull9/userdata/workstream-reports/dbda9209-314b-4cbc-aa97-241e9fc99879.md
r3 report/brief paths outside /home/Carl/.t3/cockpit/userdata/: 32 rewritten into the QA state dir (32 bare names resolved to the copied /home/Carl/.t3/cockpit/userdata/<reports|briefs>/ file, 0 files copied, 0 absent — kept as the record; listed above)
DL-265 before: auto_pull column had 1 project(s) on; settings {"defaultAutoPull":null,"projectAutoPullOverrides":{"c2dc6422-153e-44b5-bbcb-64b8fb0fd0ea":true},"folded":true,"overridesWithAutoPull":["c2dc6422-153e-44b5-bbcb-64b8fb0fd0ea"]}
DL-265 after: auto_pull column on for 0 project(s); settings defaultAutoPull=false, projectAutoPullOverrides all false (1), projectSettingsOverrides[*].defaultAutoPull=false for all 38 projects; pi binaryPath ["pi"]
r5 manifest: 4171 non-deleted threads; 4013 session files for 4003 threads; 5.42 GiB; 168 threads with no session file; 66.1 GiB free
r5 copied 4013 files flat into /home/Carl/.t3/qa-pull9/pi-sessions; last line unparseable after re-copy: 0; header id != thread id (importer will report corrupt): 0
r5 manifest /home/Carl/.t3/qa-pull9/qa/session-manifest.txt; threads without a session file: /home/Carl/.t3/qa-pull9/qa/sessions-missing.txt
[14:40:48Z] pi-agent: 16 cliproxy models from 1.0.3 pi-ai, baseUrl http://127.0.0.1:8317, 11 betas; extension @blackbelt-technology/pi-anthropic-messages@0.3.4; settings keys: ["defaultModel","defaultProvider","defaultThinkingLevel","hideThinkingBlock","lastChangelogVersion","theme"]
r6 cloned /home/Carl/loom → /home/Carl/.t3/qa-pull9/repos/loom (381 remote branches, 298M); origin → https://github.com/QuinRiva/loom.git (writes are stopped by the unit's sandbox, not by the remote)
r7 gate passed: every recorded worktree/report/brief path and project root is inside /home/Carl/.t3/qa-pull9 (allow-list counts: 0 0); no statev2.sqlite

== preview.sql (review lists)
gate_thread_paths_outside_qa
0
gate_project_roots_outside_qa
0

== Counts-in (verify.sql A, B, H compare against these)
in_scope_threads
2771
plan_lane | is_child | n
cancelled | 0 | 1
cancelled | 1 | 167
done | 0 | 9
done | 1 | 2234
in_progress | 0 | 24
in_progress | 1 | 10
planned | 0 | 300
planned | 1 | 19
ready | 1 | 3
yielded | 1 | 4
projection_goals | projection_goal_tasks
488 | 3479
threads_total | deleted | archived
4227 | 56 | 1395

== The genuine holds: planned children with no turn and no user message, plus (DL-511) never-started
== non-terminal children with a dependency on a non-done thread outside the live graph (Carl reviews these)
thread_id | title | role | plan_lane
16b6214b-be3a-463a-a856-a65b5c452fda | Staging validation, pre-PE-2309 prior | researcher | planned
2188668d-6c6b-4ea3-bd19-0f4b37877979 | W2a schema additions | coder | planned
35d00c7d-87e9-4bb1-af3b-f5766799ff08 | Pipeline failure-data corpus | researcher | planned
39d9f758-0e47-441b-932b-40dd92b80c5e | Cross-lens finding reconciliation | assessor | planned
521e74d6-3819-4618-a21c-cbef0cb0c436 | Classifier-lens full pass | assessor | planned
546ba507-7024-44d7-a0b4-6c3f13ecbfd7 | A12 review gate | reviewer | planned
6d5b4083-0106-44ad-86cb-147672cf1e5c | Final artefact gate | reviewer | planned
6ddf215d-4ae8-4a8f-b7f3-41be1519a5c0 | Missing-doc-lens full pass | assessor | planned
6e781f18-7b29-428b-95c2-633e0546972f | W1 quote-validated evidence | coder | planned
7ca87cb1-ea87-439f-8239-af487ebbe9ff | W2a PR | shipper | planned
86d1cdd7-8015-4c91-8892-80b74dafcfdd | Design-decisions register collation | coder | planned
aed63e87-4d1d-4ad4-abef-37e765fc570c | W1 evidence review gate | reviewer | planned
affa53ae-29e4-4c19-92f0-0f9036ec46d1 | Dependency-resolver-lens full pass | assessor | planned
c21f41dd-c30e-4969-81d3-251bfdf2d2f2 | A12 required non-string leaves | coder | planned
caabc861-d859-4f85-9ea4-ca9528582241 | Full-pass defect ledger decision doc | coder | planned
cef97a7c-b14a-45d2-a7b5-c4614e8674ea | W1 PR | shipper | planned
d210bf1d-0b7a-4425-98f8-78cbb434258a | A12 PR | shipper | planned
d39db5d2-2b0f-4941-9d37-c2ad2845f6f3 | Explain the AIT-35 patch | researcher | planned
f67bcf14-359c-4fb4-bf49-6f843f84bc90 | W2a schema review gate | reviewer | planned

== Would-be kickoffs: ready/planned children, never started, briefed (the dispatcher will start these after import)
thread_id | title | plan_lane | blocked_by
546ba507-7024-44d7-a0b4-6c3f13ecbfd7 | A12 review gate | planned | ["c21f41dd-c30e-4969-81d3-251bfdf2d2f2"]
6d5b4083-0106-44ad-86cb-147672cf1e5c | Final artefact gate | planned | ["8f2099d7-f6ca-4b24-81aa-57eef042c755"]
6e781f18-7b29-428b-95c2-633e0546972f | W1 quote-validated evidence | planned | []
aed63e87-4d1d-4ad4-abef-37e765fc570c | W1 evidence review gate | planned | ["6e781f18-7b29-428b-95c2-633e0546972f"]
c21f41dd-c30e-4969-81d3-251bfdf2d2f2 | A12 required non-string leaves | planned | []
cef97a7c-b14a-45d2-a7b5-c4614e8674ea | W1 PR | planned | ["aed63e87-4d1d-4ad4-abef-37e765fc570c"]
d210bf1d-0b7a-4425-98f8-78cbb434258a | A12 PR | planned | ["546ba507-7024-44d7-a0b4-6c3f13ecbfd7"]
51b9285d-4263-416c-bfc9-fdcfc5691244 | QA-world evidence gate | ready | ["cb528d50-3920-4981-a3b7-c3e4e8c3d079"]

== Dependencies pointing outside the live graph ('done' targets dropped; others kept + needs_guidance)
thread_id | dep | dep_lane | dep_archived | dep_deleted
90b1f78e-6a5e-4382-8eb5-f41cb4d171d5 | 9d1afa3a-43e9-4807-9f3a-286313c6d341 | done | 1 | 0
b01305cd-7f08-4498-92da-6c165c58c890 | 10c71f22-6674-491f-b2e6-eefd2980aa66 | done | 1 | 0
be6b0933-1063-4c3e-8ddc-345996de63a4 | 10c71f22-6674-491f-b2e6-eefd2980aa66 | done | 1 | 0

== Routes whose target is outside the live graph (dropped with a warning)
thread_id | route_to
90b1f78e-6a5e-4382-8eb5-f41cb4d171d5 | 9d1afa3a-43e9-4807-9f3a-286313c6d341
b01305cd-7f08-4498-92da-6c165c58c890 | 10c71f22-6674-491f-b2e6-eefd2980aa66
be6b0933-1063-4c3e-8ddc-345996de63a4 | 10c71f22-6674-491f-b2e6-eefd2980aa66

== Relocated project roots (only repos/loom exists; the rest are inert by construction)
project_id | title | workspace_root | auto_pull | deleted
205086d5-f40a-44e5-8d6b-37599ab14b1d | cli-proxy | /home/Carl/.t3/qa-pull9/repos/not-cloned/205086d5-f40a-44e5-8d6b-37599ab14b1d | 0 | 0
2d05e585-447f-4443-9f2e-b7fc518eb928 | holiday | /home/Carl/.t3/qa-pull9/repos/not-cloned/2d05e585-447f-4443-9f2e-b7fc518eb928 | 0 | 0
c2dc6422-153e-44b5-bbcb-64b8fb0fd0ea | lease-extraction | /home/Carl/.t3/qa-pull9/repos/not-cloned/c2dc6422-153e-44b5-bbcb-64b8fb0fd0ea | 0 | 0
de7b4bb4-3b4b-4347-be4f-1115dcf9f11d | loom | /home/Carl/.t3/qa-pull9/repos/loom | 0 | 0
8180bd73-d2fa-453a-8b51-5ad655135eb2 | loom-slack-bridge | /home/Carl/.t3/qa-pull9/repos/not-cloned/8180bd73-d2fa-453a-8b51-5ad655135eb2 | 0 | 0
cd00367d-4fdf-41fe-b541-3534aea0012d | pi-browser | /home/Carl/.t3/qa-pull9/repos/not-cloned/cd00367d-4fdf-41fe-b541-3534aea0012d | 0 | 0
311d8878-413c-4794-9221-7803e1be4a12 | pi-craft | /home/Carl/.t3/qa-pull9/repos/not-cloned/311d8878-413c-4794-9221-7803e1be4a12 | 0 | 0
22d57ce7-3b40-41b3-a2fe-51b3c16e01a8 | pi-fathom | /home/Carl/.t3/qa-pull9/repos/not-cloned/22d57ce7-3b40-41b3-a2fe-51b3c16e01a8 | 0 | 0
43b975bf-1556-4852-8dc3-7621865e22aa | pi-vertex-claude | /home/Carl/.t3/qa-pull9/repos/not-cloned/43b975bf-1556-4852-8dc3-7621865e22aa | 0 | 0
5c18bd1e-5d0c-440d-ac51-6a480202c222 | stitchcall | /home/Carl/.t3/qa-pull9/repos/not-cloned/5c18bd1e-5d0c-440d-ac51-6a480202c222 | 0 | 0
d5974493-0337-44e1-ab7e-3b637decbfc5 | 20260712-215313-7ad5468 | /home/Carl/.t3/qa-pull9/repos/not-cloned/d5974493-0337-44e1-ab7e-3b637decbfc5 | 0 | 1
09d3bd4d-cb9d-4782-b289-60f05ffb8578 | 20260712-221035-7ad5468 | /home/Carl/.t3/qa-pull9/repos/not-cloned/09d3bd4d-cb9d-4782-b289-60f05ffb8578 | 0 | 1
7c9c7715-f3af-4aab-9989-13bd82480c0e | 20260713-000343-eee3f00 | /home/Carl/.t3/qa-pull9/repos/not-cloned/7c9c7715-f3af-4aab-9989-13bd82480c0e | 0 | 1
03a12810-c97a-4589-8412-0bf3b1956681 | pi-frontend | /home/Carl/.t3/qa-pull9/repos/not-cloned/03a12810-c97a-4589-8412-0bf3b1956681 | 0 | 1
b89a6cc9-90a8-48e1-b5ba-a5426d135269 | stit | /home/Carl/.t3/qa-pull9/repos/not-cloned/b89a6cc9-90a8-48e1-b5ba-a5426d135269 | 0 | 1
ab00d214-0301-4f64-a6aa-2a0335b210fb | stitchcall | /home/Carl/.t3/qa-pull9/repos/not-cloned/ab00d214-0301-4f64-a6aa-2a0335b210fb | 0 | 1
871c0e83-ecb1-498d-957d-c38785e6cc7b | stitchcall | /home/Carl/.t3/qa-pull9/repos/not-cloned/871c0e83-ecb1-498d-957d-c38785e6cc7b | 0 | 1
8ccc2b58-50b4-49fc-a06e-808aed83ba13 | stitchcall | /home/Carl/.t3/qa-pull9/repos/not-cloned/8ccc2b58-50b4-49fc-a06e-808aed83ba13 | 0 | 1
39afed3b-a302-40ee-abd6-7d7d7bfd7086 | stitchcall | /home/Carl/.t3/qa-pull9/repos/not-cloned/39afed3b-a302-40ee-abd6-7d7d7bfd7086 | 0 | 1
81bc0fff-053d-4a0a-a134-667bbab2adbc | stitchcall | /home/Carl/.t3/qa-pull9/repos/not-cloned/81bc0fff-053d-4a0a-a134-667bbab2adbc | 0 | 1
6945075c-3476-49cf-95f2-0bc7c4fde4d6 | stitchcall | /home/Carl/.t3/qa-pull9/repos/not-cloned/6945075c-3476-49cf-95f2-0bc7c4fde4d6 | 0 | 1
d452245c-915f-4336-b4df-8a9e2a1fcc57 | stitchcall | /home/Carl/.t3/qa-pull9/repos/not-cloned/d452245c-915f-4336-b4df-8a9e2a1fcc57 | 0 | 1
6668184d-c506-4e90-a2ff-9acaa552ef5f | stitchcall | /home/Carl/.t3/qa-pull9/repos/not-cloned/6668184d-c506-4e90-a2ff-9acaa552ef5f | 0 | 1
87740d38-9e8f-4f87-9354-d5616b957fb3 | stitchcall | /home/Carl/.t3/qa-pull9/repos/not-cloned/87740d38-9e8f-4f87-9354-d5616b957fb3 | 0 | 1
d95ee0e3-8322-40fe-b670-21deb3a6fbe2 | stitchcall | /home/Carl/.t3/qa-pull9/repos/not-cloned/d95ee0e3-8322-40fe-b670-21deb3a6fbe2 | 0 | 1
907cf35f-d400-4500-87c6-8de69b8d8c5a | stitchcall | /home/Carl/.t3/qa-pull9/repos/not-cloned/907cf35f-d400-4500-87c6-8de69b8d8c5a | 0 | 1
ed86fff8-325c-457d-820d-28075df69b88 | stitchcall | /home/Carl/.t3/qa-pull9/repos/not-cloned/ed86fff8-325c-457d-820d-28075df69b88 | 0 | 1
c91309f1-fe2d-49ab-8759-6a973a174940 | stitchcall | /home/Carl/.t3/qa-pull9/repos/not-cloned/c91309f1-fe2d-49ab-8759-6a973a174940 | 0 | 1
1a9df781-4eb3-43f9-8832-8c7a4db9fd58 | stitchcall | /home/Carl/.t3/qa-pull9/repos/not-cloned/1a9df781-4eb3-43f9-8832-8c7a4db9fd58 | 0 | 1
e0ded2d2-2255-4f1b-ae05-95a8c3af0236 | stitchcall | /home/Carl/.t3/qa-pull9/repos/not-cloned/e0ded2d2-2255-4f1b-ae05-95a8c3af0236 | 0 | 1
20f9e2df-db68-4941-98c5-fd43ea99f8da | stitchcall | /home/Carl/.t3/qa-pull9/repos/not-cloned/20f9e2df-db68-4941-98c5-fd43ea99f8da | 0 | 1
ae28c177-03aa-4802-9fb2-4e5ee5ba7f57 | stitchcall | /home/Carl/.t3/qa-pull9/repos/not-cloned/ae28c177-03aa-4802-9fb2-4e5ee5ba7f57 | 0 | 1
65479c87-8a19-4e03-a5e9-01fab2ff1ed4 | stitchcall | /home/Carl/.t3/qa-pull9/repos/not-cloned/65479c87-8a19-4e03-a5e9-01fab2ff1ed4 | 0 | 1
4a13f843-f504-4781-a44a-81a750ebda16 | stitchcall | /home/Carl/.t3/qa-pull9/repos/not-cloned/4a13f843-f504-4781-a44a-81a750ebda16 | 0 | 1
e15d78c7-bb7c-4088-bcee-fae1fd19c66a | stitchcall | /home/Carl/.t3/qa-pull9/repos/not-cloned/e15d78c7-bb7c-4088-bcee-fae1fd19c66a | 0 | 1
0b9db3c1-10c9-4267-9ce8-1d653eae8ffc | stitchcall | /home/Carl/.t3/qa-pull9/repos/not-cloned/0b9db3c1-10c9-4267-9ce8-1d653eae8ffc | 0 | 1
c6eec00c-98e1-4fae-854b-bc4acd242682 | stitchcall | /home/Carl/.t3/qa-pull9/repos/not-cloned/c6eec00c-98e1-4fae-854b-bc4acd242682 | 0 | 1
da51da93-19e7-4850-bb9e-cbb7437e4284 | wor | /home/Carl/.t3/qa-pull9/repos/not-cloned/da51da93-19e7-4850-bb9e-cbb7437e4284 | 0 | 1
```

## Appendix B — `probe.log` (the containment gate; headings and verdicts, full log in `/home/Carl/.t3/qa-pull9/qa/probe.log`)

```text
# probe 2026-10-06T14:44:53Z  qa=/home/Carl/.t3/qa-pull9  sandbox=94bbf00311cbb81b  pi=/home/Carl/.t3/qa-pull9/build/loom/node_modules/.pnpm/@earendil-works+pi-coding-age
#   PrivateUsers=yes
#   NoNewPrivileges=yes
#   PrivateNetwork=yes
#   PrivateTmp=yes
#   TemporaryFileSystem=/run /dev/shm /home/Carl:ro
#   BindPaths=/home/Carl/.t3/qa-pull9
#   BindReadOnlyPaths=-/home/Carl/.n -/home/Carl/.local/share/pnpm -/home/Carl/.cache/node/corepack -/home/Carl/.gitconfig
#   ReadOnlyPaths=-/home/Carl/.t3/qa-pull9/build
#   UnsetEnvironment=DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR
== Production paths do not exist inside (the home is an empty read-only tmpfs + an allow-list of binds)
PASS  touch /home/Carl/.t3/cockpit/.qa-probe-3
PASS  touch /home/Carl/.t3/cockpit/worktrees/.qa-probe-3
PASS  touch /home/Carl/.t3/userdata/.qa-probe-3
PASS  touch /home/Carl/.t3/worktrees/.qa-probe-3
PASS  touch /home/Carl/loom-releases/.qa-probe-3
PASS  touch /home/Carl/loom/.qa-probe-3
PASS  touch /home/Carl/loom/.git/.qa-probe-3
PASS  touch /home/Carl/.pi/agent/sessions/.qa-probe-3
PASS  touch /home/Carl/.pi/agent/.qa-probe-3
PASS  touch /home/Carl/.pi/agent/extensions/.qa-probe-3
PASS  touch /home/Carl/pi-craft/.qa-probe-3
PASS  touch /home/Carl/cli-proxy/.qa-probe-3
PASS  touch /home/Carl/.config/systemd/user/.qa-probe-3
== What is visible outside the QA home is read-only
PASS  touch /home/Carl/.qa-probe-3
PASS  touch /home/Carl/.t3/.qa-probe-3
PASS  touch /home/Carl/.n/.qa-probe-3
PASS  touch /home/Carl/.local/share/pnpm/.qa-probe-3
PASS  touch /home/Carl/.t3/qa-pull9/build/.qa-probe-3
PASS  bash -c ls -A /home/Carl /home/Carl/.t3
== Credentials, production state and host sockets are unreachable
PASS  ls -d /home/Carl/.git-credentials
PASS  ls -d /home/Carl/.config/gh/hosts.yml
PASS  ls -d /home/Carl/.ssh
PASS  ls -d /home/Carl/.config/carl-roobot/config.json
PASS  ls -d /home/Carl/.t3/cockpit/userdata/state.sqlite
PASS  ls -d /home/Carl/.t3/cockpit/userdata/secrets/server-signing-key.bin
PASS  ls -d /home/Carl/cli-proxy/.mgmtkey
PASS  ls -d /home/Carl/cli-proxy/.apikey
PASS  ls -d /run/user/1001/bus
PASS  ls -d /run/docker.sock
PASS  ls -d /var/run/docker.sock
PASS  socat -u /dev/null UNIX-CONNECT:/home/Carl/.pi/agent/intercom/broker.sock
PASS  ls -d /home/Carl/.codex/ipc/ipc.sock
PASS  ls -d /home/Carl/.pi/agent/intercom/broker.sock
PASS  ls -d /var/run/docker/libnetwork/e9947b59449d.sock
PASS  ls -d /var/run/docker/metrics.sock
PASS  ls -d /var/run/etserver.idpasskey.fifo
PASS  ls -d /var/run/postgresql/.s.PGSQL.5433
PASS  ls -d /dev/shm/qa-probe-229bdefd-d3cb-4d0b-8f11-68d5b47e81d1
PASS  systemctl --user status
PASS  sudo -n true
== cliproxy relay forwards inference only: management and everything else refused (403 from the relay)
PASS  bash -c curl -s --path-as-is -X GET -H 'Authorization: Bearer probe-not-a-key'       -w '%{http_code} ' -o /tmp/r 'http://127.0.0.1:8317/v0/management/auth-files' &
PASS  bash -c curl -s --path-as-is -X POST -H 'Authorization: Bearer probe-not-a-key'       -w '%{http_code} ' -o /tmp/r 'http://127.0.0.1:8317/v0/management/auth-files'
PASS  bash -c curl -s --path-as-is -X PUT -H 'Authorization: Bearer probe-not-a-key'       -w '%{http_code} ' -o /tmp/r 'http://127.0.0.1:8317/v0/management/config.yaml'
PASS  bash -c curl -s --path-as-is -X DELETE -H 'Authorization: Bearer probe-not-a-key'       -w '%{http_code} ' -o /tmp/r 'http://127.0.0.1:8317/v0/management/auth-files
PASS  bash -c curl -s --path-as-is -X GET -H 'Authorization: Bearer probe-not-a-key'       -w '%{http_code} ' -o /tmp/r 'http://127.0.0.1:8317/v1/messages' && cat /tmp/r
PASS  bash -c curl -s --path-as-is -X POST -H 'Authorization: Bearer probe-not-a-key'       -w '%{http_code} ' -o /tmp/r 'http://127.0.0.1:8317/v1/messages/../../v0/manag
PASS  bash -c curl -s --path-as-is -X POST -H 'Authorization: Bearer probe-not-a-key'       -w '%{http_code} ' -o /tmp/r 'http://127.0.0.1:8317/v1/%2e%2e/v0/management/au
PASS  bash -c curl -s --path-as-is -X POST -H 'Authorization: Bearer probe-not-a-key'       -w '%{http_code} ' -o /tmp/r 'http://127.0.0.1:8317/v0/management/api-call' &&
PASS  bash -c curl -s --path-as-is -X GET -H 'Authorization: Bearer probe-not-a-key'       -w '%{http_code} ' -o /tmp/r 'http://127.0.0.1:8317/v1/models' && cat /tmp/r
== GitHub: no identity, a dry-run push fails (never succeeds; --dry-run writes nothing even if it authenticated)
PASS  gh auth status
PASS  bash -c printf 'protocol=https\nhost=github.com\n\n' | git credential fill
PASS  git -C /home/Carl/.t3/qa-pull9/repos/loom push --dry-run https://github.com/QuinRiva/loom.git HEAD:refs/heads/qa-probe-never
PASS  bash -c env | grep -iE '^(GH_|GITHUB_|GOOGLE_|AWS_|DBUS_)|TOKEN|SECRET|PASSWORD|API_KEY'
== Network: loopback only; production's ports unreachable
PASS  bash -c ip -o link | cut -c1-60; [ $(ip -o link | wc -l) -eq 1 ] && ip -o link | grep -q '^1: lo:'
PASS  bash -c exec 3<>/dev/tcp/127.0.0.1/9229
PASS  bash -c exec 3<>/dev/tcp/127.0.0.1/13900
PASS  bash -c exec 3<>/dev/tcp/127.0.0.1/13901
PASS  bash -c exec 3<>/dev/tcp/127.0.0.1/13910
PASS  bash -c exec 3<>/dev/tcp/127.0.0.1/5433
PASS  bash -c exec 3<>/dev/tcp/127.0.0.1/6333
PASS  getent hosts github.com
== Own PID namespace: production processes invisible
PASS  bash -c ls /proc | grep -cE '^[0-9]+$'
PASS  kill -0 2438859
== The QA home is writable
PASS  bash -c touch '/home/Carl/.t3/qa-pull9/qa/.probe-229bdefd-d3cb-4d0b-8f11-68d5b47e81d1' && rm '/home/Carl/.t3/qa-pull9/qa/.probe-229bdefd-d3cb-4d0b-8f11-68d5b47e81d1
== pi one-shot with the QA agent dir (cliproxy via the bridge)
PASS  bash -c env | grep -E '^PI_CODING_AGENT_(DIR|SESSION_DIR)='
PASS  node /home/Carl/.t3/qa-pull9/build/loom/node_modules/.pnpm/@earendil-works+pi-coding-agent@1.0.2_patch_hash=b5fbae1e7b915dfe89238f7e6389f6010fc40b_f0d14e28a46f27df1
PASS  bash -c ls /home/Carl/.t3/qa-pull9/pi-sessions/*_229bdefd-d3cb-4d0b-8f11-68d5b47e81d1.jsonl
PASS  node /home/Carl/.t3/qa-pull9/build/loom/node_modules/.pnpm/@earendil-works+pi-coding-agent@1.0.2_patch_hash=b5fbae1e7b915dfe89238f7e6389f6010fc40b_f0d14e28a46f27df1
PASS  bash -c n=$(ls /home/Carl/.t3/qa-pull9/pi-sessions/*_229bdefd-d3cb-4d0b-8f11-68d5b47e81d1.jsonl | wc -l); l=$(wc -l < '/home/Carl/.t3/qa-pull9/pi-sessions/2026-10-0
PASS  jq -r select(.id=="a") | .success
PASS  jq -r select(.id=="b") | .sessionFile
PASS  jq -r select(.id=="d") | .sessionFile
PASS  test /home/Carl/.t3/qa-pull9/pi-sessions/2026-10-06T14-45-48-407Z_01a111ad-8af6-75ef-9a7e-536b8a8208d0.jsonl != /home/Carl/.t3/qa-pull9/pi-sessions/2026-10-06T14-45
== Host side: the relay refuses a management call carrying cliproxy's REAL management key (read here, never given to the unit)
PASS  refused by the relay
== Same sandbox minus PrivateNetwork: the push must fail on authentication
== GitHub: no identity, a dry-run push fails (never succeeds; --dry-run writes nothing even if it authenticated)
PASS  gh auth status
PASS  bash -c printf 'protocol=https\nhost=github.com\n\n' | git credential fill
PASS  git -C /home/Carl/.t3/qa-pull9/repos/loom push --dry-run https://github.com/QuinRiva/loom.git HEAD:refs/heads/qa-probe-never
PASS  bash -c env | grep -iE '^(GH_|GITHUB_|GOOGLE_|AWS_|DBUS_)|TOKEN|SECRET|PASSWORD|API_KEY'
== Host-side checks
PASS  ~/.pi/agent hashes unchanged
PASS  no probe session under ~/.pi/agent/sessions
PROBE PASSED sandbox=94bbf00311cbb81b
```
