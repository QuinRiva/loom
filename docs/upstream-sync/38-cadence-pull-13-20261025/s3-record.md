## S3 record: integration gates (2026-10-26)

Thread `thread:mcp:34c1df08-49b4-4bf6-9a00-2e4b4c12b4f7:workstream-scaffold:c4f60fc3-206e-400b-b409-4d98c5b51a04:3`.
Decision rows DL-1500–DL-1509. Host: Node 26.12.1, pnpm 12.14.0, Vite+ 1.4.0 (DL-1509).

| Gate | Result |
| --- | --- |
| fresh install | Every `node_modules` (root, `apps/*`, `packages/*`, `infra/*`, `scripts`, `oxlint-plugin-t3code`) deleted; `vp i` with the release's `vp` 1.0.0 53 s, then `vp i` with the installed 1.4.0 1 s; `pnpm-lock.yaml` sha256 `47869850…` unchanged by both |
| typecheck | `vp run typecheck`: 34/34 tasks, exit 0 (35 s, no cache) |
| check | `vp check`: 0 errors, 428 warnings, after DL-1501 |
| sweep | gate vs `7935f6a1ec` clean; `--report` vs `b76a110aa4` clean, two "marked but thin" files (DL-1504) |
| lost | `lostdecls.py 7935f6a1ec b76a110aa4`: 283 files, 0 upstream-side names lost, every Loom-side name adjudicated (DL-1504) |
| ledger | 065–069 and exactly `1063_ThreadSearchTextGuard` (renumbered **1064** after `origin/main`'s 1063 `LoomThreadDocumentQuery` by the catch-up merge, so the deployed build runs 1063 + 1064 where main's 1063 has not run: DL-1533); ledgers 69 / 1063; 069 31,898 rows; Loom history 33,696 rows / 3,874 threads unchanged; both trigger families fire; `quick_check` ok (DL-1505); `doctor --fix` rebuilds both indexes, but refuses on the cockpit's data as it stands (DL-1506) |
| `UPSTREAM_BASE` | `b76a110aa4cf011345ec9d63d37c2dcdf4b751ad`; `git merge-tree` of the merge's parents (`20b1d6f162` × `b76a110aa4`) gives the same 173 conflicted paths; the 144 silently merged files equal Appendix C exactly; Gate 2 zones in `clean-overlap-zones.md` |
| tests: `apps/server` | 511 files / 5,580 tests: all pass, 4 skipped (second full run, after DL-1502; first run 3 files red: DL-1502, DL-1503) |
| tests: packages | shared 97 / 1,126 (+2 skipped) · contracts 31 / 178 · provider-core 18 / 143 · provider-pi 15 / 153 · client-runtime 141 / 1,407: all pass |
| tests: `apps/web` | unit 335 files / 4,546 tests; browser (Chromium 148) 65 files / 223 tests: all pass in per-project runs; the combined first run had one flake (DL-1503) |
| tests: `apps/mobile` | 210 files / 2,662 tests: all pass |

### Timing on the cockpit copy (DL-1505, DL-1507)

| Measure | merged build |
| --- | --- |
| spawn → `Listening`, first boot (065–069, 1063) | 17.2 s |
| spawn → `Listening`, warm boot | 11.2 s |
| per migration on an identical copy | 066 0.82 s, 069 5.24 s, the rest ≤ 0.25 s |
| first shell read after listening (cold) | 12.6 s (pull 12: 12.4–14.5 s) |
| shell snapshot (15.2 MB, 3,413 threads), during the online compaction | median 1.19–1.25 s, p95 ≤ 2.2 s, max 4.0 s |
| full thread read, largest thread / this pull's root | 0.12–0.13 s / 0.05 s |
| first online compaction pass | > 70 min on the fresh copy (stopped unfinished); 5.5 min after `doctor --fix` |
| `doctor --fix` (6.3 GB) | 271 s, Loom index rebuild 30 s of it |

Pull 12's ≈ 8 minutes of slow reads during the first compaction (DL-1295) is gone: upstream now throttles the pass to a 10 % duty cycle, so it takes longer and costs no read latency.

### For Gate 2 and S4

- `origin/main` is at `ab9ff5c6b2` (#440); `dispatcher/rails.ts` conflicts with this branch, so a catch-up merge comes before ship (DL-1508).
- Eleven cockpit threads hold a retired `human-message` control item: each loses that one message from its timeline, and `t3 doctor --fix` refuses on the live database until the follow-up lands (DL-1506). Pre-existing since 23 Oct.
- `scripts/dev-runner.ts` changed in S3 (DL-1500): Gate 2d reads it; S4's dev-verify instance seeds into `.t3/dev-instances/<port>`.
- Flaky under load: `VcsStatusBroadcaster.test` and `TelemetryExportSettings.browser.test` (DL-1503).
