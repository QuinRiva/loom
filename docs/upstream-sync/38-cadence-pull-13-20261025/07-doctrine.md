## 7. Upstream change digest and per-zone resolution doctrine

Doctrine §4.3 (`05-strategy.md`): where upstream now expresses the same
functionality, upstream's mechanism is the baseline and Loom's variant is
deleted. Otherwise upstream wins verbatim and Loom's seam is re-applied behind
`// loom:`.

### 7.1 Five mechanical rules

- **Rule A: comment-adjacent (86 markers).** Upstream's side is empty or
  comment-only; Loom's side is a `// loom:` hunk or a Loom comment next to a
  comment #21514 deleted. Keep Loom's side, drop upstream's. Do not restore a
  pruned upstream comment; where Loom's side is only a narration comment with
  no marker and no code, take upstream's deletion (DL-1206's practice: keep
  only the Loom-specific sentence, marked). **Keep only Loom's own lines from
  Loom's side:** `hunks.py` labels a hunk A whenever upstream's side has no code
  and Loom's side has a `loom` line, so an A hunk can also carry upstream code
  that upstream deleted or moved elsewhere in the file (pre-merge review: a
  `sideresolve.py --ours` keeps a second `useWorkspaceMutationRefresh` in
  `DiffPanel.tsx`, a duplicate `OrchestrationV2ProviderTurnTokenUsage` in
  `contracts/orchestrationV2.ts`, a dangling `CARD_LAYOUT_TRANSITION` in mobile
  `PendingUserInputCard.tsx`, an unused `ResourceCleanupService` import in
  `server.ts`). Before `--ours`, grep upstream's blob for each non-`loom` code
  line on Loom's side; one that upstream moved gets Loom's marked change
  re-applied at its new home (Rule D), one upstream deleted is dropped.
- **Rule B: upstream-only insertion (7 markers).** Loom's side is empty: take
  upstream's (`ThreadSearch.ts` hunk 3). Pull 12's DL-1203/DL-1204 warning: a
  "Rule B" that is really a Loom deletion against an upstream edit takes
  Loom's side. Pre-merge review found six of the seven are that case:
  `web/usageProviders.ts`, the three `mobile/usageProviders.ts` hunks and
  `UsageProviderChart.test.ts` each carry upstream's new `muse` line **plus
  the old `pi` line Loom moved to the top** (DL-918): take only the `muse`
  line (the mobile order array would otherwise list `pi` twice with no type
  error). `VcsStatusBroadcaster.ts` hunk 6 is upstream's `Effect.fnUntraced`
  re-shape of the per-cwd `makeRemoteRefreshLoop` that Loom **deleted** and
  replaced with its per-repository loop (still in the file, trial L670): take
  Loom's empty side, and fold upstream's loop changes since the base (#13253:
  `automaticFetchInterval`, `DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL`, a zero
  interval stops the fetch) into Loom's repository loop.
- **Rule C: React Compiler shape (few this time).** As pull 12 §5.1: upstream's
  shape, Loom's lines inside, no `useMemo`/`useCallback` in a web file.
- **Rule D: re-apply onto upstream's shape (the big one: 17 files, ≈ 60 markers).**
  Upstream re-indented or relocated a region (the `Effect.fn` sweep on the
  server, the module split on the web, `runOrderedV2StartupPhases`), and git
  shows a large Loom-side region against a small or empty upstream side. The
  region on Loom's side is upstream's old code with Loom's hunks inside it.
  Method (DL-1222's): resolve the hunk to **upstream's side**, then re-apply
  Loom's delta for that region from `git diff 07d38b8d17 origin/main -- <file>`
  (only the lines with `loom` and their minimal context), into the place that
  now holds the surrounding code: the same file for `Effect.fn` re-shapes, or
  the module Appendix D names for the split web files. Afterwards, per file,
  confirm every `loom`-bearing line of `origin/main`'s version is either
  present in the merged tree (possibly in another file) or named in a DL row.
  Files: `Orchestrator.ts`, `ws.ts`, `ProjectionStore.ts`, `serverRuntimeStartup.ts`,
  `cli/config.ts`, `cli/server.ts`, `WorkspaceFileSystem.ts`, `ProjectSetupScriptRunner.ts`,
  `OpenCodeRuntime.ts`, `provider-pi/driver.ts`, `DrainableWorker.ts`,
  `dev-runner.ts`, `ChatView.tsx`, `ChatMarkdown.tsx`, `MessagesTimeline.tsx`,
  `Sidebar.tsx`, `ChatComposer.tsx`, `CommandPalette.tsx`, `SettingsPanels.tsx`,
  `FilePreviewPanel.tsx`, `index.css`, `use-composer-drafts.ts`.
- **Rule T: test prune (§5.2).** 37 files.

### 7.2 Server zones

| Area / file | Upstream change | Resolution |
| --- | --- | --- |
| `orchestration-v2/Orchestrator.ts` (11), `ProjectionStore.ts` (6), `ws.ts` (10), `serverRuntimeStartup.ts` (3), `cli/server.ts` (1), `cli/config.ts` (1) | §6.1 | Rule D with the §6.1 table; import unions (`isLoomCommand`, `loomCommandThreadId`, `isLoomDomainEvent`, Loom's `ProviderHealthRegistry` import beside upstream's `isNetworkPath`); `cli/server.ts` keeps `refuseWhenHomeIsLive: true` |
| `orchestration-v2/ThreadSearch.ts` (4), `ThreadSearch.test.ts` (DU), `http.ts` (1), `legacy/LegacyV1ThreadImporter.ts` (3), `ThreadSettlementService.ts` (2), `ProviderSessionManager.ts` (3) + test (3), `CheckpointService.test.ts`, `ProjectionSettlement.test.ts` | §4; #23902 read routing; `Effect.fn` | `ThreadSearch.ts` upstream verbatim and the DU as upstream's (§4.5 (b)); `http.ts` union (Loom's goal snapshot fields + upstream's `omitOlderSettled` query flag); importer: Loom's 17 lines re-applied (Rule D on the 26/4 hunk); settlement: union; PSM: Rule A ×1 + Rule D; tests: Rule T |
| `server.ts` (1), `serverRuntimeStartup.test.ts` (2), `McpSessionRegistry.ts` (2) | prune | Rule A |
| `persistence/Sqlite.ts` (1) | prune only; `WAL_SIZE_LIMIT_BYTES` un-exported | Rule A: Loom's two-ledger `runAllMigrations()` + 128 MB `cache_size` stay; upstream's stats block as in pull 12 |
| `vcs/GitVcsDriverCore.ts` (10), `VcsStatusBroadcaster.ts` (7), both tests (4 + 3), `GitVcsDriver.ts` (1) | `sourceControlDefinitions`; fetch timeouts as constants; `resolvePrimaryRemoteName`/`knownOriginDefaultBranch` options where Loom passes `topology`; worktree removal by resolved path; `remoteRefreshFailureDelay`; `localOnly` refresh | Loom's repository batch (`topology`, the jitter, the per-repository poller) re-applied on upstream's new signatures (DL-1221's shape). Hunk 3: `parseUpstreamTrack` is **Loom's** (added with the batch, unmarked; the batch calls it at the trial's L2217): keep it and mark it; `parseNumstatEntries` beside it is upstream's deletion: drop it. Hunks 1 and 10 carry the foreign-home guard (DL-81): its import and the `refuseForeignHomeSideEffect` check go in front of upstream's new `removeLinkedWorktree` call. Tests: Rule T, keeping Loom's repository-batch cases (§5.2 rule 3). **Gate 1 look** |
| `workspace/WorkspaceFileSystem.ts` (2), `WorkspaceEntries.ts` (2), `assets/AssetAccess.ts` (1), `http.ts` (1), `checkpointing/CheckpointDiffQuery.ts` (1), `terminal/Manager.ts` (1), `cloud/ManagedEndpointRuntime.ts` (1), `binCli.ts` (2) | `Effect.fn`; non-blocking opens; prune | Rule D / Rule A; Loom's `maxBytes` plan budget and artefact `Cache-Control` stay |
| `project/ProjectSetupScriptRunner.ts` (1) + test (2), `ProjectService.test.ts` (1), `RepositoryIdentityResolver.test.ts` (2) | `Effect.fn`; prune | Rule D (Loom's 13 lines: setup-state file, worktree `.t3`); tests Rule T |
| `usage/UsageLimitSources.ts` (1), `cliproxyApi.test.ts` (2), `usageScanCache.test.ts` (1), `serverSettings.test.ts` (1), `AssetAccess.test.ts` (4), `GitManager.test.ts` (2), `http.test.ts` (2), `externalLauncher.test.ts` (1), `terminal/Manager.test.ts` (4) | prune | Rule A / Rule T |
| `provider/ProviderRegistry.test.ts` (6), `ClaudeCapabilitiesProbe.test.ts` (3), `CodexProvider.test.ts` (1), `ProviderInstanceRegistryHydration.ts` (1) | prune + `Effect.fn` | Registry test: Loom's DL-916 retirements and the ghost-driver/pi cases are the kept Loom tests (Rule T rule 3), upstream's deletions elsewhere; Claude/Codex tests: Rule T rule 1 (dormant drivers; Loom's "wedged probe" test is kept only if it compiles without the de-exported constant); hydration: Rule D |
| `packages/provider-pi/src/server/adapter.ts` (3), `driver.ts` (1), `mcpExtensionSource.ts` (2) + test (2), `mcpInjection.ts` (1), `mcpBridge.testkit.ts` (2) | §6.1 last rows | Rule A / Rule D; DL-905 and DL-938 are the invariants; Gate 1 |
| `packages/provider-core/src/server/managedProvider.ts` (1), `usageLimits.ts` (1), `provider-opencode/OpenCodeRuntime.ts` (1) | `Effect.fn` | Rule D (Loom's fold-based `updateUsageLimits` and retraction; OpenCode is dormant, Loom's one line) |
| `packages/shared/src/DrainableWorker.ts` (2), four shared tests | `Effect.fn.Return` | Rule D; tests Rule T |
| `packages/contracts/src/settings.ts` (2), `settings.test.ts` (4) | `guestSharingEnabled` beside `autoResumeLimitedThreads`; prune | Loom's defaults stay (`autoResumeLimitedThreads: true`, `contextWindowMeterEnabled: true`, `LoomServerSettingsFields`); take `guestSharingEnabled: false`; test: Rule T keeps Loom's default assertions |
| `contracts/orchestrationV2.ts` (6), `rpc.ts` (1), `clientRpcPermissions.ts` (2), `index.ts` (1), `project.ts` (1), `providerInstance.ts` (1), `composerContext.ts` (1) + test (2), `threadSearch.ts` (1) | guest share schemas and scopes; older-settled; opens; prune | Unions (`makeLoomInternalCommandMembers` + guest commands; `LoomWsRpcs` + guest RPC; Loom's hub-login scopes + `guestShareCreate`); `orchestrationV2.ts` hunk 1 is **not** Rule A: upstream moved `OrchestrationV2ProviderTurnTokenUsage` up beside the context-transfer schemas and added `autoCompactThreshold`/`promptCacheExpiresAt`, so take upstream's deletion here and re-apply Loom's marked `costUsd` field inside the moved struct (losing it silently strips cost from decoded usage); `threadSearch.ts` per §4.2 |
| `packages/client-runtime/src/state/shell.ts` (1), three tests | one import line; prune | Union; Rule T |

### 7.3 Web zones

| Area / file | Upstream change | Resolution |
| --- | --- | --- |
| `ChatView.tsx` (11) | 30+ hooks extracted (`useComposerSend`, `useRightPanelActions`, `useThreadLifecycle`, `useSystemComposerBanners`, `ThreadActivityBanners`, …) | Rule D with Appendix D: 29 Loom hunks, 18 stay in `ChatView.tsx`, 7 move to `chat/useComposerSend.ts` (reply-in-chat, `/handoff`/`/retro` intercepts, tab promotion on send, DT-67 title), 2 to `chat/useRightPanelActions.ts` (Loom surfaces, goal tasks), 1 each to `useSystemComposerBanners.tsx` (fork guidance) and `useThreadLifecycle.tsx` (archived root line). `RightPanelSurfaceContent.tsx` (silent) keeps DL-1211's four arms |
| `ChatMarkdown.tsx` (10) | code blocks, links/file chips, media, tables, Mermaid split into `chat/Markdown*.tsx`, `ChatMarkdownMedia.tsx` | Rule D with Appendix D: 39 hunks, 15 stay (the plugin pipeline, `useReferenceLinkRules`, prose path scan, `CHAT_MARKDOWN_COMPONENTS_WITH_PROSE_PATHS`), 7 to `ChatMarkdownMedia.tsx` (`uncapWidth`, `maxWidthCap`), 6 to `MarkdownFileLink.tsx` (artefact viewer primary action, click-time re-verify), 2 to `MarkdownCodeBlock.tsx` (path decoration), 1 to `MarkdownMermaidCodeBlock.tsx`; the 7 "no context" ones are Loom's own imports/helpers that stay. **Gate 1 reads it** |
| `chat/MessagesTimeline.tsx` (8) | rows split into `TimelineUserMessageRow`, `TimelineAssistantRows`, `TimelineWorkEntryRow`, `TimelineV2EventRow`, `UserMessageContextChips`, hooks | Rule D with Appendix D: 29 hunks, 9 stay (`useLoomTimelineRows` splice before `useStableRows`, DL-1210), 9 to `TimelineUserMessageRow.tsx` (`loomBubble`, control digest), 3 each to `UserMessageContextChips.tsx` and `TimelineAssistantRows.tsx`, 2 to `timelineRowContext.ts`, 1 each to `TimelineWorkEntryRow.tsx`, `useTimelinePositionRestore.ts`, `TimelineV2EventRow.tsx` |
| `Sidebar.tsx` (7), `Sidebar.logic.ts` (3) + test (2) | thread rows → `sidebar/SidebarThreadRow.tsx`, markers and drafts → own files; guest and search changes | Rule D: 40 hunks, 14 stay, **22 move to `sidebar/SidebarThreadRow.tsx`** (badge, start cue, rollup, handoff drafter), 1 to `SidebarDraftBlock.tsx`, 1 to `hooks/useThreadActionMenu.ts`; `Sidebar.logic.ts` keeps its 7 (handoff drafter visibility, `startLabel`, "a flagged row never recedes"); search per §4.2 |
| `chat/ChatComposer.tsx` (5) | menus → `useComposerMenuItems.ts`, footer → `ComposerFooterControls.tsx`, intake/stash/send hooks | Rule D: 16 hunks, 9 stay, 5 to `useComposerMenuItems.ts` (Loom's slash commands), 2 to `ComposerFooterControls.tsx` |
| `CommandPalette.tsx` (4), `.logic.ts` (5) + test (5) | thread items → `CommandPaletteThreadItems.tsx`, theme items, project items; search (§4) | Rule D + §4.2: 11 hunks, 5 stay, 3 to `CommandPaletteThreadItems.tsx`, 1 to `CommandPaletteThemeItems.tsx`; `.logic.ts` keeps 6 (one moves to `settings/settingsSearch.ts`) |
| `settings/SettingsPanels.tsx` (3), `ProviderSettingsPanel.environment.browser.test.tsx` (2) | pages split into `settings/*` files; beta panel | Rule D: 6 hunks, 2 stay, 1 each to `BackgroundActivitySettings.tsx` and `ArchivedThreadsPanel.tsx`, 2 are Loom imports; the browser test: Rule T rule 3 (Pi enabled by default, allow-list fields) on the new `render` helper |
| `files/FilePreviewPanel.tsx` (4), `FileBrowserPanel.tsx` (2), `projectFilesQueryState.ts` (1) + test (2), `preview/PreviewView.tsx` (1) + browser test (1), `diffs/*`, `DiffPanel.tsx` (1), `DiffWorkerPoolProvider.tsx` (1), `rightPanelStore.ts` (2) + test (4) | prune; theme store no longer syncs through effects (#25007); `@pierre/highlights` | Rule A / Rule D; `PreviewView` keeps Loom's "annotation survives unmount" (standing); `rightPanelStore` singleton surfaces and storage version as DL-1215; `DiffWorkerPoolProvider` (11/13): upstream's theme read + Loom's #424 pool options |
| `ThreadNotificationCoordinator.tsx` (1: 96/12), `ThreadRouteView.tsx` (2), `routes/__root.tsx` (1), `_chat.index.tsx` (1), `pair.tsx` (1) | guest; app-shell shortcuts register once (#25016); appearance applied from app start (#25004) | Rule D: Loom's `pendingQuestionOf`/Loom-reason notifications re-applied on upstream's guest-aware coordinator; route files: unions |
| `index.css` (3) | KaTeX, context chips, design overhaul | Union: Loom's bleed budget block (110 lines) stays, Loom's `.chat-scanned-path-link` exclusion added to upstream's new `:not(...)` lists |
| `ThreadSearchMatch.tsx` (2), `state/queries.ts` (2), `closedViewStore.test.ts`, `keybindings.test.ts`, `markdown-links.test.ts`, `modelSelection.ts` (1) + test, `reviewCommentContext.ts` (1) + test, `composerDraftStore.ts` (1) + test, `terminal-links.ts` (1), `editor/usage/*` | §4; prune | §4.2 for the search files; Rule A / Rule T / small unions for the rest; `modelSelection.ts` (2/4) and `terminal-links.ts` (6/5) are reads |
| `routeTree.gen.ts` (11) | settings routes moved | §6.5 |

### 7.4 Mobile, desktop, new upstream directories

Take verbatim: `apps/mobile/modules/` (48 files), `apps/server/src/guest/`,
`apps/web/src/components/guest/`, `apps/web/test/`, `packages/shared/src/paletteSearch.ts`,
`packages/shared/src/sourceControl*`, the Expo 58 patch set, `scripts/effect-budget.json`
(then extended, §8.2). Mobile conflicts per §6.7 and §4.2.
