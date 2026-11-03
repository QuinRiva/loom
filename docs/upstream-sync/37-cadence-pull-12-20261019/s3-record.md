## S3 record — integration gates (2026-10-19)

Thread `thread:mcp:5b96cd49-a5b7-4d9a-a689-3194085c8630:workstream-scaffold:e5c48d8a-c119-42e1-9f8d-323cf0560dfd:2`.
Decision rows DL-1290–DL-1299.

| Gate | Result |
| --- | --- |
| fresh install | Every `node_modules` (root, `apps/*`, `packages/*`, `infra/*`, `scripts`, `oxlint-plugin-t3code`) deleted; `vp i` 1 m 18 s, exit 0; a second `vp i` exit 0; `pnpm-lock.yaml` unchanged by both (sha256) |
| typecheck | `vp run typecheck`: 32/32 packages, exit 0 |
| check | `vp check`: 0 errors (400 warnings), after DL-1294 |
| sweep | `unmarkedsweep.sh` gate vs `origin/main` `02a2297b61`: clean. `--report` whole fork vs `07d38b8d17`: clean (three "marked but thin" files) |
| lost | `lostdecls.py origin/main 07d38b8d17`: 32 files, 0 upstream-side names lost; every Loom-side name matched to a row (DL-1298) |
| ledger | `Migrations.ts` byte-identical to `07d38b8d17`; `LoomMigrations` + `v1copy` 26/26; cockpit-copy boot ran 063, 064 and exactly 1060, emptied `sqlite_stat1` (DL-1297) |
| tests: `apps/server` | 537 files / 7,235 tests: 533 files pass, 4 skipped; 7,214 tests pass, 21 skipped, after DL-1291 (one upstream Claude test). `preview/ServerBrowserPage.test.ts` 21/21 with Chromium present (DL-975 closed) |
| tests: packages | shared 102 files / 1,767 (+1 skipped) · contracts 41 / 698 · provider-core 22 / 222 · provider-pi 16 / 173 after DL-1290 · client-runtime 144 / 2,277: all pass |
| tests: `apps/web` | unit 427 files / 7,576 tests, after DL-1292; browser 135 files / 1,003 tests, after DL-1293 (134 in one run with `AttachmentFilePreview` excluded, that file 3/3 alone ×3). The combined `vp run test` is flaky under host load: 3–8 tests that pass alone, and twice an aborted run (DL-1296) |
| tests: `apps/mobile` | 286 files (2 skipped) / 3,362 tests (5 skipped): all pass |

### Timing comparison (Carl's row 4 gate)

Method: one `sqlite3 -readonly … "VACUUM INTO"` copy of `~/.t3/cockpit/userdata/statev2.sqlite`
(11.4 GB; 5,198 threads; 2,377,191 events), copied once per server so both start from the same
bytes, with the cockpit's `settings.json` and `keybindings.json`. `origin/main` `02a2297b61` ran
from a scratch `git worktree` in `/tmp`; the merged tree ran from this worktree. Each server was
started with `env -i HOME PATH LANG` (no `PI_*`/`T3_*`), `serve --base-dir <scratch home>`, and
stopped by its captured PID. After a first boot (migrations, recovery), each later boot measured
spawn → `Listening`, the first shell read, then, after 45 s, 6–15 reads each of
`/api/orchestration/shell` (1.4 MB) and the full and bounded thread reads of the largest thread
(`b6710819…`, 784 turn items) and a workstream root (`d02ca6da…`). Runs were interleaved
`origin/main` / merged. A 5-minute timeline (one shell read and one thread read per second)
followed, because the merged server's spread pointed at background work.

| Measure | `origin/main` | merged |
| --- | --- | --- |
| spawn → `Listening` (warm boots) | 6.6–7.8 s | 6.8–7.1 s |
| first boot on the copy (merged runs 063/064/1060) | ≈ 8.7 s | 11.1 s |
| first shell read after listening (cold) | 13.5–18.1 s | 12.4–14.5 s |
| shell snapshot, steady state (median) | 1.03–1.09 s | 1.05–1.10 s |
| full thread read, largest thread (median) | 0.15 s | 0.15 s |
| shell snapshot during the first history compaction (60–515 s after the first boot) | — | 3.1–5.0 s (2-min means; max 7.8 s) |
| event-loop p95 / max during it | 35–47 ms / ≤ 0.4 s | up to 668 ms / 2.2 s |
| later compaction passes (each boot +1 min, every 6 h) | — | ≈ 20 s bump: shell mean 1.8 s, max 3.5 s |

Findings:

- **Dropping planner statistics (#21122) is not a regression on these reads.** A merged build
  with pre-merge `PRAGMA optimize` and its stats kept showed the same slowdown during
  compaction. After compaction the merged server matched `origin/main` on every read.
- **The regression is upstream's online history compaction** (`DatabaseStorage.ts`, #19435). One
  minute after each boot, then every 6 hours, it walks `orchestration_events` and
  `orchestration_command_receipts` in pages of 50 and deletes superseded rows on the writer
  connection, which runs synchronously on the main thread. A CPU profile of the merged server put
  98 s of a 125 s window in that statement. On the cockpit copy, the first pass ran for ≈ 7.5 min
  (60–515 s) and deleted 1,604,529 events and 1,820,120 receipts. During it the UI's reads were
  3–5× slower, and one shell read on a partly compacted copy took 74 s.
- **The freed 6.5 GB stays in the file.** The cockpit DB has `auto_vacuum = 0`, so the
  per-minute `reclaim` does nothing. `t3 doctor --fix` (dry run: "Reclaim database space")
  would `VACUUM` offline.
- **Options for Gate 2 / Carl:**
  - (a) Accept: about 8 minutes of sluggish UI after the first deploy, then parity.
  - (b) Before the deploy, compact offline on the stopped cockpit (`t3 doctor --fix`, which also
    reclaims the space). Its run time on 11 GB was not measured.
  - (c) A Loom change to throttle or defer the pass. That is new fork surface in a file upstream
    iterates on.
