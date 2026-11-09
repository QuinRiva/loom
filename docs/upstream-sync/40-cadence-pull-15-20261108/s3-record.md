## S3 record: integration gates (2026-11-09)

Thread `thread:mcp:3036341c-9850-44b1-899a-19e68df893ad:workstream-scaffold:278da6ed-2383-4add-bb06-88d7c678f5c9:0`.
Decision rows DL-1891–DL-1899 (DL-1890 is the reverted tsgo patch). Host: Node 26.12.1, pnpm 12.14.0, Vite+ 1.4.0, glibc 2.31. `origin/main` had not moved (`ce1bdbcd96`), so no catch-up merge.

| Gate | Result |
| --- | --- |
| fresh install | All 41 `node_modules` outside `.repos/` deleted (root, `apps/*`, `packages/*`, `infra/*`, `scripts`, `evals`, `oxlint-plugin-t3code`; `.repos/`'s 9 tracked fixture `node_modules` left alone); `vp i` 32 s, then 0.9 s ("Lockfile is up to date"); `pnpm-lock.yaml` sha256 `7abc714dd448cd6572fb5f793c9ae40355e027a6a577fe1d8fe47137e997ae76` before and after; the reverted tsgo patch is gone from `node_modules/@effect/tsgo` |
| typecheck | **`vp run typecheck` cannot run on this host and is still owed after the host upgrade** (tsrs needs glibc ≥ 2.34; DL-1926; the ship gate runs it). Observed instead with `effect-tsgo tsc --noEmit` in each of the 40 packages the root script covers (`astro check` for marketing), stale `tsconfig.tsbuildinfo` files deleted first: **exit 0 and 0 errors in all 40** (table below); exit 0 again in `apps/server`, `packages/provider-core` and `packages/provider-pi` after S3's fixes (DL-1899) |
| check | `vp check`: 0 errors, 4 warnings, all in upstream-identical files (`T3ChatAccounts.test.ts`, `markdownWindowsPaths.ts` ×2, `AntigravityAcpSupport.test.ts`); `vp run knip:check` green after `provider-kiro` joined the unregistered-driver ignores in `knip.jsonc` (DL-1816 dropped its import) |
| build | `pnpm build` 7/7 tasks, 51 s, no cache; `apps/server/dist/bin.mjs serve` on an empty home listened 7.1 s after spawn and served `/` and `/.well-known/t3/environment` (200) |
| sweep | gate vs `ce1bdbcd96` clean; `--report` vs `3fa57b92a2`: `evals/README.md` (Loom's `explainer-density` row) now marked; one thin file as in pull 14 (DL-1896) |
| lost | `lostdecls.py origin/main 3fa57b92a2`: outside `.repos/`, 101 Loom-side names in 53 files, all upstream removals or moves (§6.5 (a)'s 19 among them), 0 Loom-added names lost; 3 upstream-side names, pull 14's same three; `whatismissing.sh` (refs re-pointed) places each (DL-1897) |
| ledger | `Migrations.ts` byte-identical to `3fa57b92a2`; 077–080 ran on the cockpit copy, `loom_sql_migrations` unchanged (69 rows, max 1069); the Loom history guard held through a forced due pass (below; DL-1898) |
| search | fresh empty home: `effect_sql_migrations` 1–80 and `loom_sql_migrations` 1001–1069 (69 rows) ran, 069/074/1065 recorded, no `orchestration_v2_message_search*` object (node:sqlite), 15 `loom_ts_*` triggers |
| `UPSTREAM_BASE` | `3fa57b92a238cdd8e079af925b673b2f99618b98`. `git merge-tree` of the merge's parents (`bc726f4d27` × `3fa57b92a2`) gives Appendix B's 74 conflicted paths and exactly Appendix C's 187 silent files; Gate 2 zones in `clean-overlap-zones.md` |
| tests: `apps/server` | **581 files / 7,675 tests pass, 5 skipped** (second full run). The first run had 12 reds in 4 files, all Loom-caused, all fixed: `AntigravityProvider.test.ts` (DL-1891), `deferredImports.test.ts` (DL-1892), `runtimeLayer.test.ts` 9 (DL-1893), `DelegatedCompletionDelivery.test.ts` 2 (DL-1894). The Antigravity and DelegatedCompletionDelivery cases were checked on a throwaway `3fa57b92a2` worktree, where they pass |
| tests: packages | shared 106 / 1,603 (1,600 pass, 3 skipped) · contracts 32 / 189 · provider-core 22 / 227 (one new Loom case, DL-1891) · provider-pi 15 / 199 after DL-1895 (one red before: Loom's background-job pin) · client-runtime 158 / 1,848 · `@t3tools/scripts` 37 / 270: all pass |
| tests: `apps/web` | unit 394 files / 5,465 tests: all pass. Browser (Chromium) 185 files / 867 tests: every full run had 1–3 reds, a different 15 s-timeout test each time (run 1: `AttachmentFilePreview` Mermaid, `useChatShortcuts` side-chat chords, `CloudVoiceConfiguration`; run 2: `AddEnvironmentDialog`; run 3: `OpenInPicker`), each passing alone; recorded as load flakes on the shared host (DL-1899) |
| tests: `apps/mobile` | 284 files / 3,319 tests, plus the Android `FilePreviewModal` run 1 / 3: all pass |

### Typecheck by package (`effect-tsgo tsc --noEmit`, exit code / error lines)

All 0 / 0: `apps/server`, `apps/web`, `apps/desktop`, `apps/mobile`, `apps/marketing` (`astro check`), `evals`, `scripts`, `oxlint-plugin-t3code`, `infra/relay`, `infra/task-cache`, and `packages/` `client-runtime`, `contracts`, `effect-acp`, `effect-codex-app-server`, `provider-acp`, `provider-acp-registry`, `provider-core`, `provider-cursor`, `provider-fx`, `provider-grok`, `provider-kiro`, `provider-muse`, `provider-opencode`, `provider-pi`, `provider-testing`, `secret-provider-core`, `secret-provider-definitions`, `secret-provider-onepassword`, `shared`, `source-control-azure-devops`, `source-control-bitbucket`, `source-control-core`, `source-control-definitions`, `source-control-forgejo`, `source-control-gitcafe`, `source-control-github`, `source-control-gitlab`, `source-control-testing`, `ssh`, `tailscale`. Whole sweep 65 s at concurrency 4.

### The cockpit copy (DL-1898)

`sqlite3 -readonly … VACUUM INTO` of the live database into this worktree's gitignored `.t3/s3-copy/userdata/`, with the cockpit's `settings.json` and `keybindings.json` (no `secrets`); `env -i HOME PATH T3CODE_NO_BROWSER=1 node apps/server/src/bin.ts serve --base-dir … --port 13987`; the foreign-home guard engaged on every boot (683 recorded worktree paths outside the copy's home), so restart continuations and provider starts were refused; each boot stopped by its PID; the copy deleted afterwards.

**Loom history rows** (`aggregate_kind = 'thread'` and `event_type` in `LOOM_HISTORY_EVENT_TYPES`):

| Moment | V1 | V2 | total | events in the log |
| --- | ---: | ---: | ---: | ---: |
| copy, before any boot | 33,696 | 8,224 | 41,920 | 1,459,129 |
| after the first pass (a minute after boot 1) | 33,696 | 8,224 | 41,920 | 1,459,197 |
| after the forced due pass (boot 2) | 33,696 | 8,230 | 41,926 | 68,022 |

S0's 41,855 (8,159 V2) was measured a day earlier; the live log has grown since. The six extra V2 rows after boot 2 are the copy's own boots writing events (the head moved from 3,643,233 to 3,643,351); no history row was deleted at any point.

| Measure | merged build |
| --- | --- |
| `VACUUM INTO` of the live database (6.78 GB) | 32 s |
| spawn → `Listening`, first boot (077–080) | 8.0 s; "Migrations ran successfully" (077–080) 5.5 s after spawn, 2.7 s after the first log line |
| spawn → `Listening`, warm boots | 4.3 s, 4.4 s |
| 077 / 078 | 077 matches 0 rows on the live database; `idx_orch_events_correlation_id` present live, gone on the copy after boot 1 |
| first prune pass (no mark yet: writes the mark, runs the legacy pass) | 13.3 s; 0 events and 0 receipts deleted (no "Compacted" line) |
| forced due pass (mark's `updated_at` backdated a day, `compacted-at` removed, re-boot) | **23 min 31 s** at the 10 % duty cycle (12:17:19 → 12:40:51); `deletedEventCount` **1,391,225**, `deletedReceiptCount` 0, `reclaimableBytes` 3,453,214,720. The full server test suite ran beside it from minute 8, so this is an upper bound |
| responsiveness during the forced pass | event-loop p99 22–120 ms per one-minute sample, max 0.6 s; trimmed shell reads at its start 0.37–0.49 s |
| first trimmed shell read after listening (warm boot after the pass, the cold-connect path) | **2.6 s**, 2.83 MB, 474 threads; repeated reads 1.1–1.2 s with the server suite running (pull 14: 5.2 s, 2.0 MB, 325 threads) |
| first full shell read (same boot) | 5.1 s, 18.8 MB, 4,258 threads (pull 14: 10.2 s, 16.4 MB, 3,784) |
| weekly dashboard, 2026-W45, copy after the forced pass vs live (read-only) | `metrics.json` 1,347 rows, `escapes.json` 162 rows: identical. Run as `dashboard.py` and `gate_escapes.py` with `--db` and `HOME` set to a scratch directory, because `run.sh` would overwrite Carl's `~/loom-evals/dashboard.md`; `trace_corpus.py` reads session files, not the database |
| fresh empty home: spawn → `Listening` | 4.7 s (source); 7.1 s (built bundle) |

**Why the cockpit's `compacted-at` breadcrumb was two days stale.** Not a stuck or failing pass. The system journal has nothing between 6 Nov 20:30 and 9 Nov 09:00 AEDT and records `PM: suspend entry (deep)` at 20:30:37: the VM was suspended for 60.5 h. The cockpit's last passes before it completed at 05:08, 11:15 and 17:27 on 6 Nov; Node's 6 h timer counts only time the machine is awake, so the pass due at 23:27 started at 11:56 on 9 Nov, ran 12.5 min (7,462 events, the pre-merge compaction) and wrote the breadcrumb at 12:09. Nothing restarted.

### For Gate 2 and S4

- Gate 2's zone lists are in `clean-overlap-zones.md`, each file with its `loom:` count and the pull 15 DL rows that name it.
- Gate 2b: `packages/provider-pi/src/server/adapter.ts` lost Loom's background-job pin to upstream's status routing without a marker or a typecheck error (DL-1895); read the rest of that file's `extension_ui_request` paths with that in mind. `managedProvider.ts`/`usageLimits.ts` carry S3's narrowed silent-probe rule (DL-1891).
- S4: a `bg_start` job on a pi thread keeps the session pinned and its wake names the job (DL-1895); the pi Usage card keeps the poller's windows through a status refresh (DL-1891).
- The ship waits for the cockpit's Debian 12 upgrade (DL-1926); `vp run typecheck` and the web browser project are re-run there.
