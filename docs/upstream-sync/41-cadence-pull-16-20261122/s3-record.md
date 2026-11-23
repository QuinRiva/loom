## S3 record: integration gates (2026-11-23)

Thread `thread:mcp:445922c4-14d1-4f42-ab48-87eeac338861:workstream-scaffold:486cc1dc-2e23-4539-aa73-73c0208036cb:0`.
Decision rows DL-2320 to DL-2330; S2a's rows DL-2230 to DL-2260 and its gate row DL-2269 appended first. Branch `t3/next-upstream-pull`, merge `ce18ce2f04`; merge-base with `origin/main` `7305fc654e`. **`origin/main` has moved since** (`7e349022a8`: #592 and #594, DL-2328); no catch-up merge was made here.

**Node.** The host stayed on 26.12.1 (Carl's card 14 had not been ruled). 26.13.1 was fetched download-only (`N_PREFIX=~/.n n download 26.13.1`) and every command below ran under `n exec 26.13.1`, except the boot of release `6be88bb`, which used 26.12.1 as the cockpit does (DL-2323). Host: pnpm 12.14.0, Vite+ 1.4.0. The host was not quiet: load average 28 to 41 until about 17:00 (other threads and a disk audit), 4 to 20 after.

| Gate | Result |
| --- | --- |
| disk | `/` 308 GB free before the install, 319 GB at the end; `/mnt/fast` 115 GB before the copy |
| fresh install | 44 `node_modules` outside `.repos/` deleted (root, `apps/*`, `packages/*`, `infra/*`, `scripts`, `evals`, `oxlint-plugin-t3code`; three unpacked tarballs under `.artifacts/` left alone); `vp i` 52 s (+1,900 packages from the store), then 1.6 s ("Lockfile is up to date"; the usual `+4` and the `e2e` skill notice, DL-2022); `pnpm-lock.yaml` sha256 `1af88b314e00afdb6b9c7857ec33359ab6fabfc9bb967a0364ea3b79bd336cc5` before, between and after |
| typecheck | `vp run typecheck`: **43/43 packages exit 0**, 0 cache hits, 0 errors (1,071 Effect suggestions), 45 s |
| check | `vp check`: 0 errors, 17 warnings, all upstream's (16 in upstream-identical files, 1 an upstream line of `ProjectionStore.ts`). `vp run knip:check`: one unused export, Loom's orphaned `splitPathAndPosition`, removed (DL-2320); then green |
| build | `pnpm build` 8/8 tasks, 2 min 23 s. The built server on an empty home listens 15.0 s after spawn (9.3 s to the "Listening" line); from source 36 to 70 s at that load, almost all of it module loading |
| sweep | gate vs `7305fc654e`: red on `ProviderOrchestrationAdapterInfrastructure.ts` (an SQL `-- loom:` the gate does not count), marked, clean (DL-2322). `--report` vs `a09738fb43`: clean; one thin file, `packages/shared/src/DrainableWorker.test.ts` (228 lines, 2 markers), as in pulls 14 and 15 |
| lost | `lostdecls.py 7305fc654e a09738fb43`: outside `.repos/`, 187 Loom-side names in 120 files, 178 upstream removals or moves and 9 deliberate drops; 3 upstream-side names, all deliberate; 0 Loom-added names lost; `whatismissing.sh` (refs re-pointed) places each (DL-2327). Against `origin/main` it also lists #592's two names, which this branch does not have yet |
| ledger | `Migrations.ts` byte-identical to `a09738fb43`; 081 to 108 ran on the cockpit copy, `loom_sql_migrations` unchanged (72 rows, max 1072); boot-to-listen 52.0 s cold, 46.3 s warm against the 240 s budget (below) |
| launcher | `launcherSeam.test.ts` at protocol 4: 12/12. Cross-version run with release `6be88bb`'s launcher, adopt and runner as the release being left: 12/12 (DL-2321). `deploy/README.md`'s paragraph rewritten |
| search | fresh empty home: `effect_sql_migrations` 1 to 108, `loom_sql_migrations` 72 rows to 1072, 069, 074 and 081 recorded with 1065, no `orchestration_v2_message_search*` object (node:sqlite), 15 `loom_ts_*` triggers; the same on the migrated copy |
| `UPSTREAM_BASE` | `a09738fb435120d08707db0142ca55b3b7b5c7ec` |
| tests: `apps/server` | 653 files / 10,459 tests: **10,440 pass, 16 skipped, 3 fail**, 53 min at load 30+ (S2a's run took 8.5 min). The three: `GitManager.test.ts` "stages the worktree once…" passes with `LOOM_THREAD_ID` unset; `AntigravityInstallation.test.ts` "…16 KiB kernel" fails identically on a clean `a09738fb43` worktree on this host; `ClaudeAdapterV2.test.ts` "persists a todo_list…" hit its 60 s timeout and passes alone, 479/479 (DL-2326). 1066's test passes on 26.13.1 |
| tests: packages | shared 119 / 2,046 (2,041 pass, 5 skipped) · contracts 34 / 233 · provider-core 23 / 294 · provider-pi 15 / 270 · client-runtime 196 / 2,470 · `@t3tools/scripts` 45 / 330 (329 pass, 1 skipped): all pass. S2a's `build-npm-launcher.test.ts` failure did not recur |
| tests: `apps/web` | unit + browser (Chromium) 700 files / 8,062 tests: **8,053 pass, 9 fail in 5 files**, 7 min: `browserHistoryStore` ×4, `RightPanelTabs` IME rename, `CloudVoiceConfiguration` ×2, `ScheduledTasksSettings`, `DocumentViewerApp` phone width; eight 15 s timeouts and one 1 s `waitFor`. The 5 files alone: 36/36 (DL-2326) |
| tests: `apps/mobile` | unit + react 333 files / 3,775 tests: all pass |

### The cockpit copy (DL-2324, DL-2325, DL-2329, DL-2330)

`sqlite3 -readonly … "VACUUM INTO '/mnt/fast/pull16/…'"` of the live database (4,981,944,320 B, WAL 33,227,832 B) in 3 min 11 s: 4,857,405,440 B, page size 4,096, 0 free pages, `effect_sql_migrations` 80 / max 80, `loom_sql_migrations` 72 / max 1072. The boot home held a copy of it, the cockpit's `keybindings.json` and its `settings.json` without `projectAutoPullOverrides` and `guestSharingEnabled`; no `secrets`. Every boot: `env -i HOME PATH T3CODE_NO_BROWSER=1 node <server> serve --base-dir <home> --port 13987`, the PID captured at spawn and stopped with SIGTERM. The foreign-home guard engaged on every boot (755 recorded worktree paths), so the first boot's nine liveness resumes and its restart continuations were refused. Boot-to-listen is spawn to the first HTTP 200 on `/.well-known/t3/environment`. The copies (9.4 GB in all) and the directory were deleted at the end.

| Measure | Result |
| --- | --- |
| first boot, cold (copy evicted from the page cache) | **52.0 s**; first migration at 5.5 s, "Migrations ran successfully" at 44.6 s (39.1 s), "Listening" 49.2 s |
| first boot, warm (a fresh copy, cached) | **46.3 s**; first migration at 15.6 s (12.4 s loading the bundle at load 38), migrations 27.2 s, "Listening" 44.0 s |
| later boots of the migrated copy | 5.3 s, 7.4 s |
| per migration, s (cold / warm) | 081 11.25 / 1.09 · **082 16.93 / 15.70** · 083 2.19 / 1.34 · 084 0.06 / 0.03 · 085 0.19 / 0.22 · 086 0.73 / 0.81 · 087 0.02 / 0.01 · 088 1.29 / 1.38 · 089 0.10 / 0.07 · 090 0.01 / 0.01 · 091 0.00 / 0.00 · 092 0.57 / 0.65 · 093 0.05 / 0.02 · 094 0.95 / 1.01 · 095 3.28 / 3.40 · 096 0.02 / 0.03 · 097 0.00 / 0.00 · 098 0.14 / 0.12 · 099 0.48 / 0.57 · 100 0.25 / 0.22 · 101 0.21 / 0.22 · 102 0.04 / 0.03 · 103 to 106 ≤ 0.03 · 107 0.25 / 0.25 · 108 0.00 / 0.00 |
| file and WAL | 4,857,405,440 B, no WAL → **5,015,470,080 B** (+158 MB) after the first boot, no WAL after a clean stop; 5,012,979,712 B after the warm first boot; page count 1,185,890 → 1,224,480 |
| `turn_item_counts` | 14,958 rows, `SUM(item_count)` 524,965 = the 524,965 turn items; `thread_item_counts` 7,484 rows, same sum |
| `inline_work_output = 1` | 51 (S0: 49; the copy has 51 items matching 095's patterns) |
| `search_text` | 590 of 166,132 messages (S0: at most 546 of 165,442; the copy has 600 with a citation link, 10 of which read the same) |
| previous release `6be88bb` on the migrated copy | listens in **14.4 s**; one warning naming 081 to 108 "unknown to this build"; trimmed shell 2.3 s, 4.01 MB, 662 threads; ignores the new build's `mod+f` → `preview.find` key binding with a warning |
| first trimmed shell read after listening (third boot) | **1.68 s**, 4.05 MB, 662 threads; then 1.35 s, 1.20 s (pull 15: 2.6 s, 2.83 MB, 474) |
| full shell read | 5.84 s, 24.8 MB, 5,330 threads (pull 15: 5.1 s, 18.8 MB, 4,258) |
| reconnect | `resumeFrom=<snapshotSequence>` answers `{"resumable":true}`, 18 bytes, 32 ms |
| `listActiveShellIndex` plan | `SCAN t USING INDEX orchestration_v2_projection_threads_active_shell_idx`; Loom's join a `SEARCH` on `loom_thread_workstream`'s key; each live-source list through its partial index; 5,330 rows in 32 ms |

### Fixed here

- `apps/web/src/terminal-links.ts`: Loom's `splitPathAndPosition` deleted; DL-2284 had moved its only caller (DL-2320, `4b05aaec5c`).
- `launcherSeam.test.ts` at protocol 4 and `deploy/README.md`'s "A launcher protocol change" rewritten (DL-2321, `61469594b4`).
- `ProviderOrchestrationAdapterInfrastructure.ts`: DL-2237's hunk marked with `// loom:` (DL-2322, `7f7672d627`).

### For Gate 2's fixes and S4

- `origin/main` is two Loom PRs ahead (#592, which edits `unanchoredFileReferences` on web and mobile, and #594); a catch-up merge is due before the ship (DL-2328).
- Re-run the web browser project and, ideally, the server suite on a quiet host before shipping: every red here was a timeout under load or an environment test, but the proof is one quiet green run (DL-2326).
- The first boot of the copy resumed nine errored threads and started restart continuations, all refused by the foreign-home guard; on the cockpit itself those run for real at the deploy, as on any boot.
- A copy boot holds a `systemd-inhibit` sleep lock on the host while it runs (upstream's keep-awake).
- S4 on a cockpit copy: `migrate-dev-db` or another `VACUUM INTO`; the scripts used here (boot timer, shell reader, measurements) were scratch in `.artifacts/pull16-s3/`.

### Final run on `fa5b764c79` (2026-11-23, 20:00 to 21:25)

Thread `thread:mcp:445922c4-14d1-4f42-ab48-87eeac338861:workstream-spawn:99985213-dddc-47ac-8fb2-f12d810ab32c`. One sequential script from `vp i` to the mobile suite on the branch tip `fa5b764c79`; `feec784519` (DL-2414, DL-2415: `decision-log.md` and `deploy.md` only) landed during it and changes nothing the run covers. `origin/main` still `7e349022a8`. `LOOM_THREAD_ID` unset throughout. Node: the script ran every step under `N_PREFIX=~/.n n exec 26.13.1`; the host itself moved to 26.13.1 at 20:24:52 (DL-2414), mid server suite, and the re-runs after 21:02 used the host's 26.13.1 directly. The host was quiet (load 1 to 5) until the web suite, which drives the load to 12 to 19 by itself; from about 21:20 other threads were busy too (load 12 to 15 without this run).

| Command | Result | Load (1 min) |
| --- | --- | --- |
| `vp i` twice | the usual `+4` and `e2e` notice, then "Done in 1.3s"; `pnpm-lock.yaml` sha256 `1af88b31…6cc5` before, between and after (the S3 value) | 2 to 3 |
| `vp run typecheck` | 43/43 exit 0, 0 errors (36 cache hits); re-run without `--cache`: 43/43, 0 errors | 3 to 7 |
| `vp check` | 0 errors, 17 warnings (the S3 set) | 7 |
| `vp run knip:check` | green | 7 |
| `pnpm build` | 8/8, 34 s | 6 to 7 |
| `unmarkedsweep.sh` | clean vs `7e349022a8` | 4 to 6 |
| `unmarkedsweep.sh --report` | clean vs `a09738fb43`; the one thin file, `DrainableWorker.test.ts` | 3 |
| `apps/server` `vp test run` | 653 files / 10,461 tests: 10,444 pass, 16 skipped, **1 fail**, 48 min (the suite runs files one at a time). The fail is the tolerated `AntigravityInstallation.test.ts` "…16 KiB kernel" (DL-2326); `GitManager.test.ts` passes with `LOOM_THREAD_ID` unset | 1 to 5 |
| shared · contracts · provider-core · provider-pi · client-runtime · `@t3tools/scripts` | 119 / 2,046 (2,041 pass, 5 skipped) · 34 / 233 · 23 / 294 · 15 / 270 · 196 / 2,473 · 45 / 330 (329 pass, 1 skipped): all pass | 2 to 8 |
| `apps/web` unit + browser | 701 files / 8,066 tests: **8,059 pass, 7 fail in 6 files**, 6 min 23 s: `browserHistoryStore` ×2, `ChatView` "/side sends the draft's attachments…", `PullRequestCodeTab` "keeps a later test file folded…", `ProviderModelPicker` "keeps each registry image…" (15 s timeouts), `DocumentViewerApp` "draws a real plan at phone width…" and `DocumentViewerApp.network` "draws a document without a single network request…" (both a 1 s `vi.waitFor` for the document's `rendered` message) | 7 to 19 |
| `apps/mobile` unit + react | 333 / 3,775: all pass | 6 to 15 |

**The web failures, checked.** The six files alone at load 2.4: 6 files / 56 tests, all pass. A second full web run (load 12 to 19): 6 fail in 3 files, `browserHistoryStore` ×4 and the same two `DocumentViewerApp` tests. A third with `--maxWorkers=6` (load 7 to 18, others busy): 3 fail, two `Sidebar.browser.test.tsx` tests and `DocumentViewerApp.network`; `Sidebar`, `DocumentViewerApp.network` and `browserHistoryStore` alone at load 12: 3 files / 21 tests, all pass. A full web run on Loom's `main` (`7e349022a8`, a scratch worktree, load up to 19.7) fails both `DocumentViewerApp` tests the same way (the document reports only `ready` within 1 s), so those two predate the pull: the files are unchanged since `main`, and their 1 s wait is too short for a full plan's first render when the suite loads the host. `browserHistoryStore.browser.test.ts` and its store are byte-identical to upstream `a09738fb43`. Every other red was a different test in each run. No failure points at a commit since the full-gates run; nothing was fixed here. The two test-side causes are follow-up 53.
