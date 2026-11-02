## 7. Upstream change digest and per-zone resolution doctrine

Doctrine §4.3 (`05-strategy.md`): where upstream now expresses the same
functionality, upstream's mechanism is the baseline and Loom's variant is
deleted. Otherwise upstream wins verbatim and Loom's seam is re-applied behind
`// loom:`.

### 7.1 The rules, as they apply this week

- **Rule A: comment-adjacent (23 markers).** Upstream's side is empty or
  comment-only; Loom's side is a marked hunk beside it. Keep Loom's side.
  **The caveat decides more than the rule:** `hunks.py` labels a hunk A
  whenever upstream's side has no code and Loom's side has a `loom` line, so
  an A hunk can be upstream deleting a block (#26238) or moving one (a hoist)
  that holds one Loom line. **Before keeping Loom's side of any A hunk**, grep
  upstream's blob for each non-`loom` code line in it; a line upstream deleted
  is dropped, one upstream moved gets Loom's marked change at its new home.
  The 23 A hunks this week: seven are deletions or hoists (`ProjectionStore.ts`
  [914/0], `providerRuntime.ts` [192/0] [46/0] [683/0], `TimelineV2EventRow.tsx`
  [84/0], `CommandPalette.tsx` [130/0], **`Orchestrator.ts` [29/0]**, the
  `ask_user_question` hoist, §6.1); the rest are genuine Rule A
  (`RpcAuthorization.ts` [22/0] and `RpcInstrumentation.ts` [22/0]: Loom's rows
  in exhaustive maps; `versionSkew.ts` [16/0]; `vite.config.ts` [15/0]: Loom's
  allowlist, keep and re-wire, §6.8; `ChatView.tsx` [7/0] [2/0] [2/0];
  `SidebarThreadRow.tsx` [14/0]; `FileBrowserPanel.tsx` [22/1];
  `FilePreviewPanel.tsx` [12/0]; `SettingsPanels.tsx` [2/0];
  `routes/__root.tsx` [6/0]; `ProjectSetupScriptRunner.ts` [6/0];
  `knip.jsonc` [1/0]; `serverSettings.ts` [1/0]; `ProjectionMaintenance.ts`
  [4/3]) and are checked the same way. The 12 "ours-only" hunks (upstream's
  side empty, no `loom` line on Loom's) are 11 lockfile hunks and one
  `AGENTS.md` line.
- **Rule A caveat, second form: a Loom clause the hoisted code already covers**
  is deleted as superseded (doctrine §4.3), with a DL row: `loomAskAnswer`
  (§6.1) this week.
- **Rule B: upstream-only insertion (10 markers).** Loom's side is empty: take
  upstream's (`VcsStatusBroadcaster.ts` hunk 1's new locks, `cliproxyApi.test.ts`
  hunk 2, `migrate-dev-db.ts` hunk 3's skipped tables, `AGENTS.md` hunk 4,
  `PreviewView.tsx` hunk 2, five lockfile hunks). Pull 12's DL-1203 warning
  holds: a "B" that is a Loom deletion against an upstream edit takes Loom's
  side; none of this week's ten is that (checked: each is new upstream code
  with no Loom counterpart). `AGENTS.md` hunk 4 is the exception by policy:
  upstream's GitCafe and "never make a PR" lines are dropped (§6.10).
- **Rule C: React Compiler shape.** `HomeRouteScreen.tsx` (upstream removed a
  `useCallback`; Loom's widening goes on the plain function) and mobile
  `CommandPalette.tsx` (Loom's `useMemo` is allowed on mobile:
  `allowMemoHooks: true`). No `useMemo`/`useCallback` in a web file (DL-1273).
- **Rule D: re-apply onto upstream's shape (64 content hunks with a side ≥ 20
  lines, in 49 files).** Method unchanged (DL-1222): resolve to upstream's
  side, re-apply Loom's delta for the region from `git diff b76a110aa4
  origin/main -- <file>` (the `loom` lines and minimal context) where the
  surrounding code now sits, then confirm per file that every `loom`-bearing
  line of `origin/main`'s version is present in the merged tree or named in a
  DL row. Files: `Orchestrator.ts`, `ProjectionStore.ts`, `ShellStream.ts`
  (§4), `serverSettings.ts`, `VcsStatusBroadcaster.ts`, `GitVcsDriverCore.ts`,
  `ProjectSetupScriptRunner.ts`, `client-runtime/state/shell.ts`,
  `connection/driver.ts`, `FilePreviewPanel.tsx`, `DiffPanel.tsx`,
  `ChatView.tsx`, `MessagesTimeline.tsx`, `ChatComposer.tsx`, `ChatMarkdown.tsx`,
  `TimelineUserMessageRow.tsx`, `useTimelinePositionRestore.ts`,
  `useComposerSend.ts`, `SettingsPanels.tsx`, `Sidebar.tsx`,
  `SidebarThreadRow.tsx`, `ThreadNotificationCoordinator.tsx`,
  `MarkdownThreadLink.tsx`, `routes/_chat.tsx`, `routes/__root.tsx`,
  `ThreadRouteView.tsx`, mobile `ThreadFeed.tsx`, `HomeRouteScreen.tsx`.
- **Rule T: test prune (21 markers in 19 files).** Pull 13 §5.2's five rules.
  Nothing was pruned en masse; each hunk is a Loom case beside an upstream
  rewrite. Keep Loom cases that guard Loom behaviour and compile on upstream's
  harness (`GitManager.test.ts` fork-PR batch, `VcsStatusBroadcaster.test.ts`
  repository batch, `externalLauncher.test.ts` Zed-over-SSH,
  `WorkspaceFileSystem.test.ts` `maxBytes`, `cliproxyApi.test.ts` hub login,
  `commandPermissions.test.ts` hub login, `ProviderRegistry.test.ts` Pi-only
  expectations, `shell.test.ts` workstream fields, `keybindings.test.ts` tab
  family); drop a Loom case that imports a de-exported name
  (`usageScanCache.test.ts` `encodeScanCache`); take upstream's new tests; the
  `ThreadSearch.test.ts` query-plan test is dropped with a marked note (§6.7).
- **Rule U: union.** The majority of the 254 content hunks are two unrelated
  edits to the same lines (an import list, a props list, a struct, a scope
  map). Both sides, Loom's lines marked. Appendix B says "union" where that is
  the whole resolution.

### 7.2 Server zones

| Area / file | Upstream change | Resolution |
| --- | --- | --- |
| `orchestration-v2/ShellStream.ts` (2) | #27106 index-based trims (§4) | S1: upstream's shape, Loom's three clauses re-applied in the two `…With` functions (mechanical); **S2a adds the index half** (§4.3). Gate 2a reads |
| `orchestration-v2/Orchestrator.ts` (7), `ProjectionStore.ts` (5), `ws.ts` (3), `http.ts` (1), `server.ts` (3) | §6.1; `Effect.fn` wrappers; side-chat `sideChatIds`; managed policy; `TriageService`, `RemoteDelegation`, `SecretResolver` layers | Rule D with §6.1's table; `ProjectionStore.ts` hunk 5 is the `layerMemory` deletion (take); `server.ts` keeps `ThreadSearchLoom.layer` (with `ThreadEmbedderLive`) where upstream provides `ThreadSearch.layer` and adds upstream's `SecretResolver.layer`; `ws.ts`'s three are unions on upstream's renamed locals |
| `orchestration-v2/ProviderSessionManager.ts` (1) + test (1), `ProviderEventIngestor.test.ts` (1), `ThreadSearch.test.ts` (1) | interrupt timeout (#27252); test harness changes | §6.1 read; Rule T; union; the query-plan test dropped (§6.7) |
| `auth/RpcAuthorization.ts` (1), `observability/RpcInstrumentation.ts` (1), `Observability.ts` (2) | new upstream ws methods (`peerLinks*`, force stop, side chats) | Rule A: Loom's `LOOM_WS_METHODS` rows stay (both maps are exhaustive by type, so an omission fails typecheck); `Observability.ts` unions |
| `orchestration-v2/ProjectionMaintenance.ts` (1) | comment | Rule A (DL-1300's set stays) |
| `persistence/Sqlite.ts` (1) | `temp_store = MEMORY` | Union with Loom's `cache_size` |
| `mcp/McpHttpServer.ts` (1), `OrchestratorMcpService.ts` (1), `toolkits/orchestrator/handlers.ts` (1) | `layerTools` list; `clientModeCeiling` rename; `schedule_task` `either` | Unions; `LoomToolkitRegistrationLive` inside `layerTools`; §5.1 for the handlers |
| `provider/builtInDrivers.ts` (2), `ProviderInstanceRegistryHydration.ts` (4), `ProviderRegistry.test.ts` (1), `ClaudeCapabilitiesProbe.test.ts` (1) | `fx`, ACP registry driver, secret resolver env | §6.5; Rule T |
| `vcs/VcsStatusBroadcaster.ts` (4) + test (1), `GitVcsDriverCore.ts` (2), `git/GitWorkflowService.ts` (1), `GitManager.test.ts` (1) | per-cwd `localRefreshLocks`/`withRemoteWriteLock`, `readRemoteStatus`, `defaultBranchCache`, `gitCommonDir` parameter | Loom's repository batch (DL-1221/DL-1413) re-applied onto upstream's new locks: the poller keeps its `repositoryKeyByCwdRef` lookups, upstream's lock wraps the remote read, `refreshLocalStatusCore` after it; `GitVcsDriverCore.ts` hunk 1 keeps both caches, hunk 2 threads Loom's repository-path resolution through the new `gitCommonDir` parameter; `GitWorkflowService.ts` keeps Loom's two batch operations. **Gate 1 reads** |
| `project/ProjectSetupScriptRunner.ts` (3) | `watchShellReadiness`, `echoedWrapperLines` | Rule D: Loom's setup-state writes, `completionShell`, `setupInstallCommand` inside upstream's readiness watcher |
| `serverSettings.ts` (5) + test (1) | secret providers; the materialisation memo | §6.1/§6.5: upstream's memo replaces Loom's; redaction and `resolveTextGenerationProvider` stay; DL row |
| `usage/cliproxyApi.test.ts` (2), `usageScanCache.test.ts` (1), `workspace/WorkspaceFileSystem.ts` (1) + test (1), `WorkspaceSearchIndex.ts` (1), `process/externalLauncher.test.ts` (1), `checkpointing/CheckpointStore.ts` (3), `relay/AgentAwarenessRelay.ts` (1) | small | Rule T / unions; `CheckpointStore.ts`: `refuseForeignHomeCwd` before upstream's re-signed `resolveCheckpoints` ×3; `AgentAwarenessRelay.ts`: `isLoomEventType` return above the side-chat arm |
| `packages/provider-pi/src/server/textGeneration.ts` (1), `packages/provider-core/src/server/managedProvider.ts` (1) | `message_end` turn error; one line | Unions |
| `packages/contracts/src/*` (6) and `packages/client-runtime/src/*` (5), `packages/shared/src/*` (2) | §6.3 (`providerRuntime.ts`), §6.5 (`settings.ts`), peer links, DPoP renewal | As Appendix B |
| config: `AGENTS.md` (5), `README.md` (4), `.gitignore` (1), `knip.jsonc` (2), `vite.config.ts` (1), `pnpm-workspace.yaml` (1), `pnpm-lock.yaml` (31), `apps/server/package.json` (2), `apps/web/package.json` (2), `scripts/dev-runner.ts` (2), `scripts/lib/cli-external-packages.test.ts` (1), `apps/server/scripts/migrate-dev-db.ts` (3), `docs/user/composer.md` (1) | see §6.10 | §6.10's table |

### 7.3 Web and mobile zones

| Area / file | Upstream change | Resolution |
| --- | --- | --- |
| `files/FilePreviewPanel.tsx` (14), `DiffPanel.tsx` (10), `preview/PreviewView.tsx` (5), `RightPanelTabs.tsx` (7) | §6.4 | §6.4; Gate 1 reads the first two |
| `ChatView.tsx` (9), `chat/MessagesTimeline.tsx` (6), `chat/ChatComposer.tsx` (4), `ChatMarkdown.tsx` (4), `chat/TimelineUserMessageRow.tsx` (3), `useTimelinePositionRestore.ts` (3), `useComposerMenuItems.ts` (3), `useComposerSend.ts` (1), `TimelineV2EventRow.tsx` (2), `ChatHeader.tsx` (2), `ComposerPendingUserInputPanel.tsx` (2), `MarkdownThreadLink.tsx` (2), `RightPanelSurfaceContent.tsx`, `UserMessageContextChips.tsx`, `useSystemComposerBanners.tsx`, `composerContextPresentation.tsx`, `ChatMarkdown.browser.test.tsx` | side chats, paging, end-state rows, simpler composer, force stop, thread links | Rule D / unions per Appendix B; `TimelineV2EventRow.tsx` per §6.3 (a) |
| `Sidebar.tsx` (4), `Sidebar.logic.ts` (2), `CommandPalette.tsx` (4), `CommandPalette.logic.ts` (3), `CommandPaletteThreadItems.tsx` (1), `ThreadNotificationCoordinator.tsx` (2), `ThreadRouteView.tsx` (2), `routes/__root.tsx` (2), `routes/_chat.tsx` (1) | side chats and `delegatedUnderParent` (§5.3), F6/keyboard sidebar (#25877), upstream cuts | Unions per §5.3; Rule D for the cuts; `CommandPalette.tsx` hunk 3 per §6.3 (a) |
| `sidebar/SidebarThreadRow.tsx` (5), `settings/SettingsPanels.tsx` (2), `settings/providerDriverMeta.ts` (1), `composer-logic.ts` (2), `rightPanelStore.ts` (3), `modelSelection.ts` (4), `index.css` (2), `files/FileBrowserPanel.tsx` (3), `files/{BrowserDocumentFrame,DelimitedTablePreview,FileMarkdownPreview}.tsx`, `NoProjectsHero.tsx`, `hooks/useThreadActionMenu.ts`, `contextMenuFallback.ts`, `lib/diffRendering.ts`, `reopenClosedView.ts`, `terminal-links.ts`, `versionSkew.ts`, `keybindings.test.ts` | small | Per Appendix B; Appendix D for the two moves |
| mobile (6) | §6.10 | Unions; Rule C on `HomeRouteScreen.tsx` |

### 7.4 New upstream directories: take verbatim

`apps/server/src/peer/` (linked environments), `apps/server/src/policy/`,
`apps/server/src/secrets/`, `apps/server/src/triage/`, `packages/provider-fx/`,
`packages/secret-provider-*/`, `apps/web/src/components/chat/SideChatPane.tsx`
and `useSideChat.ts`, `apps/mobile/src/features/threads/ThreadSideChatsRow.tsx`,
`packages/client-runtime/src/providerClients.ts` (then Appendix D's one marked
move), `packages/shared/src/managedPolicyFile.ts`, the `patches/` additions.
