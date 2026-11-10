## Appendix C: silently merged overlap (187 files)

Both sides changed these since the base and git merged them without a marker.
`L` = lines mentioning `loom` in the merged file (a superset of `loom:`
markers). Gate 2 reads every file with a `loom` line (185) plus the
upstream-only files named in §4, §5.2 and §6: `OrchestrationEventStore.ts`
and `DatabaseStorage.ts` (the prune mark and loop), `telemetry/ProviderUsageAnalytics.ts`,
`McpHttpServer.ts`'s `provideRegistrationServices`, `threadTagFilter.ts`,
`freshSessionArms.ts`, `scheduledTasks/ScheduledTaskService.ts` (+184),
`persistence/testkit/SqliteRouting.ts`, `ThreadForkService.ts`,
`DelegatedTaskQuestionReactor.ts` (unchanged, re-read once against #32573).

| zone | files | with `loom` | `loom` lines |
| --- | ---: | ---: | ---: |
| client-runtime | 12 | 12 | 52 |
| contracts | 11 | 11 | 84 |
| desktop | 3 | 3 | 4 |
| docs | 9 | 9 | 16 |
| mobile | 9 | 9 | 39 |
| provider-packages | 9 | 9 | 28 |
| root/config/scripts | 5 | 5 | 27 |
| server-core | 30 | 30 | 181 |
| server-other | 24 | 24 | 100 |
| server-persistence | 5 | 5 | 11 |
| server-provider/mcp | 8 | 8 | 26 |
| shared | 12 | 12 | 59 |
| web-chat | 16 | 16 | 161 |
| web-panels/other | 31 | 29 | 166 |
| web-sidebar | 3 | 3 | 21 |
| **total** | **187** | **185** | **975** |

Files that matter most, by zone (the rest are listed for completeness and
read in Gate 2's zone order): server-core `ws.test.ts` (9; upstream's
237-line replay rewrite), `ThreadSettlementService.ts` (23; §6.6),
`PullRequestWatchReactor.ts` (4; the `GROUP_READS` semaphore), `ProviderTurnStartService.ts`
(5; +48 upstream), `RestartContinuation.test.ts` (2; DL-1708's steer stash),
`runtimeLayer.ts` (6), `LegacyV1ThreadImporter.ts` (17; the importer's
`thread.created` marker is why pruning keeps it), `RpcAuthorization.ts` (18)
and `RpcInstrumentation.ts` (24; exhaustive maps, new upstream ws methods
compile or fail typecheck); server-other `ProjectService.ts` (12),
`GitVcsDriverCore.ts` (11; DL-1615), `serverRuntimeStartup.ts` (7),
`ClaudeProvider.ts` (8); persistence `Sqlite.ts` (4; the WAL limit beside
Loom's `cache_size`), `DatabaseMaintenance.ts` (2; §4); provider packages
`adapter.test.ts` (2), `driver.ts` (8), `ProviderAdapter.ts` (4); web-chat
`MessagesTimeline.tsx` (40) and `.logic.ts` (11; §6.5 (c)), `ChatMarkdown.tsx`
(31), `useComposerSend.ts` (8; DL-1725's toast removal, `/clear` send),
`TimelineUserMessageRow.tsx` (13; the New session marker row),
`composerContextPresentation.tsx` (7; §6.5 (a)), `ComposerFooterControls.tsx`
(5; the dictation button); web-panels `DiffPanel.tsx` (28; DL-1621),
`rightPanelStore.ts` (31), `index.css` (33), `ProviderSettingsPanel.tsx` (13),
`SettingsPanels.tsx` (6), `composerDraftStore.ts` (1; DL-1720's area);
web-sidebar `Sidebar.logic.ts` (8; §6.5 (a)), `CommandPaletteThreadItems.tsx`
(10); contracts `orchestrationV2.ts` (22; `freshContext`, tags beside Loom's
`role`/`loom` members), `rpc.ts` (12), `settings.test.ts` (10); shared
`usageLimits.ts` (23; §6.4), `serverSettings.ts` (5), `model.ts` (2);
client-runtime `threadRequests.ts` (2), `orchestrationV2Projection.ts` (2),
`providerClients.ts` (1; pi leads); mobile `ThreadFeed.tsx` (12),
`thread-list-v2-items.tsx` (9), `HomeScreen.tsx` (6; DL-1709); root
`vite.config.ts` (17; verified), `knip.jsonc` (6), `package.json` (1; Loom
scripts beside upstream's `knip:check` split).

### client-runtime (12)

- `packages/client-runtime/package.json` · 36L
- `packages/client-runtime/src/providerClients.ts` · 1L
- `packages/client-runtime/src/rpc/client.ts` · 2L
- `packages/client-runtime/src/rpc/session.test.ts` · 1L
- `packages/client-runtime/src/state/archivedThreads.ts` · 1L
- `packages/client-runtime/src/state/fileMetadata.test.ts` · 2L
- `packages/client-runtime/src/state/models.ts` · 1L
- `packages/client-runtime/src/state/orchestrationV2Projection.ts` · 2L
- `packages/client-runtime/src/state/projectCommands.ts` · 2L
- `packages/client-runtime/src/state/server.test.ts` · 1L
- `packages/client-runtime/src/state/threadRequests.test.ts` · 1L
- `packages/client-runtime/src/state/threadRequests.ts` · 2L

### contracts (11)

- `packages/contracts/src/editor.ts` · 5L
- `packages/contracts/src/index.ts` · 4L
- `packages/contracts/src/keybindings.ts` · 3L
- `packages/contracts/src/model.ts` · 4L
- `packages/contracts/src/orchestrationV2.ts` · 22L
- `packages/contracts/src/project.ts` · 9L
- `packages/contracts/src/providerInstance.ts` · 3L
- `packages/contracts/src/providerRuntime.ts` · 3L
- `packages/contracts/src/rpc.ts` · 12L
- `packages/contracts/src/server.ts` · 9L
- `packages/contracts/src/settings.test.ts` · 10L

### desktop (3)

- `apps/desktop/src/preview/Manager.test.ts` · 2L
- `apps/desktop/src/preview/Manager.ts` · 1L
- `apps/desktop/src/settings/DesktopClientSettings.test.ts` · 1L

### docs (9)

- `docs/README.md` · 2L
- `docs/operations/development.md` · 2L
- `docs/operations/observability.md` · 3L
- `docs/user/keybindings.md` · 1L
- `docs/user/providers-claude.md` · 2L
- `docs/user/providers-pi.md` · 1L
- `docs/user/source-control.md` · 3L
- `docs/user/thread-sidebar.md` · 1L
- `docs/user/usage.md` · 1L

### mobile (9)

- `apps/mobile/src/features/files/ThreadFilesRouteScreen.tsx` · 1L
- `apps/mobile/src/features/home/HomeRouteScreen.tsx` · 1L
- `apps/mobile/src/features/home/HomeScreen.tsx` · 6L
- `apps/mobile/src/features/keyboard/CommandPalette.tsx` · 5L
- `apps/mobile/src/features/threads/ThreadFeed.tsx` · 12L
- `apps/mobile/src/features/threads/thread-list-v2-items.tsx` · 9L
- `apps/mobile/src/features/usage/UsageLimitsPooled.tsx` · 3L
- `apps/mobile/src/lib/filePreview.test.ts` · 1L
- `apps/mobile/src/state/thread-task-permissions.test.ts` · 1L

### provider-packages (9)

- `packages/provider-core/src/server/ProviderAdapter.ts` · 4L
- `packages/provider-core/src/server/notification.ts` · 4L
- `packages/provider-core/src/server/textGenerationPrompts.ts` · 2L
- `packages/provider-opencode/src/server/OpenCodeRuntime.ts` · 1L
- `packages/provider-pi/package.json` · 3L
- `packages/provider-pi/src/server/adapter.test.ts` · 2L
- `packages/provider-pi/src/server/driver.ts` · 8L
- `packages/provider-pi/src/server/rpc.ts` · 2L
- `packages/provider-testing/src/fakeCli.ts` · 2L

### root/config/scripts (5)

- `knip.jsonc` · 6L
- `package.json` · 1L
- `scripts/lib/cli-external-packages.test.ts` · 2L
- `scripts/lib/cli-external-packages.ts` · 1L
- `vite.config.ts` · 17L

### server-core (30)

- `apps/server/integration/transferBudgetV2.integration.test.ts` · 6L
- `apps/server/src/auth/RpcAuthorization.ts` · 18L
- `apps/server/src/auth/SessionStore.ts` · 3L
- `apps/server/src/binCli.ts` · 4L
- `apps/server/src/http.ts` · 1L
- `apps/server/src/observability/RpcInstrumentation.ts` · 24L
- `apps/server/src/orchestration-v2/CheckpointCaptureService.test.ts` · 3L
- `apps/server/src/orchestration-v2/CheckpointService.test.ts` · 2L
- `apps/server/src/orchestration-v2/EffectWorker.ts` · 1L
- `apps/server/src/orchestration-v2/Orchestrator.control-reads.test.ts` · 2L
- `apps/server/src/orchestration-v2/ProjectSettingsUpgrade.integration.test.ts` · 3L
- `apps/server/src/orchestration-v2/ProviderEventIngestor.test.ts` · 3L
- `apps/server/src/orchestration-v2/ProviderEventIngestor.ts` · 3L
- `apps/server/src/orchestration-v2/ProviderTurnStartService.ts` · 5L
- `apps/server/src/orchestration-v2/PullRequestWatchReactor.ts` · 4L
- `apps/server/src/orchestration-v2/RestartContinuation.test.ts` · 2L
- `apps/server/src/orchestration-v2/ThreadManagementService.ts` · 2L
- `apps/server/src/orchestration-v2/ThreadSearch.ts` · 7L
- `apps/server/src/orchestration-v2/ThreadSettlementService.ts` · 23L
- `apps/server/src/orchestration-v2/http.ts` · 3L
- `apps/server/src/orchestration-v2/legacy/LegacyV1Cutover.integration.test.ts` · 3L
- `apps/server/src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts` · 17L
- `apps/server/src/orchestration-v2/runtimeLayer.test.ts` · 4L
- `apps/server/src/orchestration-v2/runtimeLayer.ts` · 6L
- `apps/server/src/orchestration-v2/testkit/OrchestratorScenario.ts` · 2L
- `apps/server/src/orchestration-v2/testkit/ProviderReplayHarness.ts` · 3L
- `apps/server/src/relay/AgentAwarenessRelay.ts` · 2L
- `apps/server/src/serverRuntimeStartup.test.ts` · 9L
- `apps/server/src/serverRuntimeStartup.ts` · 7L
- `apps/server/src/ws.test.ts` · 9L

### server-other (24)

- `apps/server/src/assets/AssetAccess.test.ts` · 6L
- `apps/server/src/assets/AssetAccess.ts` · 6L
- `apps/server/src/checkpointing/CheckpointDiffQuery.ts` · 8L
- `apps/server/src/cloud/ManagedEndpointRuntime.ts` · 3L
- `apps/server/src/git/GitManager.test.ts` · 2L
- `apps/server/src/git/GitManager.ts` · 4L
- `apps/server/src/process/externalLauncher.test.ts` · 1L
- `apps/server/src/project/ProjectService.deletion.test.ts` · 3L
- `apps/server/src/project/ProjectService.test.ts` · 7L
- `apps/server/src/project/ProjectService.ts` · 12L
- `apps/server/src/project/ProjectSetupScriptRunner.test.ts` · 2L
- `apps/server/src/project/RepositoryIdentityResolver.test.ts` · 2L
- `apps/server/src/storageCleanup.ts` · 1L
- `apps/server/src/terminal/Manager.test.ts` · 4L
- `apps/server/src/terminal/Manager.ts` · 5L
- `apps/server/src/usage/usageScanCache.test.ts` · 2L
- `apps/server/src/usage/usageScanCache.ts` · 1L
- `apps/server/src/vcs/GitVcsDriverCore.test.ts` · 2L
- `apps/server/src/vcs/GitVcsDriverCore.ts` · 11L
- `apps/server/src/vcs/VcsStatusBroadcaster.test.ts` · 5L
- `apps/server/src/workspace/WorkspaceEntries.test.ts` · 1L
- `apps/server/src/workspace/WorkspaceEntries.ts` · 5L
- `apps/server/src/workspace/WorkspaceFileSystem.test.ts` · 3L
- `apps/server/src/workspace/WorkspaceSearchIndex.ts` · 4L

### server-persistence (5)

- `apps/server/src/persistence/DatabaseMaintenance.test.ts` · 1L
- `apps/server/src/persistence/DatabaseMaintenance.ts` · 2L
- `apps/server/src/persistence/Migrations.test.ts` · 1L
- `apps/server/src/persistence/Sqlite.ts` · 4L
- `apps/server/src/persistence/initializeV2Database.test.ts` · 3L

### server-provider/mcp (8)

- `apps/server/src/mcp/McpInvocationContext.ts` · 1L
- `apps/server/src/mcp/McpSessionRegistry.test.ts` · 8L
- `apps/server/src/mcp/McpSessionRegistry.ts` · 4L
- `apps/server/src/mcp/toolkits/pullRequests/handlers.ts` · 1L
- `apps/server/src/mcp/toolkits/thread/tools.ts` · 2L
- `apps/server/src/provider/ClaudeProvider.ts` · 8L
- `apps/server/src/provider/ProviderInstanceRegistry.test.ts` · 1L
- `apps/server/src/provider/providerCompatibility.test.ts` · 1L

### shared (12)

- `packages/shared/package.json` · 12L
- `packages/shared/src/composerContextReferences.test.ts` · 1L
- `packages/shared/src/keybindings.ts` · 2L
- `packages/shared/src/model.ts` · 2L
- `packages/shared/src/projectSettings.test.ts` · 2L
- `packages/shared/src/serverSettings.test.ts` · 4L
- `packages/shared/src/serverSettings.ts` · 5L
- `packages/shared/src/shell.test.ts` · 2L
- `packages/shared/src/shell.ts` · 1L
- `packages/shared/src/toolOutput.ts` · 3L
- `packages/shared/src/usageLimits.test.ts` · 2L
- `packages/shared/src/usageLimits.ts` · 23L

### web-chat (16)

- `apps/web/src/components/ChatMarkdown.tsx` · 31L
- `apps/web/src/components/chat/ChatComposer.tsx` · 6L
- `apps/web/src/components/chat/ChatMarkdownMedia.tsx` · 6L
- `apps/web/src/components/chat/ComposerFooterControls.tsx` · 5L
- `apps/web/src/components/chat/ContextWindowMeter.tsx` · 5L
- `apps/web/src/components/chat/MarkdownFileLink.tsx` · 4L
- `apps/web/src/components/chat/MessagesTimeline.logic.ts` · 11L
- `apps/web/src/components/chat/MessagesTimeline.tsx` · 40L
- `apps/web/src/components/chat/RightPanelSurfaceContent.tsx` · 7L
- `apps/web/src/components/chat/ThreadNow.tsx` · 5L
- `apps/web/src/components/chat/TimelineAssistantRows.tsx` · 4L
- `apps/web/src/components/chat/TimelineUserMessageRow.tsx` · 13L
- `apps/web/src/components/chat/TimelineWorkEntryRow.tsx` · 2L
- `apps/web/src/components/chat/TimelineWorkGroupRows.tsx` · 7L
- `apps/web/src/components/chat/useComposerSend.ts` · 8L
- `apps/web/src/components/composerContextPresentation.tsx` · 7L

### web-panels/other (31)

- `apps/web/package.json` · 0L
- `apps/web/src/components/DiffPanel.tsx` · 28L
- `apps/web/src/components/GitActionsControl.tsx` · 1L
- `apps/web/src/components/diffs/AnnotatableCodeView.tsx` · 1L
- `apps/web/src/components/files/AttachmentFilePreview.browser.test.tsx` · 1L
- `apps/web/src/components/files/filePreviewMode.ts` · 1L
- `apps/web/src/components/preview/PreviewView.browser.test.tsx` · 1L
- `apps/web/src/components/pullRequest/PullRequestCodeTab.tsx` · 1L
- `apps/web/src/components/pullRequest/pullRequestDetail.logic.test.ts` · 2L
- `apps/web/src/components/pullRequest/pullRequestList.logic.ts` · 1L
- `apps/web/src/components/settings/ArchivedThreadsPanel.tsx` · 2L
- `apps/web/src/components/settings/ProviderSettingsPanel.environment.browser.test.tsx` · 1L
- `apps/web/src/components/settings/ProviderSettingsPanel.tsx` · 13L
- `apps/web/src/components/settings/SettingsPanels.tsx` · 6L
- `apps/web/src/components/ui/sidebar.tsx` · 1L
- `apps/web/src/components/usage/usageProviders.ts` · 1L
- `apps/web/src/composer-logic.test.ts` · 1L
- `apps/web/src/composerDraftStore.test.ts` · 2L
- `apps/web/src/composerDraftStore.ts` · 1L
- `apps/web/src/hooks/useThreadActions.ts` · 3L
- `apps/web/src/index.css` · 33L
- `apps/web/src/keybindings.test.ts` · 5L
- `apps/web/src/lib/composerContextRecords.test.ts` · 4L
- `apps/web/src/lib/composerContextRecords.ts` · 7L
- `apps/web/src/reopenClosedView.ts` · 1L
- `apps/web/src/reviewCommentContext.ts` · 7L
- `apps/web/src/rightPanelStore.ts` · 31L
- `apps/web/src/routeTree.gen.ts` · 0L
- `apps/web/src/routes/_chat.index.tsx` · 5L
- `apps/web/src/state/entities.ts` · 1L
- `apps/web/vite.config.ts` · 4L

### web-sidebar (3)

- `apps/web/src/components/CommandPalette.tsx` · 3L
- `apps/web/src/components/CommandPaletteThreadItems.tsx` · 10L
- `apps/web/src/components/Sidebar.logic.ts` · 8L
