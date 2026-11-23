## 3. Surface sizing, by zone (measured in S0)

Measured on `7305fc654e` (`origin/main`) against `a09738fb43`, merge-base
`3fa57b92a2`, in the trial worktree with pull 9's tools (`classify.py`,
`automerged.py`, `dangling.py`, `zones.py`) and this runbook's
[`tools/`](tools/) (`hunks.py`, `imports.py`, `overlap.py`, `composition.py`,
`prdigest.sh`). Captures: `.artifacts/pull16-measure/` (gitignored; Appendix
A reproduces them). The orchestrator's first numbers (3,335 / 193 / 513 /
1,530 / 170) are confirmed; four of its premises were not, and are corrected
where they matter: the migrations run to 108, not 105; the cockpit database
is 4.73 GB, not over 10 GB; pull 15's event-prune guard no longer exists;
Loom's bundled pi is 1.5.1.

| Item | Value | Note |
| --- | ---: | --- |
| Upstream commits since base | 3,335 | 2,860 `fix` (server 1,046, web 736, mobile 269, desktop 109), 168 `feat` (web 47, server 23, mobile 21), 152 `perf` (server 80), 73 `test`, 24 `chore`, 22 `docs`, 21 `ci`, 11 `refactor`. Per provider: opencode 53, acp 40, pi 31, cursor 30, antigravity 26. No reverts |
| Upstream files changed (without `.repos/`) | 5,273 | 1,217 added, 62 deleted, 34 renamed, 3,960 modified; +993,653/−216,095 |
| Of the +994k | | translation catalogues 182k (39 JSON files); one vendored C file 151k (`apps/mobile/modules/t3-highlights/…/highlights.c`, regenerated); generated code and schemas 64k (Linear GraphQL 54k); lockfile 3.4k; recorded fixtures 1.5k; docs and config 11.6k; **source 295k; tests 284k** |
| Source and tests by app | | server 74k / 162k; web 85k / 42k; mobile 46k / 13k; desktop 6k / 9k; packages 64k / 54k (client-runtime 17k source, shared 6.2k, contracts 3.9k, provider-pi 1.9k) |
| `.repos/` churn | 1,005 entries | Effect 4.1.5 re-sync; merges clean |
| Biggest upstream commits (app files) | | #37893 translation (1,408), #35925 multi-repository projects (236), #35993 `Effect.scoped` (171), #35871 agent feedback (108), #27866 markdown rewrite (101), #39406 linked-environment reads (90), #33131 Labs cleanup (87) |
| Loom PRs since pull 15 landed | 28 (#538 to #591) | 315 files, +28,483/−1,867 (§6.15). 18 touch 32 conflicted paths; 24 of the silently merged files |
| Both sides changed | 365 | 193 conflicted + 170 merged silently + 2 renamed upstream that the tool misses (`modelPickerSearch.ts` → `client-runtime/modelSearch.ts` and its test; Loom's lines carried, verified) |
| Conflicted paths | 193 (191 UU, 2 UD) | UD: `apps/web/src/components/chat/ContextWindowMeter.tsx` and `patches/@pierre%2Fdiffs@1.6.1.patch`, both deleted upstream and modified by Loom (§6.1) |
| Conflict markers | 513 | 472 `c`, 27 `o`, 13 `B`, 1 `A` (§7.1 on why the kinds mislead this pull); 56 are `pnpm-lock.yaml`; 98 hunks in 64 files have a side of 20 lines or more |
| Upstream commits that touch a conflicted path | 1,299 | by paths touched: translation #37893 66; multi-repo #35925 35; agent feedback #35871 22; Labs cleanup #33131 20; markdown #27866 18; issue tools #19270 16; subagents open the same way #39515 13; Linear #19274 13; Reply #33124 12; `Effect.scoped` #35993 11; linked environments #39406 11 |
| `loom:` lines in conflicted files | 1,530 | |
| Silently merged files | 170 (+2) | 167 with a `loom` line; 629 `loom` lines in the trial tree against 629 at `HEAD`; all 3,749 non-blank Loom-added lines present. Upstream made 1,184 commits to these files |
| Silently merged files that lost a Loom-side export | 7 files / 9 names | all upstream's own exports, removed or made private upstream; 1 Loom-only consumer and 2 conflicted hunks use them (§6.14) |
| Files with a dangling relative import | 9 / 20 specifiers | 3 real (§6.14), 5 known false positives, 1 stale upstream mock |
| Loom-only files | 804 | 733 Loom's own; 71 are files upstream deleted that Loom carries (68 untouched, which the merge rightly deletes) |
| Loom-only files with a broken import in the merged tree | 8 real | of 23 hits; 15 are code samples inside eval fixture strings (§6.14) |
| Loom-only dependencies the merge drops silently | 2 | `unified`, `@types/mdast` (§5.4) |
| Lint errors from the new i18n rule on Loom's code | 1,096 in 121 Loom-only files; 42 to 44 on Loom lines in 19 upstream files | exact run of the target's rule (§5.1) |
| New Effect diagnostics; Effect 4.1.5 exposures | 0; 0 | `tsconfig.effect.json` unchanged (§5.6) |
| New upstream agent tools | 23 | 9 PR and CI, 8 issue, 2 theme, feedback, `send_to_user`, `t3_submit_output`, `tool_search` (§4.1) |
| New upstream migrations | 28 (081 to 108) + 5 edited in place | first boot 20 to 90 s estimated; none touches a Loom object (§5.5) |

### 3.1 Conflicted paths by zone

The zones are Appendix B's; each is one file with a row per hunk. `big` =
hunks with a side of 20 lines or more.

| Zone | S1 thread | Files | Markers | `loom:` lines | Kinds | Character |
| --- | --- | ---: | ---: | ---: | --- | --- |
| B.1 config, lockfile, docs | lead | 15 | 83 | 26 | 74c 6o 3B; 14 big | lockfile 56 (regenerate); `AGENTS.md` ×7 (Loom's side); `apps/web/package.json` ×4 (§5.4); `pnpm-workspace.yaml` ×2; `README.md` ×2; six docs, four of which turn on the meter ruling |
| B.2 orchestration | lane 1 | 10 | 27 | 118 | 27c; 1 big | `Orchestrator.ts` ×13 (unions; Rule D in two; one superseded), `ThreadSettlementService.ts` ×5 (#527 beside #38926 and #19665), deletion, runtime layer, legacy importer |
| B.3 store, shell, search | lane 1 | 11 | 32 | 91 | 31c 1o; 5 big | `ProjectionStore.ts` ×10 (two traps, §6.8), `ShellStream.ts` ×5 (unions), `ThreadSearch.ts` ×3 + test (Rule T), `Sqlite.ts` ×2 (two-ledger setup), client `shell.ts` ×3, `shellReducer.ts` ×2 |
| B.4 server entry | lane 1 | 11 | 18 | 97 | 18c; 3 big | `ws.ts` ×5, `server.ts`, `http.ts` (APK redaction moves), startup ×3, `presentation.ts` ×3 |
| B.5 MCP | lane 1 | 9 | 17 | 34 | 16c 1o; 2 big | `OrchestratorMcpService.ts` ×7, `handlers.ts` (the `o` hunk that is a move, §4.4), `McpSessionRegistry.ts` + test ×3, `PullRequestWatchReactor.ts` (Rule D), `agentContextBudget.json` |
| B.6 providers | lane 2 | 22 | 67 | 185 | 61c 4o 2B; 15 big | `adapter.ts` ×10, `managedProvider.ts` ×8, `mcpExtensionSource.ts` ×7, `ProviderSessionManager.test.ts` ×7, `status.ts` ×6, `ProviderSessionManager.ts` ×5, `ClaudeProvider.ts` ×4 (upstream's whole file), three replay transcripts |
| B.7 usage | lane 2 | 9 | 21 | 76 | 18c 3o; 5 big | `cliproxyApi.ts` ×6 (Rule D), `UsageLimitSources.ts` ×2, `usageLimits.ts` ×2, web and mobile pooled views |
| B.8 VCS, projects, workspace | lane 3 | 23 | 53 | 152 | 47c 5B 1A; 21 big | `VcsStatusBroadcaster.ts` ×7, `GitVcsDriver.ts` ×6, `GitVcsDriverCore.ts` ×6 (duplicate-declaration `B` hunks), `AssetAccess.ts` + test ×4 each, `migrate-dev-db.ts` ×4, `dev-runner.ts` + test |
| B.9 web chat | lane 4 | 23 | 57 | 210 | 54c 3o; 7 big | `ChatMarkdown.tsx` ×11 (Rule D with Appendix D), `ChatView.tsx` ×7, `MarkdownThreadLink.tsx` ×5 + test ×4, composer files (meter lines), eight files whose hunks exist only because of the translation |
| B.10 web panels | lane 5 | 19 | 70 | 275 | 62c 5o 3B; 12 big | `FilePreviewPanel.tsx` ×14, `DiffPanel.tsx` ×13, `FileBrowserPanel.tsx` ×8, `rightPanelStore.ts` ×7 (version 17), `AnnotatableCodeView.tsx` ×4, `index.css` |
| B.11 web sidebar | lane 5 | 15 | 27 | 113 | 24c 3o; 4 big | `SidebarThreadRow.tsx` ×8 (three upstream deletions dressed as Loom hunks), `Sidebar.tsx` ×2, palette ×5, `__root.tsx` and `_chat.tsx` (rebuilt on upstream's structure) |
| B.12 contracts, settings | lane 6 | 15 | 20 | 100 | 19c 1o; 3 big | the two UD paths; `settings.ts`, `orchestrationV2.ts` (26 `loom` lines, one marker), five settings panels, `modelSelection.ts` + test |
| B.13 mobile, permissions | lane 6 | 11 | 21 | 53 | 21c; 6 big | `ThreadFeed.tsx` ×7 (the two lookups), `PendingUserInputCard.tsx` ×3, search match ×2, `clientRpcPermissions.ts` ×2 |
| **total** | | **193** | **513** | **1,530** | 472c 27o 13B 1A; 98 big | |

### 3.2 Silently merged overlap (Gate 2's input)

170 files (plus the two renamed ones) both sides changed merged without a
marker; 167 carry a line mentioning `loom`, 629 in total. By zone: web
panels and other 33, server-other 22, web-chat 19, server-core 17, mobile
14, client-runtime 11, provider packages 11, shared 10, contracts 9, docs 6,
root and config 5, server provider and MCP 4, desktop 3, persistence 3,
web-sidebar 3. Appendix C lists them with the 25 where a silent merge is
most likely to be wrong in meaning. The ones this runbook already names as
wrong or to be edited: `ProviderSessionManager.ts` (`reportedError`),
`ProviderTurnStartService.ts` and `ProviderTurnControlService.ts` (sender
note), `CheckpointService.ts` and `CheckpointStore.ts`, `Sidebar.tsx` (the
`source` argument), `apps/web/package.json` (two dropped lines),
`ComposerFooterControls.tsx` (the meter import upstream deleted),
`client-runtime/connection/driver.ts` (duplicate import), `README.md` and
`AGENTS.md` (auto-merged upstream lines), `ComposerContextSheet.tsx`,
`toast.tsx` and `reviewCommentContext.ts` (strings that fail the lint rule),
`runtimeLayer.test.ts` (upstream's new `seedProject` calls against Loom's
one-active-project-per-root index, migration 1018).
