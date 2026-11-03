# 39: Clean-overlap zones for Gate 2 (pull 14)

Written by S3 (thread `thread:mcp:54c7fda3-ec09-4f4e-a6f2-14730a0be3b8:workstream-scaffold:625806ab-e8b8-4c53-89f7-549063802672:4`).
The 180 files both sides changed that merged without a marker (runbook Appendix C, re-verified by S3 with `git merge-tree` of `7761af6555` × `fa31b66bbb`: the same 123 conflicted paths and exactly these 180 silent ones), partitioned for the four Gate 2 reviewers by §9's Gate 2 row, plus the extra reads that row names.

Columns: **`loom:`** is the count of `loom:` markers in the merged file (Appendix C's `L` counts any line mentioning `loom`, a superset); **DL rows** are the S1/S2 decision-log rows (DL-1600–1689) that name the file. A Loom-only file shows 0 markers because the whole file is Loom's. Dispositions go in `clean-overlap-review.md` (doc 29 method).

## 2a: server core and MCP seams (37 files, 136 `loom:` markers)

**Read first.** The index-based cold shell (§4.3, DL-1650: the `listActiveShellIndex` join in `ProjectionStore.ts` and `keepsLoomEntryInColdShell` in `loomShellJoin.ts`, called from `ShellStream.ts`); the linked-environment caller path (§5.2: `McpInvocationContext.ts`, `RemoteDelegation.ts`, `DelegatedTaskQuestionReactor.ts`, `ProviderSessionManager.ts`'s Loom lines against #16695's `linkOrigin`); side-chat lineage beside Loom's `role` overlay (`ThreadForkService.ts`, `ProviderTurnStartService.ts`; DL-1616, DL-1652); the interrupt-timeout path (§6.1). S2a's review also asks for `ProviderSessionManager.ts`'s `filterOrElse`/`Option.getOrThrow` subagent clause.

### Extra reads (§9 Gate 2 row; not in Appendix C)

| File | `loom:` | DL rows |
| --- | ---: | --- |
| `apps/server/src/orchestration-v2/ShellStream.ts` | 9 | DL-1650 |
| `apps/server/src/loom/projection/loomShellJoin.ts` | 0 | DL-1650 (Loom-only) |
| `apps/server/src/orchestration-v2/ProjectionStore.ts` | 23 | DL-1650 (`listActiveShellIndex`) |
| `apps/server/src/orchestration-v2/ThreadForkService.ts` | 0 | DL-1616 |
| `apps/server/src/peer/RemoteDelegation.ts` | 0 | — |
| `apps/server/src/orchestration-v2/DelegatedTaskQuestionReactor.ts` | 0 | — |

### server-core (30)

| File | `loom:` | DL rows |
| --- | ---: | --- |
| `apps/server/src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts` | 17 | — |
| `apps/server/src/orchestration-v2/CheckpointService.ts` | 10 | — |
| `apps/server/src/orchestration-v2/ThreadSettlementService.ts` | 9 | — |
| `apps/server/src/serverRuntimeStartup.test.ts` | 9 | — |
| `apps/server/src/serverRuntimeStartup.ts` | 7 | — |
| `apps/server/src/orchestration-v2/ProviderTurnStartService.ts` | 6 | DL-1652 |
| `apps/server/src/orchestration-v2/runtimeLayer.ts` | 6 | — |
| `apps/server/src/cli/config.ts` | 5 | — |
| `apps/server/src/orchestration-v2/ThreadSearch.ts` | 5 | — |
| `apps/server/src/serverRuntimeStartup.autoPull.test.ts` | 5 | — |
| `apps/server/src/orchestration-v2/PullRequestWatchReactor.ts` | 4 | — |
| `apps/server/src/auth/SessionStore.ts` | 3 | — |
| `apps/server/src/orchestration-v2/CheckpointCaptureService.test.ts` | 3 | DL-1657 |
| `apps/server/src/orchestration-v2/ProviderEventIngestor.ts` | 3 | — |
| `apps/server/src/orchestration-v2/runtimeLayer.test.ts` | 3 | — |
| `apps/server/src/orchestration-v2/testkit/ProviderReplayHarness.ts` | 3 | — |
| `apps/server/src/orchestration-v2/EffectWorker.ts` | 2 | — |
| `apps/server/src/orchestration-v2/ProjectSettingsUpgrade.integration.test.ts` | 2 | — |
| `apps/server/src/orchestration-v2/ProviderTurnControlService.ts` | 2 | — |
| `apps/server/src/orchestration-v2/RestartContinuation.ts` | 2 | — |
| `apps/server/src/orchestration-v2/ThreadManagementService.ts` | 2 | — |
| `apps/server/src/orchestration-v2/ThreadSettlementService.test.ts` | 2 | — |
| `apps/server/src/orchestration-v2/http.test.ts` | 2 | — |
| `apps/server/src/orchestration-v2/testkit/OrchestratorScenario.ts` | 2 | — |
| `apps/server/src/cli/server.ts` | 1 | — |
| `apps/server/src/orchestration-v2/Orchestrator.control-reads.test.ts` | 1 | — |
| `apps/server/src/orchestration-v2/ProjectionControlReads.test.ts` | 1 | — |
| `apps/server/src/orchestration-v2/RunCompletionReads.test.ts` | 1 | — |
| `apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.ts` | 1 | — |
| `apps/server/src/orchestration-v2/testkit/fixtures/thread_rollback_after_stop/pi_transcript.ndjson` | 0 | — |

### server-provider/mcp (7)

| File | `loom:` | DL rows |
| --- | ---: | --- |
| `apps/server/src/provider/ClaudeProvider.ts` | 8 | — |
| `apps/server/src/mcp/McpSessionRegistry.ts` | 4 | — |
| `apps/server/src/mcp/McpInvocationContext.ts` | 1 | — |
| `apps/server/src/mcp/toolkits/pullRequests/handlers.ts` | 1 | — |
| `apps/server/src/mcp/toolkits/thread/tools.ts` | 1 | — |
| `apps/server/src/provider/ProviderInstanceRegistry.test.ts` | 1 | — |
| `apps/server/src/provider/providerCompatibility.test.ts` | 1 | — |

## 2b: server other, provider packages, persistence (41 files, 196 `loom:` markers)

**Read first.** The Pi adapter's interrupt path under #27252 (`packages/provider-pi/src/server/adapter.ts`, 82 `loom` lines); `mcpExtensionSource.ts` (DL-905: still no orchestration instructions); `DatabaseMaintenance.ts` (both index rebuilds after VACUUM); `ProjectionMaintenance.ts` (DL-1300's history guard; S3 measured it on the cockpit copy). S2a's review also names the `VcsStatusBroadcaster.ts` poller sleeps (`Queue.take(wake)` + `timeoutOrElse`) and the unused `_demandCwd` parameter (DL-1614, DL-1655, DL-1656); those files are conflicted, not silent, but sit in this reviewer's area.

### Extra reads (§9 Gate 2 row; not in Appendix C)

| File | `loom:` | DL rows |
| --- | ---: | --- |
| `apps/server/src/orchestration-v2/ProjectionMaintenance.ts` | 3 | pull 12 DL-1300 |

### server-other (25)

| File | `loom:` | DL rows |
| --- | ---: | --- |
| `apps/server/src/usage/cliproxyApi.ts` | 21 | — |
| `apps/server/src/project/ProjectService.ts` | 11 | — |
| `apps/server/src/ws.test.ts` | 11 | — |
| `apps/server/integration/transferBudgetV2.integration.test.ts` | 6 | — |
| `apps/server/src/assets/AssetAccess.ts` | 6 | — |
| `apps/server/src/project/ProjectService.test.ts` | 6 | — |
| `apps/server/src/terminal/Manager.ts` | 5 | — |
| `apps/server/src/assets/AssetAccess.test.ts` | 4 | — |
| `apps/server/src/binCli.ts` | 4 | — |
| `apps/server/src/terminal/Manager.test.ts` | 4 | — |
| `apps/server/scripts/migrate-dev-db.test.ts` | 2 | DL-1625 |
| `apps/server/src/git/GitManager.ts` | 2 | — |
| `apps/server/src/http.test.ts` | 2 | — |
| `apps/server/src/process/externalLauncher.ts` | 2 | — |
| `apps/server/src/project/ProjectSetupScriptRunner.test.ts` | 2 | — |
| `apps/server/src/project/RepositoryIdentityResolver.test.ts` | 2 | — |
| `apps/server/src/vcs/GitVcsDriver.ts` | 2 | — |
| `apps/server/src/workspace/WorkspaceEntries.ts` | 2 | — |
| `apps/server/src/cloud/ManagedEndpointRuntime.ts` | 1 | — |
| `apps/server/src/http.ts` | 1 | — |
| `apps/server/src/keybindings.test.ts` | 1 | DL-1658 |
| `apps/server/src/storageCleanup.ts` | 1 | — |
| `apps/server/src/usage/usageScanCache.ts` | 1 | — |
| `apps/server/src/vcs/GitVcsDriverCore.test.ts` | 1 | — |
| `apps/server/src/workspace/WorkspaceEntries.test.ts` | 1 | — |

### provider-packages (13)

| File | `loom:` | DL rows |
| --- | ---: | --- |
| `packages/provider-pi/src/server/adapter.ts` | 47 | — |
| `packages/provider-pi/src/server/mcpExtensionSource.ts` | 17 | — |
| `packages/provider-pi/src/server/mcpInjection.ts` | 7 | — |
| `packages/provider-core/src/server/ProviderAdapter.ts` | 4 | — |
| `packages/provider-pi/src/server/mcpExtensionSource.test.ts` | 3 | — |
| `packages/provider-pi/src/server/rpc.ts` | 2 | — |
| `packages/provider-pi/src/server/status.ts` | 2 | — |
| `packages/provider-pi/src/server/textGeneration.test.ts` | 2 | — |
| `packages/provider-testing/src/fakeCli.ts` | 2 | — |
| `packages/provider-core/src/server/managedProvider.test.ts` | 1 | — |
| `packages/provider-core/src/server/snapshot.ts` | 1 | — |
| `packages/provider-opencode/src/server/OpenCodeRuntime.ts` | 1 | — |
| `packages/provider-pi/src/server/adapter.test.ts` | 1 | — |

### server-persistence (3)

| File | `loom:` | DL rows |
| --- | ---: | --- |
| `apps/server/src/persistence/DatabaseMaintenance.ts` | 2 | — |
| `apps/server/src/persistence/initializeV2Database.test.ts` | 2 | — |
| `apps/server/src/persistence/DatabaseMaintenance.test.ts` | 1 | — |

## 2c: web and client-runtime (62 files, 168 `loom:` markers)

**Read first.** `loomTimelineRows.ts` against bounded history pages (#26240: `threadHistoryPaging.ts` on the server, `threadHistoryController.ts`/`threadHistoryMerge.ts` in client-runtime; Loom rows spliced above the first loaded page?); DL-1674 (`modelSelection.ts`, conflicted, but its test file is here) and DL-1676's two removed effects; the `HtmlBlock` frame height S2b flagged for S4 (DL-1680).

### Extra reads (§9 Gate 2 row; not in Appendix C)

| File | `loom:` | DL rows |
| --- | ---: | --- |
| `apps/web/src/loom/loomTimelineRows.ts` | 1 | — |
| `apps/server/src/orchestration-v2/threadHistoryPaging.ts` | 0 | — |
| `packages/client-runtime/src/state/threadHistoryController.ts` | 0 | — |
| `packages/client-runtime/src/state/threadHistoryMerge.ts` | 0 | — |

### web-panels/other (33)

| File | `loom:` | DL rows |
| --- | ---: | --- |
| `apps/web/src/rightPanelStore.test.ts` | 15 | — |
| `apps/web/src/modelSelection.test.ts` | 10 | — |
| `apps/web/src/lib/composerContextRecords.ts` | 7 | — |
| `apps/web/src/components/settings/ProviderModelsSection.tsx` | 6 | — |
| `apps/web/src/components/ui/toast.tsx` | 6 | — |
| `apps/web/src/components/settings/ProviderSettingsPanel.tsx` | 5 | — |
| `apps/web/src/components/files/projectFilesQueryState.ts` | 4 | — |
| `apps/web/src/components/usage/UsageLimitsPooled.tsx` | 4 | — |
| `apps/web/src/reopenClosedView.test.ts` | 4 | — |
| `apps/web/src/closedViewStore.ts` | 3 | — |
| `apps/web/src/components/ReopenClosedViewShortcut.browser.test.tsx` | 3 | — |
| `apps/web/src/components/pullRequest/pullRequestDetail.logic.ts` | 3 | — |
| `apps/web/src/diffPanelStore.ts` | 3 | — |
| `apps/web/src/hooks/useThreadActionMenu.test.ts` | 3 | — |
| `apps/web/vite.config.ts` | 3 | DL-1627, DL-1678 |
| `apps/web/src/components/settings/ProviderInstanceCard.tsx` | 2 | — |
| `apps/web/src/components/usage/UsagePage.tsx` | 2 | — |
| `apps/web/src/state/threads.ts` | 2 | — |
| `apps/web/src/closedViewStore.test.ts` | 1 | — |
| `apps/web/src/components/DiffWorkerPoolProvider.tsx` | 1 | — |
| `apps/web/src/components/GitActionsControl.tsx` | 1 | — |
| `apps/web/src/components/files/filePreviewMode.ts` | 1 | — |
| `apps/web/src/components/preview/PreviewView.browser.test.tsx` | 1 | — |
| `apps/web/src/components/pullRequest/PullRequestCodeTab.tsx` | 1 | — |
| `apps/web/src/components/pullRequest/pullRequestDetail.logic.test.ts` | 1 | — |
| `apps/web/src/components/pullRequest/pullRequestList.logic.ts` | 1 | — |
| `apps/web/src/components/settings/ProviderSettingsPanel.environment.browser.test.tsx` | 1 | — |
| `apps/web/src/components/ui/sidebar.tsx` | 1 | — |
| `apps/web/src/composer-logic.test.ts` | 1 | — |
| `apps/web/src/hooks/useThreadActions.ts` | 1 | — |
| `apps/web/src/keybindings.ts` | 1 | — |
| `apps/web/src/state/entities.ts` | 1 | — |
| `apps/web/src/routeTree.gen.ts` | 0 | — |

### web-chat (17)

| File | `loom:` | DL rows |
| --- | ---: | --- |
| `apps/web/src/components/chat/MarkdownCodeBlock.tsx` | 8 | DL-1627 |
| `apps/web/src/components/chat/MessagesTimeline.logic.ts` | 6 | — |
| `apps/web/src/components/chat/ModelPickerContent.tsx` | 6 | — |
| `apps/web/src/components/chat/ComposerFooterControls.tsx` | 4 | — |
| `apps/web/src/components/chat/OpenInPicker.tsx` | 4 | — |
| `apps/web/src/components/ChatMarkdown.permissions.browser.test.tsx` | 3 | — |
| `apps/web/src/components/chat/MarkdownFileLink.tsx` | 3 | — |
| `apps/web/src/components/chat/timelineMinimapItems.ts` | 3 | — |
| `apps/web/src/components/chat/TimelineAssistantRows.tsx` | 2 | — |
| `apps/web/src/session-logic.ts` | 2 | — |
| `apps/web/src/components/chat/ComposerCommandMenu.tsx` | 1 | — |
| `apps/web/src/components/chat/ComposerPendingUserInputPanel.navigation.browser.test.tsx` | 1 | — |
| `apps/web/src/components/chat/SkillInlineText.tsx` | 1 | — |
| `apps/web/src/components/chat/composerFocusRedirect.ts` | 1 | — |
| `apps/web/src/components/chat/providerIconUtils.ts` | 1 | — |
| `apps/web/src/composerDraftStore.test.ts` | 1 | — |
| `apps/web/src/composerDraftStore.ts` | 1 | — |

### web-sidebar (2)

| File | `loom:` | DL rows |
| --- | ---: | --- |
| `apps/web/src/routes/_chat.index.tsx` | 3 | — |
| `apps/web/src/components/sidebar/SidebarChrome.tsx` | 2 | — |

### client-runtime (10)

| File | `loom:` | DL rows |
| --- | ---: | --- |
| `packages/client-runtime/src/connection/presentation.ts` | 3 | — |
| `packages/client-runtime/src/rpc/client.ts` | 2 | — |
| `packages/client-runtime/src/state/orchestrationV2Projection.ts` | 2 | — |
| `packages/client-runtime/src/state/projectCommands.ts` | 2 | — |
| `packages/client-runtime/src/state/threadSearch.test.ts` | 2 | — |
| `packages/client-runtime/src/rpc/session.test.ts` | 1 | — |
| `packages/client-runtime/src/state/archivedThreads.ts` | 1 | — |
| `packages/client-runtime/src/state/models.ts` | 1 | — |
| `packages/client-runtime/src/state/server.test.ts` | 1 | — |
| `packages/client-runtime/src/state/sharedSettings.test.ts` | 1 | — |

## 2d: contracts, shared, mobile, desktop, config and docs (40 files, 123 `loom:` markers)

**Read first.** Mostly mechanical: Loom's fields in contracts (`rpc.ts`, `server.ts`, `project.ts`, `settings.test.ts`), shared (`usageLimits.ts` 24 `loom` lines, `composerContextReferences.ts`, DL-1659), the two `package.json` subpath maps, `scripts/dev-runner.test.ts` (DL-1608), and the docs pages that mention Loom.

### contracts (9)

| File | `loom:` | DL rows |
| --- | ---: | --- |
| `packages/contracts/src/project.ts` | 9 | DL-1653 |
| `packages/contracts/src/server.ts` | 9 | — |
| `packages/contracts/src/rpc.ts` | 8 | — |
| `packages/contracts/src/settings.test.ts` | 8 | — |
| `packages/contracts/src/composerContext.ts` | 3 | — |
| `packages/contracts/src/index.ts` | 3 | — |
| `packages/contracts/src/keybindings.ts` | 3 | — |
| `packages/contracts/src/baseSchemas.ts` | 2 | — |
| `packages/contracts/src/composerContext.test.ts` | 2 | — |

### shared (9)

| File | `loom:` | DL rows |
| --- | ---: | --- |
| `packages/shared/src/usageLimits.ts` | 19 | DL-1627 |
| `packages/shared/src/composerContextReferences.ts` | 7 | DL-1659 |
| `packages/shared/src/serverSettings.ts` | 5 | DL-1606, DL-1612, DL-1659 |
| `packages/shared/src/serverSettings.test.ts` | 4 | DL-1656 |
| `packages/shared/src/toolOutput.ts` | 3 | — |
| `packages/shared/src/keybindings.ts` | 2 | — |
| `packages/shared/src/usageLimits.test.ts` | 2 | — |
| `packages/shared/src/String.ts` | 1 | — |
| `packages/shared/src/shell.ts` | 1 | DL-1613 |

### mobile (6)

| File | `loom:` | DL rows |
| --- | ---: | --- |
| `apps/mobile/src/features/threads/ThreadNavigationSidebar.tsx` | 4 | — |
| `apps/mobile/src/features/home/HomeScreen.tsx` | 2 | — |
| `apps/mobile/src/features/usage/UsageLimitsPooled.tsx` | 2 | — |
| `apps/mobile/src/features/files/ThreadFilesRouteScreen.tsx` | 1 | — |
| `apps/mobile/src/features/layout/AdaptiveWorkspaceLayout.tsx` | 1 | — |
| `apps/mobile/src/state/use-composer-drafts.ts` | 0 | — |

### desktop (3)

| File | `loom:` | DL rows |
| --- | ---: | --- |
| `apps/desktop/src/preview/Manager.test.ts` | 2 | — |
| `apps/desktop/src/preview/Manager.ts` | 1 | — |
| `apps/desktop/src/settings/DesktopClientSettings.test.ts` | 1 | — |

### docs/config (8)

| File | `loom:` | DL rows |
| --- | ---: | --- |
| `docs/user/source-control.md` | 3 | — |
| `docs/README.md` | 1 | — |
| `docs/operations/development.md` | 1 | — |
| `docs/user/keybindings.md` | 1 | DL-1625 |
| `docs/user/providers-claude.md` | 1 | — |
| `docs/user/thread-sidebar.md` | 1 | — |
| `docs/user/usage.md` | 1 | — |
| `third-party-licenses.config.json` | 0 | — |

### root/config/scripts (5)

| File | `loom:` | DL rows |
| --- | ---: | --- |
| `scripts/dev-runner.test.ts` | 8 | — |
| `scripts/lib/cli-external-packages.ts` | 1 | — |
| `package.json` | 0 | — |
| `packages/client-runtime/package.json` | 0 | — |
| `packages/shared/package.json` | 0 | — |
