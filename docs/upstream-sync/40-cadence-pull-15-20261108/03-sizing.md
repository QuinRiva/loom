## 3. Surface sizing, by zone (measured in S0)

Measured on `ce1bdbcd96` (`origin/main`) against `3fa57b92a2`, merge-base
`fa31b66bbb`, in the trial worktree with pull 9's tools (`classify.py`,
`automerged.py`, `dangling.py`, `zones.py`) plus pull 13's S0 scripts
(`hunks.py`, `imports.py`) re-pointed at this pull. Captures:
`/tmp/pull15-measure/` (ephemeral; Appendix A reproduces them). The
orchestrator's numbers (725 / 74 / 138 / 701 / 187) are confirmed; the raw
`--shortstat` (30k files, +2.1M/−1.7M) is almost all `.repos/` and is
replaced below by the app surface.

| Item | Value | Note |
| --- | ---: | --- |
| Upstream commits since base | 725 | 520 `fix` (179 server, 82 web, 66 mobile, 20 shared, 17 desktop, 15 gitlab, 13 opencode, 7 pi), 78 `perf` (43 server), 56 `feat`, 25 `test`, 19 `refactor`, 11 `docs` |
| Upstream app files changed (without `.repos/`) | 2,503 | 413 added, 37 deleted (4 tests), 41 renamed, 2,012 modified; +150,782/−53,683 |
| `.repos/` churn | 22,815 entries | `effect-smol` → `effect` rename (16,673 R) plus the Effect 4.1.2 and alchemy beta.85 re-syncs; merges clean except `.repos/effect/.envrc` (§6.9) |
| Biggest upstream commits (app files) | | #26833 Effect 4.1.2 (352), two mobile shell refactors (115, 101), #31028 tsgo (92), #31216 TaggedError (87), #30623 dictation (84), #14693 Kiro (84), #30625 transcription (75), #31217 Effect.try (62), #31218 HostProcess env (41) |
| Loom PRs since pull 14 landed | 20 (#515–#536) | 353 files, +20.9k/−8.6k; context-viz rail and timeline (#515, #525), Loom UI aligned to the redesign (#533), scheduling and attention fixes (#527, #531, #534) |
| Both sides changed | 261 | 74 conflicted + 187 merged silently |
| Conflicted paths | 74 (73 UU, 1 DU) | DU: `.repos/effect/.envrc`, a file Loom has never carried (§6.9) |
| Conflict markers | 138 | 128 content, 3 A (one of them an upstream move, §7.1), 2 B, 5 Loom-side-only (4 lockfile + `apps/server/package.json`'s `jose` line, which upstream deleted, §6.9) |
| Touched by | | Effect 4.1.2 #26833: 16 of the 74; thread tags #29053: 8; secret-provider usage keys #27760: 7; tsgo #31028: 7; `/clear` #30325: 6; Copy thread link #26290: 6; pi `--offline` #30187: 5; pi extension status #23901: 5; snooze with open question #20058: 4; event pruning #29806: 4 |
| `loom:` lines in conflicted files | 701 | |
| Files with a dangling relative import | 7 / 13 specifiers | 6 pre-existing false positives (string fixtures, a font, codegen, built assets); 1 real and conflicted: mobile `ThreadNavigationSidebar.tsx` → `../workspace/useSelectWorkspaceDetail`, moved by upstream to `../layout/workspace/` (take upstream's path) |
| Loom-only files with a broken workspace import | 0 | `imports.py` over 661 Loom-only `.ts/.tsx/.mjs` files (the ls-tree difference is 732, of which 71 are files upstream deleted since the base): every relative, `~/` and `@t3tools/*` named import resolves in the trial tree; the breakage is at package level (`effect/Crypto`, §5.2) |
| Silently merged files that lost a Loom-side export | 6 files / 19 names | all upstream moves or removals; no Loom consumer (§6.5) |
| Loom-only server files importing `effect/Crypto` | 8 (+ 4 Loom hunks in shared files) | the module is gone in 4.1.2 (§5.2); S2a |
| Loom sites the three mechanical Effect refactors reach | 2 `Data.TaggedError`, 1 bare `Effect.try`, 3 `process.env` reads inside Effect code, 4 `Effect.succeed(undefined)` | grep ceiling over 266 Loom-only non-test server/package files and 5,932 Loom-added lines in shared ones (§5.3); the suggestion rules need the checker |
| Lint rules newly erroring on Loom files | 1 web rule, unknown count | `t3code/max-settings-description-length` over `apps/web/src/**` (Loom's settings rows); counts from the first `vp check` |

### 3.1 Conflicted paths by zone

| Zone | Files | Markers | `loom:` lines | Hunk kinds | Character |
| --- | ---: | ---: | ---: | --- | --- |
| lock / config / docs | 8 | 29 | 14 | 20c 4o 1A | lockfile 17 (regenerate); `pnpm-workspace.yaml` ×3 (pi catalog and patch beside Effect 4.1.2; the moved release-age list); `AGENTS.md` ×3; `apps/server/package.json` ×2; `evals/*` ×2; `docs/user/composer.md` ×2; the `.envrc` DU |
| server core (orchestration-v2, cli, ws, server) | 13 | 26 | 204 | 25c 1A | `ws.ts` ×4 (provider-status stream, Loom ws layer), `Orchestrator.ts` ×3 (snooze guard, `freshContext` wake), `ProjectionMaintenance.ts` ×3 (§4), `ProjectionStore.ts` ×3, `ProviderSessionManager.ts` ×2 + test, `ThreadSearch.test.ts` ×2 (Rule T), `CheckpointService.ts` ×2 (`Digest`), `server.ts` ×2 |
| server other (usage, vcs, project, settings) | 9 | 16 | 83 | 15c 1B | `UsageLimitSources.ts` ×3 + test ×3, `cliproxyApi.ts` ×3 + test (§6.4, Rule D), `serverSettings.ts` + test, `GitVcsDriver.ts` ×2, `VcsStatusBroadcaster.ts`, `ProjectSetupScriptRunner.ts` |
| server persistence | 1 | 1 | 2 | 1c | `066_…test.ts`: Loom's `runLoomMigrations()` beside upstream's `ProjectionReplay` testkit |
| server provider / mcp | 8 | 11 | 43 | 11c | `builtInDrivers.ts` (Pi-only, standing; upstream adds Kiro), `ProviderRegistry.test.ts` ×3 (Rule T), `McpHttpServer.ts`, `OrchestratorMcpService.ts`, `ProviderInstanceRegistryHydration.ts`, two tests, `agentContextBudget.json` |
| provider-pi package | 5 | 7 | 71 | 7c | `adapter.ts` ×3 (extension status reset, compaction hold beside Loom's jobs and cache touch), `mcpInjection.ts`, `status.ts`, `textGeneration.ts` + test (`shortLived`/`--offline` beside `disableExtensions: false`) |
| shared | 1 | 2 | 7 | 2c | `composerContextReferences.ts`: Loom's MDX anchor details and `formatThreadLink` beside upstream's `replaceThreadLinks` |
| contracts | 2 | 2 | 14 | 2c | `settings.ts` (disabled-by-default drivers: upstream adds `kiro`, Loom keeps `pi` out), `clientRpcPermissions.ts` (one marker) |
| client-runtime | 2 | 2 | 15 | 2c | `state/shell.ts` imports (`subscribeDynamicWithSession`), `commandPermissions.test.ts` |
| mobile | 4 | 5 | 18 | 4c 1A | §6.10: `AdaptiveWorkspaceLayout.tsx`, `PendingUserInputCard.tsx` (A: upstream deleted the overlay constant around Loom's `askedAgo`), `ThreadNavigationSidebar.tsx` ×2 (upstream moved `listMenuActions` out), `threadListV2.ts` |
| web chat | 4 | 8 | 52 | 8c | `ChatView.tsx` ×3 (two wrappers around Loom blocks), `MarkdownThreadLink.tsx` ×2 (hosted link, §6.5), `useComposerMenuItems.ts` ×2 (`/clear`, visible shells), `ChatMarkdown.browser.test.tsx` |
| web panels / settings / other | 14 | 25 | 147 | 24c 1B | `PreviewView.tsx` ×4 (annotation voice beside Loom's per-tab pick; the standing unmount ruling), `pullRequestDetail.logic.ts` ×3 (URL-keyed ids beside Loom's `kind: "line"`), `FilePreviewPanel.tsx` ×2, `SidebarThreadRow.tsx` ×2, `composer-logic.ts` ×2, four Rule T tests, `UsagePage.tsx`, `UsageLimitsPooled.tsx`, `markdown-links.ts`, `terminal-links.ts`, `state/threads.ts`, `useThreadActionMenu.ts` |
| web sidebar | 3 | 4 | 31 | 4c | `Sidebar.tsx` ×2 (working shelf, the `<ul>` around search results), `ThreadNotificationCoordinator.tsx`, `ThreadRouteView.tsx` (hidden threads beside Loom's shell-less root) |
| **total** | **74** | **138** | **701** | 128c 3A 2B 5o | |

Appendix B lists every path with its marker and `loom:` counts, its hunk
shapes and its rule.

### 3.2 Silently merged overlap (Gate 2's input)

187 files both sides changed merged without a marker; 185 of them carry a line
mentioning `loom` (975 in total; `packages/client-runtime/package.json`'s 36
are its `./state/loom/*` export paths). By zone: web-panels 31, server-core
30, server-other 24, web-chat 16, client-runtime 12, shared 12, contracts
11, mobile 9, provider packages 9, docs 9, server-provider/mcp 8, persistence
5, root/config 5, desktop 3, web-sidebar 3. Appendix C lists them. The ones that
matter most are named in §4–§6: `OrchestrationEventStore.ts` and
`DatabaseStorage.ts` (the prune mark and the 10 % duty loop that calls it),
`ws.test.ts` (9 `loom` lines beside upstream's 237-line replay rewrite),
`ThreadSettlementService.ts` (23 lines; #31857 project actions and the
user_input snooze rule beside DL-1705), `PullRequestWatchReactor.ts` (Loom
#527 beside upstream's 83-line reactor change), `McpHttpServer.ts`'s new
`registrations` shape around `LoomToolkitRegistrationLive`, `McpInvocationContext.ts`,
`ProviderTurnStartService.ts`, `MessagesTimeline.logic.ts` (the tool-call
visibility filter, §6.5), `composerContextPresentation.tsx` (Loom's promoted
link under upstream's moved context), `Sidebar.logic.ts`, `rightPanelStore.ts`
(31), `index.css` (33), `vite.config.ts` (17: Loom's jsdom list survived,
verified), `knip.jsonc`, `packages/shared/src/usageLimits.ts` (23).
