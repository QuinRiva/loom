## Appendix C: silently merged overlap (180 files)

Both sides changed these since the base and git merged them without a marker.
`L` = lines mentioning `loom` in the merged file (a superset of `loom:`
markers). Gate 2 reads every file with a `loom` line (174) plus the
upstream-only files named in §4, §5.2 and §6.1 (`ProjectionStore.listActiveShellIndex`
is in a conflicted file; `ThreadForkService.ts`, `ProviderTurnStartService.ts`,
`McpInvocationContext.ts`, `peer/RemoteDelegation.ts`,
`DelegatedTaskQuestionReactor.ts`, `threadHistoryPaging.ts`).

| zone | files | with `loom` | `loom` lines |
| --- | ---: | ---: | ---: |
| client-runtime | 10 | 10 | 17 |
| contracts | 9 | 9 | 56 |
| desktop | 3 | 3 | 4 |
| docs/config | 8 | 6 | 11 |
| mobile | 6 | 6 | 16 |
| provider-packages | 13 | 13 | 135 |
| root/config/scripts | 5 | 4 | 60 |
| server-core | 30 | 29 | 139 |
| server-other | 25 | 24 | 130 |
| server-persistence | 3 | 3 | 7 |
| server-provider/mcp | 7 | 7 | 19 |
| shared | 9 | 9 | 48 |
| web-chat | 17 | 17 | 58 |
| web-panels/other | 33 | 32 | 136 |
| web-sidebar | 2 | 2 | 7 |
| **total** | **180** | **174** | **843** |

### client-runtime (10)

- `packages/client-runtime/src/connection/presentation.ts` · 3L · 162 lines
- `packages/client-runtime/src/state/orchestrationV2Projection.ts` · 3L · 425 lines
- `packages/client-runtime/src/rpc/client.ts` · 2L · 446 lines
- `packages/client-runtime/src/state/projectCommands.ts` · 2L · 253 lines
- `packages/client-runtime/src/state/threadSearch.test.ts` · 2L · 262 lines
- `packages/client-runtime/src/rpc/session.test.ts` · 1L · 1010 lines
- `packages/client-runtime/src/state/archivedThreads.ts` · 1L · 70 lines
- `packages/client-runtime/src/state/models.ts` · 1L · 398 lines
- `packages/client-runtime/src/state/server.test.ts` · 1L · 1398 lines
- `packages/client-runtime/src/state/sharedSettings.test.ts` · 1L · 84 lines

### contracts (9)

- `packages/contracts/src/rpc.ts` · 12L · 2221 lines
- `packages/contracts/src/settings.test.ts` · 10L · 666 lines
- `packages/contracts/src/project.ts` · 9L · 712 lines
- `packages/contracts/src/server.ts` · 9L · 1060 lines
- `packages/contracts/src/composerContext.ts` · 6L · 317 lines
- `packages/contracts/src/index.ts` · 3L · 77 lines
- `packages/contracts/src/keybindings.ts` · 3L · 251 lines
- `packages/contracts/src/baseSchemas.ts` · 2L · 343 lines
- `packages/contracts/src/composerContext.test.ts` · 2L · 266 lines

### desktop (3)

- `apps/desktop/src/preview/Manager.test.ts` · 2L · 2698 lines
- `apps/desktop/src/preview/Manager.ts` · 1L · 3705 lines
- `apps/desktop/src/settings/DesktopClientSettings.test.ts` · 1L · 269 lines

### docs/config (8)

- `docs/user/source-control.md` · 3L · 366 lines
- `docs/user/usage.md` · 3L · 201 lines
- `docs/README.md` · 2L · 74 lines
- `docs/operations/development.md` · 1L · 351 lines
- `docs/user/providers-claude.md` · 1L · 180 lines
- `docs/user/thread-sidebar.md` · 1L · 336 lines
- `docs/user/keybindings.md` · 0L · 202 lines
- `third-party-licenses.config.json` · 0L · 1008 lines

### mobile (6)

- `apps/mobile/src/features/threads/ThreadNavigationSidebar.tsx` · 6L · 947 lines
- `apps/mobile/src/features/home/HomeScreen.tsx` · 4L · 877 lines
- `apps/mobile/src/features/usage/UsageLimitsPooled.tsx` · 3L · 680 lines
- `apps/mobile/src/features/files/ThreadFilesRouteScreen.tsx` · 1L · 1015 lines
- `apps/mobile/src/features/layout/AdaptiveWorkspaceLayout.tsx` · 1L · 1081 lines
- `apps/mobile/src/state/use-composer-drafts.ts` · 1L · 2064 lines

### provider-packages (13)

- `packages/provider-pi/src/server/adapter.ts` · 82L · 3586 lines
- `packages/provider-pi/src/server/mcpExtensionSource.ts` · 17L · 513 lines
- `packages/provider-pi/src/server/mcpInjection.ts` · 10L · 329 lines
- `packages/provider-pi/src/server/mcpExtensionSource.test.ts` · 7L · 543 lines
- `packages/provider-core/src/server/ProviderAdapter.ts` · 4L · 685 lines
- `packages/provider-pi/src/server/status.ts` · 3L · 561 lines
- `packages/provider-core/src/server/managedProvider.test.ts` · 2L · 871 lines
- `packages/provider-pi/src/server/adapter.test.ts` · 2L · 4528 lines
- `packages/provider-pi/src/server/rpc.ts` · 2L · 440 lines
- `packages/provider-pi/src/server/textGeneration.test.ts` · 2L · 164 lines
- `packages/provider-testing/src/fakeCli.ts` · 2L · 79 lines
- `packages/provider-core/src/server/snapshot.ts` · 1L · 34 lines
- `packages/provider-opencode/src/server/OpenCodeRuntime.ts` · 1L · 840 lines

### root/config/scripts (5)

- `packages/client-runtime/package.json` · 36L · 603 lines
- `packages/shared/package.json` · 12L · 598 lines
- `scripts/dev-runner.test.ts` · 11L · 1014 lines
- `scripts/lib/cli-external-packages.ts` · 1L · 96 lines
- `package.json` · 0L · 78 lines

### server-core (30)

- `apps/server/src/orchestration-v2/CheckpointService.ts` · 19L · 626 lines
- `apps/server/src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts` · 19L · 898 lines
- `apps/server/src/orchestration-v2/ThreadSettlementService.ts` · 13L · 728 lines
- `apps/server/src/serverRuntimeStartup.test.ts` · 11L · 407 lines
- `apps/server/src/orchestration-v2/ThreadSearch.ts` · 7L · 688 lines
- `apps/server/src/serverRuntimeStartup.ts` · 7L · 737 lines
- `apps/server/src/cli/config.ts` · 6L · 650 lines
- `apps/server/src/orchestration-v2/runtimeLayer.ts` · 6L · 403 lines
- `apps/server/src/serverRuntimeStartup.autoPull.test.ts` · 6L · 208 lines
- `apps/server/src/orchestration-v2/ProjectSettingsUpgrade.integration.test.ts` · 4L · 203 lines
- `apps/server/src/orchestration-v2/ProviderTurnStartService.ts` · 4L · 1732 lines
- `apps/server/src/orchestration-v2/PullRequestWatchReactor.ts` · 4L · 663 lines
- `apps/server/src/auth/SessionStore.ts` · 3L · 1123 lines
- `apps/server/src/orchestration-v2/CheckpointCaptureService.test.ts` · 3L · 913 lines
- `apps/server/src/orchestration-v2/ProviderEventIngestor.ts` · 3L · 919 lines
- `apps/server/src/orchestration-v2/ThreadSettlementService.test.ts` · 3L · 1493 lines
- `apps/server/src/orchestration-v2/runtimeLayer.test.ts` · 3L · 8522 lines
- `apps/server/src/orchestration-v2/testkit/ProviderReplayHarness.ts` · 3L · 582 lines
- `apps/server/src/orchestration-v2/RestartContinuation.ts` · 2L · 365 lines
- `apps/server/src/orchestration-v2/ThreadManagementService.ts` · 2L · 1590 lines
- `apps/server/src/orchestration-v2/http.test.ts` · 2L · 299 lines
- `apps/server/src/orchestration-v2/testkit/OrchestratorScenario.ts` · 2L · 734 lines
- `apps/server/src/cli/server.ts` · 1L · 94 lines
- `apps/server/src/orchestration-v2/EffectWorker.ts` · 1L · 956 lines
- `apps/server/src/orchestration-v2/Orchestrator.control-reads.test.ts` · 1L · 1576 lines
- `apps/server/src/orchestration-v2/ProjectionControlReads.test.ts` · 1L · 355 lines
- `apps/server/src/orchestration-v2/ProviderTurnControlService.ts` · 1L · 428 lines
- `apps/server/src/orchestration-v2/RunCompletionReads.test.ts` · 1L · 159 lines
- `apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.ts` · 1L · 156 lines
- `apps/server/src/orchestration-v2/testkit/fixtures/thread_rollback_after_stop/pi_transcript.ndjson` · 0L · 273 lines

### server-other (25)

- `apps/server/src/usage/cliproxyApi.ts` · 30L · 734 lines
- `apps/server/src/ws.test.ts` · 21L · 1080 lines
- `apps/server/src/project/ProjectService.ts` · 12L · 654 lines
- `apps/server/integration/transferBudgetV2.integration.test.ts` · 9L · 477 lines
- `apps/server/src/assets/AssetAccess.ts` · 6L · 1085 lines
- `apps/server/src/project/ProjectService.test.ts` · 6L · 874 lines
- `apps/server/src/terminal/Manager.ts` · 5L · 3519 lines
- `apps/server/src/workspace/WorkspaceEntries.ts` · 5L · 547 lines
- `apps/server/src/assets/AssetAccess.test.ts` · 4L · 1587 lines
- `apps/server/src/binCli.ts` · 4L · 120 lines
- `apps/server/src/git/GitManager.ts` · 4L · 3323 lines
- `apps/server/src/terminal/Manager.test.ts` · 4L · 2373 lines
- `apps/server/src/cloud/ManagedEndpointRuntime.ts` · 3L · 880 lines
- `apps/server/src/process/externalLauncher.ts` · 3L · 876 lines
- `apps/server/src/http.test.ts` · 2L · 875 lines
- `apps/server/src/project/ProjectSetupScriptRunner.test.ts` · 2L · 203 lines
- `apps/server/src/project/RepositoryIdentityResolver.test.ts` · 2L · 346 lines
- `apps/server/src/vcs/GitVcsDriver.ts` · 2L · 1527 lines
- `apps/server/src/http.ts` · 1L · 745 lines
- `apps/server/src/keybindings.test.ts` · 1L · 678 lines
- `apps/server/src/storageCleanup.ts` · 1L · 1392 lines
- `apps/server/src/usage/usageScanCache.ts` · 1L · 372 lines
- `apps/server/src/vcs/GitVcsDriverCore.test.ts` · 1L · 6222 lines
- `apps/server/src/workspace/WorkspaceEntries.test.ts` · 1L · 794 lines
- `apps/server/scripts/migrate-dev-db.test.ts` · 0L · 386 lines

### server-persistence (3)

- `apps/server/src/persistence/initializeV2Database.test.ts` · 4L · 219 lines
- `apps/server/src/persistence/DatabaseMaintenance.ts` · 2L · 258 lines
- `apps/server/src/persistence/DatabaseMaintenance.test.ts` · 1L · 190 lines

### server-provider/mcp (7)

- `apps/server/src/provider/ClaudeProvider.ts` · 8L · 1243 lines
- `apps/server/src/mcp/McpSessionRegistry.ts` · 4L · 235 lines
- `apps/server/src/mcp/toolkits/thread/tools.ts` · 2L · 251 lines
- `apps/server/src/provider/ProviderInstanceRegistry.test.ts` · 2L · 1000 lines
- `apps/server/src/mcp/McpInvocationContext.ts` · 1L · 231 lines
- `apps/server/src/mcp/toolkits/pullRequests/handlers.ts` · 1L · 620 lines
- `apps/server/src/provider/providerCompatibility.test.ts` · 1L · 329 lines

### shared (9)

- `packages/shared/src/usageLimits.ts` · 24L · 1131 lines
- `packages/shared/src/composerContextReferences.ts` · 8L · 433 lines
- `packages/shared/src/serverSettings.test.ts` · 4L · 1022 lines
- `packages/shared/src/serverSettings.ts` · 3L · 692 lines
- `packages/shared/src/toolOutput.ts` · 3L · 281 lines
- `packages/shared/src/keybindings.ts` · 2L · 511 lines
- `packages/shared/src/usageLimits.test.ts` · 2L · 1438 lines
- `packages/shared/src/String.ts` · 1L · 27 lines
- `packages/shared/src/shell.ts` · 1L · 1009 lines

### web-chat (17)

- `apps/web/src/components/chat/MarkdownCodeBlock.tsx` · 9L · 409 lines
- `apps/web/src/components/chat/MessagesTimeline.logic.ts` · 7L · 2590 lines
- `apps/web/src/components/chat/ComposerFooterControls.tsx` · 6L · 413 lines
- `apps/web/src/components/chat/ModelPickerContent.tsx` · 6L · 1097 lines
- `apps/web/src/components/chat/OpenInPicker.tsx` · 5L · 458 lines
- `apps/web/src/components/chat/MarkdownFileLink.tsx` · 4L · 432 lines
- `apps/web/src/components/ChatMarkdown.permissions.browser.test.tsx` · 3L · 288 lines
- `apps/web/src/components/chat/ComposerPendingUserInputPanel.navigation.browser.test.tsx` · 3L · 273 lines
- `apps/web/src/components/chat/composerFocusRedirect.ts` · 3L · 93 lines
- `apps/web/src/components/chat/timelineMinimapItems.ts` · 3L · 119 lines
- `apps/web/src/components/chat/TimelineAssistantRows.tsx` · 2L · 397 lines
- `apps/web/src/session-logic.ts` · 2L · 1150 lines
- `apps/web/src/components/chat/ComposerCommandMenu.tsx` · 1L · 297 lines
- `apps/web/src/components/chat/SkillInlineText.tsx` · 1L · 123 lines
- `apps/web/src/components/chat/providerIconUtils.ts` · 1L · 47 lines
- `apps/web/src/composerDraftStore.test.ts` · 1L · 2517 lines
- `apps/web/src/composerDraftStore.ts` · 1L · 4567 lines

### web-panels/other (33)

- `apps/web/src/components/settings/ProviderModelsSection.tsx` · 16L · 694 lines
- `apps/web/src/rightPanelStore.test.ts` · 15L · 1362 lines
- `apps/web/src/components/settings/ProviderSettingsPanel.tsx` · 13L · 1459 lines
- `apps/web/src/modelSelection.test.ts` · 9L · 1373 lines
- `apps/web/src/components/settings/ProviderInstanceCard.tsx` · 7L · 1417 lines
- `apps/web/src/components/ui/toast.tsx` · 7L · 859 lines
- `apps/web/src/components/usage/UsageLimitsPooled.tsx` · 7L · 724 lines
- `apps/web/src/lib/composerContextRecords.ts` · 7L · 546 lines
- `apps/web/src/hooks/useThreadActionMenu.test.ts` · 6L · 204 lines
- `apps/web/src/components/pullRequest/pullRequestDetail.logic.ts` · 5L · 1414 lines
- `apps/web/src/state/threads.ts` · 5L · 139 lines
- `apps/web/src/components/files/projectFilesQueryState.ts` · 4L · 364 lines
- `apps/web/src/reopenClosedView.test.ts` · 4L · 213 lines
- `apps/web/src/closedViewStore.ts` · 3L · 153 lines
- `apps/web/src/components/ReopenClosedViewShortcut.browser.test.tsx` · 3L · 284 lines
- `apps/web/src/diffPanelStore.ts` · 3L · 252 lines
- `apps/web/src/hooks/useThreadActions.ts` · 3L · 982 lines
- `apps/web/src/closedViewStore.test.ts` · 2L · 156 lines
- `apps/web/src/components/pullRequest/pullRequestDetail.logic.test.ts` · 2L · 1537 lines
- `apps/web/src/components/usage/UsagePage.tsx` · 2L · 1563 lines
- `apps/web/vite.config.ts` · 2L · 434 lines
- `apps/web/src/components/DiffWorkerPoolProvider.tsx` · 1L · 162 lines
- `apps/web/src/components/GitActionsControl.tsx` · 1L · 1911 lines
- `apps/web/src/components/files/filePreviewMode.ts` · 1L · 86 lines
- `apps/web/src/components/preview/PreviewView.browser.test.tsx` · 1L · 393 lines
- `apps/web/src/components/pullRequest/PullRequestCodeTab.tsx` · 1L · 1564 lines
- `apps/web/src/components/pullRequest/pullRequestList.logic.ts` · 1L · 989 lines
- `apps/web/src/components/settings/ProviderSettingsPanel.environment.browser.test.tsx` · 1L · 423 lines
- `apps/web/src/components/ui/sidebar.tsx` · 1L · 871 lines
- `apps/web/src/composer-logic.test.ts` · 1L · 594 lines
- `apps/web/src/keybindings.ts` · 1L · 498 lines
- `apps/web/src/state/entities.ts` · 1L · 436 lines
- `apps/web/src/routeTree.gen.ts` · 0L · 922 lines

### web-sidebar (2)

- `apps/web/src/routes/_chat.index.tsx` · 5L · 134 lines
- `apps/web/src/components/sidebar/SidebarChrome.tsx` · 2L · 306 lines
