## 3. Surface sizing, by zone (measured in S0)

Measured on `fe75bb6833` (`origin/main`) against `fa31b66bbb`, merge-base
`b76a110aa4`, in the trial worktree with pull 9's tools (`classify.py`,
`automerged.py`, `dangling.py`, `zones.py`) plus pull 13's S0 scripts
(`hunks.py`, `imports.py`, `rehome.py`) re-pointed at this pull. Captures:
`/tmp/pull14-measure/` (ephemeral; Appendix A reproduces them). The
orchestrator's numbers (1,374 / 3,763 / 303 / 123 / 299 / 986) are confirmed.

| Item | Value | Note |
| --- | ---: | --- |
| Upstream commits since base | 1,374 | 284 `fix(web)`, 226 `fix(server)`, 136 `fix(mobile)`, 59 `chore(lint)`, 44 `fix(desktop)`, 39 `refactor(web)`, 35 `feat(web)`, 32 `perf(server)` |
| Upstream files changed | 3,763 | 778 added, 131 deleted (19 tests), 14 renamed, 2,840 modified |
| Loom PRs since pull 13 landed | 51 (#446–#508) | 730 files, +10.5k/−103k; the audit series (#455, #457–#492) is the bulk of the deletions |
| Both sides changed | 303 | 123 conflicted + 180 merged silently |
| Conflicted paths | 123 (121 UU, 2 UD) | UD: `ComposerActivityStatus.tsx` (#25401 moved the thread state to the timeline end), `scripts/effect-budget.json` (#26161) |
| Conflict markers | 299 | 23 A (upstream's side has no code; 7 of them are upstream deletions or hoists, §7.1), 10 upstream-only insertions (Rule B), 12 Loom-side-only (11 lockfile + 1 `AGENTS.md` line), 254 content (31 of them in `pnpm-lock.yaml`) |
| Touched by #26238 dead-code deletion | 54 | of the 123; #26901 side chats 21; #26161 effect reasons 22; #27197 managed policy 15; linked environments (#16719/#17129/#17130) 30; #27252 stop 9; #26240 paging 7; #27106 shell 6 |
| `loom:` lines in conflicted files | 986 | |
| Files with a dangling relative import | 8 / 14 specifiers | 6 pre-existing false positives; 2 real: `FilePreviewPanel.tsx` → `./useFileSaveCoordinator`, `routes/_chat.tsx` → `../logicalProject` (§6.3) |
| Silently merged files that lost a Loom-side export | 24 files / 53 names | all upstream de-exports or deletions (#26238); 2 Loom consumers remain (§6.3) |
| Loom-only files with a broken import in the merged tree | 6 | `useEnvironmentIds` ×2, `ThreadStatusLabel`, `pendingUserInput` helpers ×2 files, `ThreadSettlementService.layer` (§6.3) |
| Loom effects needing a reason line | 56 (54 + 2 shared) | §6.8 |
| Lint rules newly erroring on Loom files | 1 new + ~14 promoted | plus 22 Effect LSP diagnostics at `error` (§6.8); exact counts from the first `vp check` |

### 3.1 Conflicted paths by zone

| Zone | Files | Markers | `loom:` lines | Hunk kinds | Character |
| --- | ---: | ---: | ---: | --- | --- |
| D: upstream deletions Loom modified | 2 | 0 | 3 | | `ComposerActivityStatus.tsx` (re-home one diagnostic), `effect-budget.json` (gone) |
| client-runtime | 5 | 9 | 26 | 9c | `shell.ts` ×3 (consult/cache item routing, goals), `driver.ts` ×2 (cookie-auth reclassification vs DPoP renewal), two Rule T tests |
| contracts | 6 | 12 | 52 | 9c 3A | `providerRuntime.ts` ×4 (921 upstream-deleted lines), `settings.ts` ×3 (standing defaults + `fx`), `orchestrationV2.ts` ×2, `providerInstance.ts`, `model.ts` |
| lockfile / config | 5 | 38 | 15 | 22c 11o 5B | lockfile 31 (regenerate); `dev-runner.ts` ×2; two `package.json`; one test |
| mobile | 6 | 10 | 33 | 10c | small Loom additions beside upstream edits (§6.10) |
| server core (orchestration-v2, ws, server, auth) | 12 | 27 | 180 | 23c 4A | `Orchestrator.ts` ×7, `ProjectionStore.ts` ×5 (one 914-line deletion), `ShellStream.ts` ×2 (§4), `ws.ts` ×3, `server.ts` ×3 |
| server other (vcs, project, usage, scripts, config, docs) | 28 | 52 | 167 | 42c 5A 4B 1o | `serverSettings.ts` ×5 (upstream re-solved Loom's memo), `VcsStatusBroadcaster.ts` ×4 (repository batch again), `AGENTS.md` ×5, `README.md` ×4, `vite.config.ts` |
| server persistence | 1 | 1 | 4 | 1c | `Sqlite.ts`: `cache_size` + `temp_store` |
| server provider / mcp | 7 | 11 | 39 | 11c | `builtInDrivers.ts` ×2 (Pi-only, standing), `ProviderInstanceRegistryHydration.ts` ×4, orchestrator `handlers.ts` (§5.1), two Rule T tests |
| shared | 2 | 2 | 2 | 2c | two Rule T tests |
| web chat | 17 | 46 | 161 | 42c 4A | `ChatView.tsx` ×9, `MessagesTimeline.tsx` ×6, `ChatMarkdown.tsx` ×4, `ChatComposer.tsx` ×4, the pull 13 split modules ×1–3 each |
| web panels / settings / other | 23 | 70 | 244 | 64c 5A 1B | `FilePreviewPanel.tsx` ×14 (§6.4), `DiffPanel.tsx` ×10 (§6.4), `RightPanelTabs.tsx` ×7, `PreviewView.tsx` ×5, `SidebarThreadRow.tsx` ×5, `modelSelection.ts` ×4 |
| web sidebar | 9 | 21 | 60 | 19c 2A | `Sidebar.tsx` ×4, `CommandPalette.tsx` ×4, `CommandPalette.logic.ts` ×3, `Sidebar.logic.ts` ×2 (§6.2), `_chat.tsx` (192-line upstream cut) |
| **total** | **123** | **299** | **986** | 254c 23A 10B 12o | |

Appendix B lists every path with its marker and `loom:` counts, its hunk
shapes and its rule.

### 3.2 Silently merged overlap (Gate 2's input)

180 files both sides changed merged without a marker; 174 of them carry a line
mentioning `loom` (843 in total). By zone: web-panels 33, server-core 30,
server-other 25, web-chat 17, provider packages 13, client-runtime 10,
contracts 9, shared 9, docs/config 8, server-provider/mcp 7, mobile 6,
root/config 5, desktop 3, persistence 3, web-sidebar 2. Appendix C lists them.
The ones that matter most are named in §4–§6: `ThreadSearch.ts` (7 `loom`
lines, upstream's side-chat exclusion came in cleanly), `provider-pi/adapter.ts`
(82 lines; the interrupt-timeout path of #27252), `mcpExtensionSource.ts`
(DL-905), `ProviderTurnStartService.ts` and `ThreadForkService.ts` (side-chat
forks beside Loom's `role` overlay), `runtimeLayer.ts`, `CheckpointService.ts`,
`ThreadSettlementService.ts` (its `layer` export is gone), `providerClients.ts`
(new upstream home for the driver list, §6.4), `DatabaseMaintenance.ts`
(both index rebuilds still there).
