# 40: Clean-overlap zones for Gate 2 (pull 15)

Written by S3 (thread `thread:mcp:3036341c-9850-44b1-899a-19e68df893ad:workstream-scaffold:278da6ed-2383-4add-bb06-88d7c678f5c9:0`).
The 187 files both sides changed that merged without a marker (runbook Appendix C, re-verified by S3 with `git merge-tree` of the merge's parents `bc726f4d27` × `3fa57b92a2`: the same 74 conflicted paths as Appendix B and exactly these 187 silent ones), partitioned for the four Gate 2 reviewers by §9's Gate 2 row, plus the extra reads that row and Appendix C name.

Columns: **`loom:`** is the count of `loom:` markers in the merged file as of S3 (Appendix C's `L` counts any line mentioning `loom`, a superset); **DL rows** are the pull 15 decision-log rows that name the file by path or unique basename. A Loom-only file shows 0 markers because the whole file is Loom's; most silent files have no DL row because nobody touched them after the merge. Dispositions go in `clean-overlap-review.md` (doc 29 method: one disposition per file, every DEFECT fixed before S4).

## 2a: server core and MCP seams (38 files, 197 `loom:` markers)

**Read first.** `ProjectionMaintenance.ts`'s two marked guard clauses against §4.1's SQL (DL-1811; S3 proved them on the cockpit copy, `s3-record.md`) with the prune mark and the pruned-through boundary in `OrchestrationEventStore.ts` and the loop and `compacted-at` breadcrumb in `DatabaseStorage.ts`; `ThreadSettlementService.ts` (23 `loom` lines, §6.6: Loom's settle rules with #527 and DL-1705 beside upstream's #20058 snooze change); `PullRequestWatchReactor.ts` (the `GROUP_READS` semaphore); `ProviderTurnStartService.ts` (+48 upstream); `McpHttpServer.ts`'s `provideRegistrationServices` against the Loom tool families; `RestartContinuation.ts` and `RestartContinuation.test.ts` with `freshContext` and DL-1708's steer stash; `RpcAuthorization.ts` (18) and `RpcInstrumentation.ts` (24), whose exhaustive maps compile only when every upstream ws method has an entry; `ws.test.ts` (upstream's 237-line replay rewrite, DL-1836); `LegacyV1ThreadImporter.ts` (17; its `thread.created` marker is why pruning keeps that row).

### Extra reads (named by §9's Gate 2 row or Appendix C; outside the 187)

| File | `loom:` | DL rows |
| --- | ---: | --- |
| `apps/server/src/persistence/OrchestrationEventStore.ts` | 0 | — |
| `apps/server/src/persistence/DatabaseStorage.ts` | 0 | — |
| `apps/server/src/orchestration-v2/ProjectionMaintenance.ts` | 3 | DL-1803, DL-1811, DL-1823 |
| `apps/server/src/mcp/McpHttpServer.ts` | 2 | — |
| `apps/server/src/orchestration-v2/RestartContinuation.ts` | 3 | — |
| `apps/server/src/telemetry/ProviderUsageAnalytics.ts` | 0 | — |
| `apps/server/src/scheduledTasks/ScheduledTaskService.ts` | 0 | — |
| `apps/server/src/orchestration-v2/ThreadForkService.ts` | 0 | — |
| `apps/server/src/orchestration-v2/DelegatedTaskQuestionReactor.ts` | 0 | — |

### server-core (30)

| File | `loom:` | DL rows |
| --- | ---: | --- |
| `apps/server/src/observability/RpcInstrumentation.ts` | 16 | — |
| `apps/server/src/orchestration-v2/ThreadSettlementService.ts` | 18 | — |
| `apps/server/src/auth/RpcAuthorization.ts` | 18 | — |
| `apps/server/src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts` | 17 | — |
| `apps/server/src/serverRuntimeStartup.test.ts` | 9 | — |
| `apps/server/src/ws.test.ts` | 15 | DL-1836 |
| `apps/server/src/orchestration-v2/ThreadSearch.ts` | 5 | — |
| `apps/server/src/serverRuntimeStartup.ts` | 7 | — |
| `apps/server/integration/transferBudgetV2.integration.test.ts` | 6 | — |
| `apps/server/src/orchestration-v2/runtimeLayer.ts` | 6 | — |
| `apps/server/src/orchestration-v2/ProviderTurnStartService.ts` | 6 | — |
| `apps/server/src/binCli.ts` | 4 | — |
| `apps/server/src/orchestration-v2/PullRequestWatchReactor.ts` | 4 | — |
| `apps/server/src/orchestration-v2/runtimeLayer.test.ts` | 4 | — |
| `apps/server/src/auth/SessionStore.ts` | 3 | — |
| `apps/server/src/orchestration-v2/CheckpointCaptureService.test.ts` | 4 | DL-1836 |
| `apps/server/src/orchestration-v2/ProjectSettingsUpgrade.integration.test.ts` | 2 | — |
| `apps/server/src/orchestration-v2/ProviderEventIngestor.test.ts` | 3 | — |
| `apps/server/src/orchestration-v2/ProviderEventIngestor.ts` | 3 | — |
| `apps/server/src/orchestration-v2/http.ts` | 2 | — |
| `apps/server/src/orchestration-v2/legacy/LegacyV1Cutover.integration.test.ts` | 2 | — |
| `apps/server/src/orchestration-v2/testkit/ProviderReplayHarness.ts` | 3 | — |
| `apps/server/src/orchestration-v2/CheckpointService.test.ts` | 2 | — |
| `apps/server/src/orchestration-v2/Orchestrator.control-reads.test.ts` | 2 | — |
| `apps/server/src/orchestration-v2/RestartContinuation.test.ts` | 2 | — |
| `apps/server/src/orchestration-v2/ThreadManagementService.ts` | 2 | — |
| `apps/server/src/orchestration-v2/testkit/OrchestratorScenario.ts` | 2 | — |
| `apps/server/src/relay/AgentAwarenessRelay.ts` | 2 | — |
| `apps/server/src/http.ts` | 1 | — |
| `apps/server/src/orchestration-v2/EffectWorker.ts` | 2 | — |

### server-provider/mcp (8)

| File | `loom:` | DL rows |
| --- | ---: | --- |
| `apps/server/src/mcp/McpSessionRegistry.test.ts` | 8 | — |
| `apps/server/src/provider/ClaudeProvider.ts` | 8 | — |
| `apps/server/src/mcp/McpSessionRegistry.ts` | 4 | — |
| `apps/server/src/mcp/toolkits/thread/tools.ts` | 1 | — |
| `apps/server/src/mcp/McpInvocationContext.ts` | 1 | — |
| `apps/server/src/mcp/toolkits/pullRequests/handlers.ts` | 1 | — |
| `apps/server/src/provider/ProviderInstanceRegistry.test.ts` | 1 | — |
| `apps/server/src/provider/providerCompatibility.test.ts` | 1 | — |

## 2b: server other, provider packages, persistence (38 files, 118 `loom:` markers)

**Read first.** The Pi adapter's `sendPrompt` hold and teardown in `packages/provider-pi/src/server/adapter.ts` against `apps/server/src/loom/steering/pendingSteering.ts`; `driver.ts` (8); `Sqlite.ts` (the WAL limit beside Loom's `cache_size`); `DatabaseMaintenance.ts` (`t3 doctor compact` now calls `pruneEventStore` directly, no verify around it, and still rebuilds Loom's thread-search index after VACUUM); the `SecureRandom`/`Digest` swaps (DL-1830: `cli/goal.ts`, `handoffDraft.ts`, `retroDraft.ts`, `documentQuery.ts`, `workstream/brief.ts`, `wsMethods.ts`, `idempotency.ts`, the test layers); `GitManager.ts` and `GitVcsDriverCore.ts` (DL-1615, DL-1831's `remoteStatuses` re-home); `ProjectService.ts` (12).

### Extra reads (named by §9's Gate 2 row or Appendix C; outside the 187)

| File | `loom:` | DL rows |
| --- | ---: | --- |
| `packages/provider-pi/src/server/adapter.ts` | 47 | — |
| `apps/server/src/loom/steering/pendingSteering.ts` | 0 | — |
| `apps/server/src/persistence/testkit/SqliteRouting.ts` | 0 | — |

### server-other (24)

| File | `loom:` | DL rows |
| --- | ---: | --- |
| `apps/server/src/project/ProjectService.ts` | 11 | — |
| `apps/server/src/vcs/GitVcsDriverCore.ts` | 9 | — |
| `apps/server/src/checkpointing/CheckpointDiffQuery.ts` | 3 | — |
| `apps/server/src/project/ProjectService.test.ts` | 7 | — |
| `apps/server/src/assets/AssetAccess.test.ts` | 6 | — |
| `apps/server/src/assets/AssetAccess.ts` | 6 | — |
| `apps/server/src/terminal/Manager.ts` | 5 | — |
| `apps/server/src/vcs/VcsStatusBroadcaster.test.ts` | 5 | DL-1831 |
| `apps/server/src/workspace/WorkspaceEntries.ts` | 2 | — |
| `apps/server/src/git/GitManager.ts` | 4 | DL-1831 |
| `apps/server/src/terminal/Manager.test.ts` | 4 | — |
| `apps/server/src/workspace/WorkspaceSearchIndex.ts` | 4 | — |
| `apps/server/src/cloud/ManagedEndpointRuntime.ts` | 1 | — |
| `apps/server/src/project/ProjectService.deletion.test.ts` | 3 | — |
| `apps/server/src/workspace/WorkspaceFileSystem.test.ts` | 3 | — |
| `apps/server/src/git/GitManager.test.ts` | 2 | DL-1831 |
| `apps/server/src/project/ProjectSetupScriptRunner.test.ts` | 2 | — |
| `apps/server/src/project/RepositoryIdentityResolver.test.ts` | 2 | — |
| `apps/server/src/usage/usageScanCache.test.ts` | 1 | — |
| `apps/server/src/vcs/GitVcsDriverCore.test.ts` | 2 | — |
| `apps/server/src/process/externalLauncher.test.ts` | 1 | — |
| `apps/server/src/storageCleanup.ts` | 1 | — |
| `apps/server/src/usage/usageScanCache.ts` | 1 | — |
| `apps/server/src/workspace/WorkspaceEntries.test.ts` | 1 | — |

### provider-packages (9)

| File | `loom:` | DL rows |
| --- | ---: | --- |
| `packages/provider-pi/src/server/driver.ts` | 8 | — |
| `packages/provider-core/src/server/ProviderAdapter.ts` | 4 | — |
| `packages/provider-core/src/server/notification.ts` | 2 | — |
| `packages/provider-pi/package.json` | 0 | — |
| `packages/provider-core/src/server/textGenerationPrompts.ts` | 2 | — |
| `packages/provider-pi/src/server/adapter.test.ts` | 1 | — |
| `packages/provider-pi/src/server/rpc.ts` | 2 | — |
| `packages/provider-testing/src/fakeCli.ts` | 2 | — |
| `packages/provider-opencode/src/server/OpenCodeRuntime.ts` | 1 | — |

### server-persistence (5)

| File | `loom:` | DL rows |
| --- | ---: | --- |
| `apps/server/src/persistence/Sqlite.ts` | 4 | — |
| `apps/server/src/persistence/initializeV2Database.test.ts` | 2 | — |
| `apps/server/src/persistence/DatabaseMaintenance.ts` | 2 | — |
| `apps/server/src/persistence/DatabaseMaintenance.test.ts` | 1 | — |
| `apps/server/src/persistence/Migrations.test.ts` | 1 | — |

## 2c: web and client-runtime (62 files, 303 `loom:` markers)

**Read first.** `MessagesTimeline.logic.ts`'s Labs tool-call visibility filter (§6.5 (c)) against `insertLoomTimelineRows` (`apps/web/src/loom/loomTimelineRows.ts`): Loom's spliced rows must land after the filter; `useComposerSend.ts` (DL-1725's toast removal survived, `/clear` send); `composerDraftStore.ts` and `packages/shared/src/model.ts` (DL-1720's area); `composerContextPresentation.tsx` (§6.5 (a): `ComposerContextActionsContext` now imported from `composerContextActions.ts`, Loom's promoted-link line under it); `TimelineUserMessageRow.tsx` (DL-1860's `loomBubble` through `UserMessageContent`); `ChatMarkdown.tsx` (31), `MessagesTimeline.tsx` (40); `DiffPanel.tsx` (28; DL-1621), `rightPanelStore.ts` (31), `index.css` (33); `Sidebar.logic.ts` (§6.5 (a): the working-shelf predicate upstream inlined); `CommandPaletteThreadItems.tsx` (10); client-runtime `threadRequests.ts`, `orchestrationV2Projection.ts`, `providerClients.ts` (pi leads) and upstream's `threadTagFilter.ts` beside Loom's sections.

### Extra reads (named by §9's Gate 2 row or Appendix C; outside the 187)

| File | `loom:` | DL rows |
| --- | ---: | --- |
| `apps/web/src/loom/loomTimelineRows.ts` | 1 | — |
| `apps/web/src/components/chat/freshSessionArms.ts` | 0 | — |
| `packages/client-runtime/src/state/threadTagFilter.ts` | 0 | — |

### web-chat (16)

| File | `loom:` | DL rows |
| --- | ---: | --- |
| `apps/web/src/components/chat/MessagesTimeline.tsx` | 30 | — |
| `apps/web/src/components/ChatMarkdown.tsx` | 25 | — |
| `apps/web/src/components/chat/TimelineUserMessageRow.tsx` | 14 | DL-1826, DL-1860 |
| `apps/web/src/components/chat/MessagesTimeline.logic.ts` | 10 | — |
| `apps/web/src/components/chat/useComposerSend.ts` | 7 | — |
| `apps/web/src/components/chat/RightPanelSurfaceContent.tsx` | 5 | — |
| `apps/web/src/components/chat/TimelineWorkGroupRows.tsx` | 6 | — |
| `apps/web/src/components/composerContextPresentation.tsx` | 7 | — |
| `apps/web/src/components/chat/ChatComposer.tsx` | 6 | — |
| `apps/web/src/components/chat/ChatMarkdownMedia.tsx` | 6 | — |
| `apps/web/src/components/chat/ComposerFooterControls.tsx` | 4 | — |
| `apps/web/src/components/chat/ContextWindowMeter.tsx` | 4 | — |
| `apps/web/src/components/chat/ThreadNow.tsx` | 5 | — |
| `apps/web/src/components/chat/MarkdownFileLink.tsx` | 3 | — |
| `apps/web/src/components/chat/TimelineAssistantRows.tsx` | 4 | — |
| `apps/web/src/components/chat/TimelineWorkEntryRow.tsx` | 2 | — |

### web-panels/other (31)

| File | `loom:` | DL rows |
| --- | ---: | --- |
| `apps/web/src/index.css` | 26 | — |
| `apps/web/src/rightPanelStore.ts` | 30 | — |
| `apps/web/src/components/DiffPanel.tsx` | 20 | — |
| `apps/web/src/components/settings/ProviderSettingsPanel.tsx` | 5 | — |
| `apps/web/src/lib/composerContextRecords.ts` | 7 | — |
| `apps/web/src/reviewCommentContext.ts` | 6 | — |
| `apps/web/src/components/settings/SettingsPanels.tsx` | 4 | — |
| `apps/web/src/keybindings.test.ts` | 1 | — |
| `apps/web/src/routes/_chat.index.tsx` | 3 | — |
| `apps/web/src/lib/composerContextRecords.test.ts` | 5 | DL-1826, DL-1860, DL-1862 |
| `apps/web/vite.config.ts` | 4 | — |
| `apps/web/src/hooks/useThreadActions.ts` | 1 | — |
| `apps/web/src/components/pullRequest/pullRequestDetail.logic.test.ts` | 4 | DL-1826, DL-1860, DL-1862 |
| `apps/web/src/components/settings/ArchivedThreadsPanel.tsx` | 1 | — |
| `apps/web/src/composerDraftStore.test.ts` | 2 | — |
| `apps/web/src/components/GitActionsControl.tsx` | 1 | — |
| `apps/web/src/components/diffs/AnnotatableCodeView.tsx` | 1 | — |
| `apps/web/src/components/files/AttachmentFilePreview.browser.test.tsx` | 1 | — |
| `apps/web/src/components/files/filePreviewMode.ts` | 1 | — |
| `apps/web/src/components/preview/PreviewView.browser.test.tsx` | 1 | — |
| `apps/web/src/components/pullRequest/PullRequestCodeTab.tsx` | 1 | — |
| `apps/web/src/components/pullRequest/pullRequestList.logic.ts` | 1 | — |
| `apps/web/src/components/settings/ProviderSettingsPanel.environment.browser.test.tsx` | 1 | — |
| `apps/web/src/components/ui/sidebar.tsx` | 1 | — |
| `apps/web/src/components/usage/usageProviders.ts` | 1 | — |
| `apps/web/src/composer-logic.test.ts` | 1 | — |
| `apps/web/src/composerDraftStore.ts` | 1 | — |
| `apps/web/src/reopenClosedView.ts` | 1 | — |
| `apps/web/src/state/entities.ts` | 1 | — |
| `apps/web/package.json` | 0 | — |
| `apps/web/src/routeTree.gen.ts` | 0 | — |

### web-sidebar (3)

| File | `loom:` | DL rows |
| --- | ---: | --- |
| `apps/web/src/components/CommandPaletteThreadItems.tsx` | 6 | — |
| `apps/web/src/components/Sidebar.logic.ts` | 8 | — |
| `apps/web/src/components/CommandPalette.tsx` | 3 | — |

### client-runtime (12)

| File | `loom:` | DL rows |
| --- | ---: | --- |
| `packages/client-runtime/package.json` | 0 | — |
| `packages/client-runtime/src/rpc/client.ts` | 2 | — |
| `packages/client-runtime/src/state/fileMetadata.test.ts` | 1 | — |
| `packages/client-runtime/src/state/orchestrationV2Projection.ts` | 2 | — |
| `packages/client-runtime/src/state/projectCommands.ts` | 2 | — |
| `packages/client-runtime/src/state/threadRequests.ts` | 2 | — |
| `packages/client-runtime/src/providerClients.ts` | 1 | — |
| `packages/client-runtime/src/rpc/session.test.ts` | 1 | — |
| `packages/client-runtime/src/state/archivedThreads.ts` | 1 | — |
| `packages/client-runtime/src/state/models.ts` | 1 | — |
| `packages/client-runtime/src/state/server.test.ts` | 1 | — |
| `packages/client-runtime/src/state/threadRequests.test.ts` | 1 | — |

## 2d: contracts, shared, mobile, desktop, docs and config (49 files, 197 `loom:` markers)

**Read first.** contracts `orchestrationV2.ts` (22: `freshContext` and thread tags beside Loom's `role`/`loom` members), `rpc.ts` (12), `settings.test.ts` (10); shared `usageLimits.ts` (23, §6.4's `hub` shape), `serverSettings.ts`, `keybindings.ts` (§6.5 (a): nine names moved to `keybindingMatching.ts`); mobile `ThreadFeed.tsx` (12), `thread-list-v2-items.tsx` (9), `HomeScreen.tsx` (6; DL-1709), `UsageLimitsPooled.tsx` (DL-1819); root `vite.config.ts` (17), `knip.jsonc` (6), `package.json` (Loom scripts beside upstream's `knip:check` split); `docs/` (Loom lines in upstream's user and operations pages).

### contracts (11)

| File | `loom:` | DL rows |
| --- | ---: | --- |
| `packages/contracts/src/orchestrationV2.ts` | 26 | — |
| `packages/contracts/src/rpc.ts` | 8 | — |
| `packages/contracts/src/settings.test.ts` | 8 | — |
| `packages/contracts/src/project.ts` | 9 | — |
| `packages/contracts/src/server.ts` | 9 | — |
| `packages/contracts/src/editor.ts` | 4 | — |
| `packages/contracts/src/index.ts` | 4 | — |
| `packages/contracts/src/model.ts` | 4 | — |
| `packages/contracts/src/keybindings.ts` | 3 | — |
| `packages/contracts/src/providerInstance.ts` | 3 | — |
| `packages/contracts/src/providerRuntime.ts` | 3 | — |

### shared (12)

| File | `loom:` | DL rows |
| --- | ---: | --- |
| `packages/shared/src/usageLimits.ts` | 19 | — |
| `packages/shared/package.json` | 0 | — |
| `packages/shared/src/serverSettings.ts` | 5 | — |
| `packages/shared/src/serverSettings.test.ts` | 4 | — |
| `packages/shared/src/toolOutput.ts` | 3 | — |
| `packages/shared/src/keybindings.ts` | 2 | — |
| `packages/shared/src/model.ts` | 2 | — |
| `packages/shared/src/projectSettings.test.ts` | 2 | — |
| `packages/shared/src/shell.test.ts` | 1 | — |
| `packages/shared/src/usageLimits.test.ts` | 2 | — |
| `packages/shared/src/composerContextReferences.test.ts` | 1 | — |
| `packages/shared/src/shell.ts` | 1 | — |

### mobile (9)

| File | `loom:` | DL rows |
| --- | ---: | --- |
| `apps/mobile/src/features/threads/ThreadFeed.tsx` | 8 | — |
| `apps/mobile/src/features/threads/thread-list-v2-items.tsx` | 9 | — |
| `apps/mobile/src/features/home/HomeScreen.tsx` | 4 | — |
| `apps/mobile/src/features/keyboard/CommandPalette.tsx` | 3 | — |
| `apps/mobile/src/features/usage/UsageLimitsPooled.tsx` | 2 | DL-1819 |
| `apps/mobile/src/features/files/ThreadFilesRouteScreen.tsx` | 1 | — |
| `apps/mobile/src/features/home/HomeRouteScreen.tsx` | 1 | — |
| `apps/mobile/src/lib/filePreview.test.ts` | 1 | — |
| `apps/mobile/src/state/thread-task-permissions.test.ts` | 1 | — |

### desktop (3)

| File | `loom:` | DL rows |
| --- | ---: | --- |
| `apps/desktop/src/preview/Manager.test.ts` | 2 | — |
| `apps/desktop/src/preview/Manager.ts` | 1 | — |
| `apps/desktop/src/settings/DesktopClientSettings.test.ts` | 1 | — |

### docs (9)

| File | `loom:` | DL rows |
| --- | ---: | --- |
| `docs/operations/observability.md` | 3 | — |
| `docs/user/source-control.md` | 3 | — |
| `docs/README.md` | 1 | — |
| `docs/operations/development.md` | 2 | — |
| `docs/user/providers-claude.md` | 2 | — |
| `docs/user/keybindings.md` | 1 | — |
| `docs/user/providers-pi.md` | 1 | — |
| `docs/user/thread-sidebar.md` | 1 | — |
| `docs/user/usage.md` | 1 | — |

### root/config/scripts (5)

| File | `loom:` | DL rows |
| --- | ---: | --- |
| `vite.config.ts` | 17 | DL-1825 |
| `knip.jsonc` | 5 | — |
| `scripts/lib/cli-external-packages.test.ts` | 2 | — |
| `package.json` | 0 | — |
| `scripts/lib/cli-external-packages.ts` | 1 | — |
