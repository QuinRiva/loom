## S3 record: integration gates (2026-11-02)

Thread `thread:mcp:54c7fda3-ec09-4f4e-a6f2-14730a0be3b8:workstream-scaffold:625806ab-e8b8-4c53-89f7-549063802672:4`.
Decision rows DL-1690–DL-1699. Host: Node 26.12.1, pnpm 12.14.0, Vite+ 1.4.0. `origin/main` had not moved (`fe75bb6833`), so no catch-up merge.

| Gate | Result |
| --- | --- |
| fresh install | All 39 `node_modules` (root, `apps/*`, `packages/*`, `infra/*`, `scripts`, `oxlint-plugin-t3code`) deleted; `vp i` with the release's `vp` 1.4.0 28.7 s, then the installed 1.4.0 in 1 s ("Lockfile is up to date"); `pnpm-lock.yaml` sha256 `583fee0b2285f554343e49583b21226e79cda4479bc5e6d49eeb88ee13ecf164` before and after (DL-1690) |
| typecheck | `vp run typecheck`: 39/39 tasks, exit 0 (38 s, no cache); exit 0 again after S3's fixes |
| check | `vp check`: 0 errors, 4 warnings, all in upstream files (DL-1690); `vp run knip:check` green after DL-1692 |
| sweep | gate vs `fe75bb6833` clean; `--report` vs `fa31b66bbb` clean, one thin file (DL-1698) |
| lost | `lostdecls.py origin/main fa31b66bbb`: 712 Loom-side names (708 upstream removals, 4 Loom-added, all in DL rows), 3 upstream-side names (DL-1610, §6.7); no consumer (DL-1698) |
| ledger | 070–076 ran, `loom_sql_migrations` unchanged (max 1066); 074 early-returned; `Migrations.ts` byte-identical to `fa31b66bbb`; history 33,696 rows / 3,874 threads unchanged; fresh home leaves no `orchestration_v2_message_search*` object (DL-1697) |
| `UPSTREAM_BASE` | `fa31b66bbb2ae5234205a8628a78e038d917202f`; `git merge-tree` of `7761af6555` × `fa31b66bbb` gives the same 123 conflicted paths as Appendix B and exactly Appendix C's 180 silent files; Gate 2 zones in `clean-overlap-zones.md` (DL-1699) |
| tests: `apps/server` | 546 files / 6,826 tests pass, 5 skipped (second full run; the first had 15 reds in 11 files, DL-1691, DL-1693) |
| tests: packages | shared 101 / 1,354 (+3 skipped) · contracts 31 / 181 · provider-core 21 / 197 · provider-pi 15 / 172 · client-runtime 151 / 1,629 · scripts 35 / 254 (after DL-1707): all pass |
| tests: `apps/web` | unit 383 files / 5,301 tests, all pass, no unhandled error after DL-1696; browser (Chromium) 166 files / 724 tests: 720 pass; red: `ChatView.browser.test` draft case and `GuestPage.browser.test` socket case (open, DL-1694), plus two load flakes that pass alone (`OpenInPicker`, `fileEditorDismissal`) |
| tests: `apps/mobile` | 269 files / 3,193 tests: all pass (17 reds in one file in the first run, DL-1694) |

### Timing on the cockpit copy (DL-1697)

| Measure | merged build |
| --- | --- |
| `VACUUM INTO` of the live database (6.73 GB) | 24 s |
| spawn → `Listening`, first boot (070–076) | 10.7 s |
| spawn → `Listening`, warm boot | 5.0 s, 5.7 s |
| per migration on an identical copy | 072 0.26 s, 073 0.66 s, 070/071/074/075/076 ≤ 0.004 s each |
| first full shell read after listening (warm boot) | 10.2 s, 16.4 MB, 3,784 threads (pull 13: 12.6 s, 15.2 MB, 3,413 threads) |
| first trimmed shell read after listening (the cold-connect path, §4) | 5.2 s, 2.0 MB, 325 threads; repeated reads 2.0–2.5 s |
| `listActiveShellIndex` SQL, 3,784 rows, with / without the Loom join | 57 ms / 52 ms median (9 runs each); fallback not warranted |
| `loom_keep` rows vs the sidecar query | 503 = 503 |
| first online compaction pass | still running at 116 min (170,959 events deleted), stopped; history rows unchanged |
| fresh empty home: spawn → `Listening` | 14.1 s |

### For Gate 2 and S4

- Zone lists for the four reviewers are in `clean-overlap-zones.md`, each file with its `loom:` count and the DL rows that name it.
- Gate 2a: upstream #27221 now releases held agent and scheduled messages once a run completes (DL-1699); a Loom wake held by restart recovery is delivered at the next completed run.
- Gate 2c / S4: plan code blocks highlight again through upstream's highlighter (DL-1696): open an MDX plan with a code block in `/preview` and check it is coloured on both themes. The guest timeline's model divider shows slugs (DL-1695).
- Open reds, tracked as goal tasks: `ChatView.browser.test` (Loom's app never lists the fake environment's project) and `GuestPage.browser.test` (a second Loom read still opens a socket on the guest page, about one run in three).
- S4 (from S2b): the `HtmlBlock` artefact frame stands at 360 px with empty space below its cards; compare with `origin/main`.
