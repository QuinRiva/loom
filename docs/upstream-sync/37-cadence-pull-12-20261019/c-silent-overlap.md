## Appendix C — silently merged overlap (172 files)

Both sides changed these since the base and git merged them without a marker. `L` = `loom:` lines in the merged file. Gate 2 reads every file with a `loom:` line (167) plus `storageCleanup.ts`, `client-runtime/state/threadShell.ts` and `DelegatedTaskQuestionReactor.ts` (upstream-only, named in §4.2).

| zone | files | with `loom:` | `loom:` lines |
| --- | ---: | ---: | ---: |
| client-runtime | 10 | 9 | 30 |
| contracts | 6 | 6 | 31 |
| desktop | 2 | 2 | 3 |
| docs | 1 | 1 | 1 |
| mobile | 3 | 2 | 2 |
| provider-packages | 13 | 13 | 46 |
| root/config/scripts | 5 | 5 | 14 |
| server-core | 28 | 28 | 103 |
| server-other | 38 | 38 | 136 |
| server-persistence | 1 | 1 | 4 |
| server-provider/mcp | 8 | 8 | 23 |
| shared | 9 | 8 | 15 |
| web-chat | 16 | 15 | 42 |
| web-panels/other | 28 | 27 | 100 |
| web-sidebar | 4 | 4 | 10 |
| **total** | **172** | **167** | **560** |

### client-runtime (10)

- `packages/client-runtime/src/state/shell.ts` · 13L · 605 lines
- `packages/client-runtime/src/state/shellReducer.ts` · 6L · 202 lines
- `packages/client-runtime/src/connection/presentation.ts` · 3L · 167 lines
- `packages/client-runtime/src/state/orchestrationV2Projection.ts` · 2L · 334 lines
- `packages/client-runtime/src/state/projectCommands.ts` · 2L · 245 lines
- `packages/client-runtime/src/connection/presentation.test.ts` · 1L · 309 lines
- `packages/client-runtime/src/rpc/session.test.ts` · 1L · 1270 lines
- `packages/client-runtime/src/state/models.ts` · 1L · 326 lines
- `packages/client-runtime/src/state/server.test.ts` · 1L · 926 lines
- `packages/client-runtime/package.json` · 0L · 494 lines

### contracts (6)

- `packages/contracts/src/providerRuntime.ts` · 11L · 1282 lines
- `packages/contracts/src/project.ts` · 9L · 690 lines
- `packages/contracts/src/model.ts` · 4L · 235 lines
- `packages/contracts/src/keybindings.ts` · 3L · 254 lines
- `packages/contracts/src/baseSchemas.ts` · 2L · 356 lines
- `packages/contracts/src/composerContext.test.ts` · 2L · 341 lines

### desktop (2)

- `apps/desktop/src/preview/Manager.test.ts` · 2L · 4636 lines
- `apps/desktop/src/preview/Manager.ts` · 1L · 3746 lines

### docs (1)

- `docs/operations/development.md` · 1L · 220 lines

### mobile (3)

- `apps/mobile/src/features/files/ThreadFilesRouteScreen.tsx` · 1L · 923 lines
- `apps/mobile/src/features/keyboard/commandPaletteItems.ts` · 1L · 47 lines
- `apps/mobile/src/features/threads/QuestionAnswerHistory.test.tsx` · 0L · 62 lines

### provider-packages (13)

- `packages/provider-pi/src/server/mcpExtensionSource.ts` · 16L · 499 lines
- `packages/provider-pi/src/server/mcpInjection.ts` · 7L · 330 lines
- `packages/provider-core/src/server/ProviderAdapter.ts` · 4L · 657 lines
- `packages/provider-pi/src/server/driver.ts` · 4L · 222 lines
- `packages/provider-core/src/server/notification.ts` · 2L · 228 lines
- `packages/provider-core/src/server/textGenerationPrompts.ts` · 2L · 495 lines
- `packages/provider-pi/src/server/mcpExtensionSource.test.ts` · 2L · 562 lines
- `packages/provider-pi/src/server/rpc.ts` · 2L · 442 lines
- `packages/provider-pi/src/server/status.ts` · 2L · 484 lines
- `packages/provider-testing/src/fakeCli.ts` · 2L · 93 lines
- `packages/provider-core/src/server/managedProvider.test.ts` · 1L · 775 lines
- `packages/provider-core/src/server/snapshot.ts` · 1L · 35 lines
- `packages/provider-opencode/src/server/OpenCodeRuntime.ts` · 1L · 1147 lines

### root/config/scripts (5)

- `scripts/dev-runner.ts` · 5L · 923 lines
- `vite.config.ts` · 5L · 441 lines
- `.gitignore` · 2L · 56 lines
- `AGENTS.md` · 1L · 265 lines
- `scripts/lib/cli-external-packages.ts` · 1L · 114 lines

### server-core (28)

- `apps/server/src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts` · 17L · 905 lines
- `apps/server/src/orchestration-v2/CheckpointService.ts` · 10L · 633 lines
- `apps/server/src/serverRuntimeStartup.ts` · 9L · 748 lines
- `apps/server/src/serverRuntimeStartup.autoPull.test.ts` · 7L · 210 lines
- `apps/server/src/auth/RpcAuthorization.ts` · 6L · 296 lines
- `apps/server/src/cli/config.ts` · 5L · 607 lines
- `apps/server/src/orchestration-v2/ProviderTurnStartService.ts` · 5L · 1284 lines
- `apps/server/src/orchestration-v2/V1ImportBoundary.test.ts` · 5L · 93 lines
- `apps/server/src/auth/SessionStore.ts` · 3L · 1095 lines
- `apps/server/src/orchestration-v2/boundedSnapshotTransport.test.ts` · 3L · 371 lines
- `apps/server/src/orchestration-v2/runtimeLayer.test.ts` · 3L · 6388 lines
- `apps/server/src/orchestration-v2/testkit/ProviderReplayHarness.ts` · 3L · 557 lines
- `apps/server/src/orchestration-v2/CheckpointCaptureService.test.ts` · 2L · 726 lines
- `apps/server/src/orchestration-v2/EffectWorker.ts` · 2L · 900 lines
- `apps/server/src/orchestration-v2/ProjectSettingsUpgrade.integration.test.ts` · 2L · 201 lines
- `apps/server/src/orchestration-v2/ProviderSessionManager.test.ts` · 2L · 4910 lines
- `apps/server/src/orchestration-v2/ProviderTurnControlService.ts` · 2L · 407 lines
- `apps/server/src/orchestration-v2/ThreadDeletion.ts` · 2L · 235 lines
- `apps/server/src/orchestration-v2/ThreadManagementService.ts` · 2L · 1223 lines
- `apps/server/src/orchestration-v2/ThreadSettlementService.test.ts` · 2L · 1415 lines
- `apps/server/src/orchestration-v2/http.ts` · 2L · 263 lines
- `apps/server/src/orchestration-v2/legacy/LegacyV1Cutover.integration.test.ts` · 2L · 1028 lines
- `apps/server/src/orchestration-v2/testkit/OrchestratorScenario.ts` · 2L · 735 lines
- `apps/server/src/orchestration-v2/Orchestrator.control-reads.test.ts` · 1L · 1042 lines
- `apps/server/src/orchestration-v2/ProjectionControlReads.test.ts` · 1L · 353 lines
- `apps/server/src/orchestration-v2/ProjectionSettlement.test.ts` · 1L · 529 lines
- `apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.ts` · 1L · 112 lines
- `apps/server/src/orchestration-v2/testkit/fixtures/simple/pi_output.ts` · 1L · 115 lines

### server-other (38)

- `apps/server/src/project/ProjectSetupScriptRunner.ts` · 13L · 508 lines
- `apps/server/src/project/ProjectService.ts` · 11L · 624 lines
- `apps/server/src/serverSettings.test.ts` · 10L · 2258 lines
- `apps/server/scripts/migrate-dev-db.ts` · 9L · 653 lines
- `apps/server/src/assets/AssetAccess.test.ts` · 7L · 1538 lines
- `apps/server/integration/transferBudgetV2.integration.test.ts` · 6L · 372 lines
- `apps/server/src/project/ProjectService.test.ts` · 6L · 845 lines
- `apps/server/src/ws.test.ts` · 6L · 465 lines
- `apps/server/src/project/ProjectSetupScriptRunner.test.ts` · 5L · 186 lines
- `apps/server/src/terminal/Manager.ts` · 5L · 3168 lines
- `apps/server/src/usage/cliproxyApi.ts` · 5L · 450 lines
- `apps/server/src/observability/RpcInstrumentation.ts` · 4L · 271 lines
- `apps/server/src/vcs/GitVcsDriverCore.test.ts` · 4L · 4851 lines
- `apps/server/src/workspace/WorkspaceSearchIndex.ts` · 4L · 604 lines
- `apps/server/src/checkpointing/CheckpointDiffQuery.ts` · 3L · 302 lines
- `apps/server/src/git/GitWorkflowService.ts` · 3L · 514 lines
- `apps/server/src/project/ProjectService.deletion.test.ts` · 3L · 525 lines
- `apps/server/src/usage/UsageLimitSources.ts` · 3L · 179 lines
- `apps/server/src/assets/AssetAccess.ts` · 2L · 997 lines
- `apps/server/src/binCli.ts` · 2L · 106 lines
- `apps/server/src/git/GitManager.test.ts` · 2L · 7548 lines
- `apps/server/src/git/GitManager.ts` · 2L · 3246 lines
- `apps/server/src/http.test.ts` · 2L · 844 lines
- `apps/server/src/process/externalLauncher.ts` · 2L · 855 lines
- `apps/server/src/serverSettings.ts` · 2L · 1184 lines
- `apps/server/src/workspace/WorkspaceEntries.ts` · 2L · 426 lines
- `apps/server/src/workspace/WorkspaceFileSystem.test.ts` · 2L · 967 lines
- `apps/server/src/cloud/ManagedEndpointRuntime.ts` · 1L · 677 lines
- `apps/server/src/http.ts` · 1L · 706 lines
- `apps/server/src/keybindings.test.ts` · 1L · 744 lines
- `apps/server/src/process/externalLauncher.test.ts` · 1L · 1679 lines
- `apps/server/src/project/RepositoryIdentityResolver.test.ts` · 1L · 481 lines
- `apps/server/src/storageCleanup.ts` · 1L · 1093 lines
- `apps/server/src/usage/cliproxyApi.test.ts` · 1L · 477 lines
- `apps/server/src/usage/usageScanCache.test.ts` · 1L · 293 lines
- `apps/server/src/usage/usageScanCache.ts` · 1L · 364 lines
- `apps/server/src/workspace/WorkspaceEntries.test.ts` · 1L · 1000 lines
- `apps/server/vite.config.ts` · 1L · 139 lines

### server-persistence (1)

- `apps/server/src/persistence/ProviderSessionRuntime.ts` · 4L · 484 lines

### server-provider/mcp (8)

- `apps/server/src/mcp/McpSessionRegistry.test.ts` · 8L · 177 lines
- `apps/server/src/provider/ProviderInstanceRegistryHydration.ts` · 6L · 132 lines
- `apps/server/src/mcp/McpHttpServer.ts` · 2L · 865 lines
- `apps/server/src/mcp/toolkits/worktree/registration.test.ts` · 2L · 173 lines
- `apps/server/src/provider/ClaudeCapabilitiesProbe.test.ts` · 2L · 549 lines
- `apps/server/src/mcp/McpInvocationContext.ts` · 1L · 119 lines
- `apps/server/src/mcp/toolkits/pullRequests/handlers.ts` · 1L · 504 lines
- `apps/server/src/provider/providerCompatibility.test.ts` · 1L · 423 lines

### shared (9)

- `packages/shared/src/serverSettings.test.ts` · 4L · 1203 lines
- `packages/shared/src/serverSettings.ts` · 3L · 687 lines
- `packages/shared/src/DrainableWorker.test.ts` · 2L · 357 lines
- `packages/shared/src/projectSettings.test.ts` · 2L · 514 lines
- `packages/shared/src/composerContextReferences.test.ts` · 1L · 321 lines
- `packages/shared/src/model.ts` · 1L · 503 lines
- `packages/shared/src/shell.test.ts` · 1L · 1159 lines
- `packages/shared/src/shell.ts` · 1L · 927 lines
- `packages/shared/package.json` · 0L · 560 lines

### web-chat (16)

- `apps/web/src/components/chat/MessagesTimeline.logic.ts` · 6L · 2293 lines
- `apps/web/src/composer-logic.ts` · 5L · 379 lines
- `apps/web/src/lib/composerContextRecords.ts` · 5L · 536 lines
- `apps/web/src/components/chat/ContextWindowMeter.tsx` · 4L · 183 lines
- `apps/web/src/components/composerContextPresentation.tsx` · 4L · 461 lines
- `apps/web/src/components/chat/timelineMinimapItems.ts` · 3L · 71 lines
- `apps/web/src/composerDraftStore.test.ts` · 3L · 3560 lines
- `apps/mobile/src/state/use-composer-drafts.ts` · 2L · 2015 lines
- `apps/web/src/components/chat/ChatHeader.tsx` · 2L · 407 lines
- `apps/web/src/components/chat/SkillInlineText.tsx` · 2L · 83 lines
- `apps/web/src/session-logic.ts` · 2L · 1066 lines
- `apps/web/src/components/chat/modelPickerSearch.test.ts` · 1L · 330 lines
- `apps/web/src/components/chat/providerIconUtils.ts` · 1L · 58 lines
- `apps/web/src/lib/composerContextRecords.test.ts` · 1L · 808 lines
- `docs/user/composer.md` · 1L · 346 lines
- `apps/web/src/components/chat/modelPickerSearch.ts` · 0L · 136 lines

### web-panels/other (28)

- `apps/web/src/components/RightPanelTabs.tsx` · 24L · 1547 lines
- `apps/web/src/index.css` · 19L · 3744 lines
- `apps/web/src/rightPanelStore.test.ts` · 15L · 1518 lines
- `apps/web/src/components/ui/toast.tsx` · 6L · 823 lines
- `apps/web/src/diffPanelStore.ts` · 5L · 159 lines
- `apps/web/src/components/ThreadRouteView.tsx` · 3L · 197 lines
- `apps/web/src/components/files/projectFilesQueryState.ts` · 3L · 350 lines
- `apps/web/src/modelSelection.test.ts` · 3L · 1041 lines
- `apps/web/src/components/pullRequest/pullRequestDetail.logic.ts` · 2L · 1273 lines
- `apps/web/src/components/settings/ProviderInstanceCard.tsx` · 2L · 1296 lines
- `apps/web/src/modelSelection.ts` · 2L · 385 lines
- `apps/web/src/components/DiffWorkerPoolProvider.tsx` · 1L · 163 lines
- `apps/web/src/components/GitActionsControl.tsx` · 1L · 2112 lines
- `apps/web/src/components/pullRequest/pullRequestDetail.logic.test.ts` · 1L · 2055 lines
- `apps/web/src/components/pullRequest/pullRequestList.logic.ts` · 1L · 971 lines
- `apps/web/src/components/settings/providerDriverMeta.ts` · 1L · 37 lines
- `apps/web/src/components/ui/sidebar.tsx` · 1L · 824 lines
- `apps/web/src/components/usage/UsageProviderChart.test.ts` · 1L · 158 lines
- `apps/web/src/components/usage/usageProviders.ts` · 1L · 62 lines
- `apps/web/src/contextMenuFallback.ts` · 1L · 498 lines
- `apps/web/src/keybindings.test.ts` · 1L · 1746 lines
- `apps/web/src/keybindings.ts` · 1L · 490 lines
- `apps/web/src/reopenClosedView.ts` · 1L · 148 lines
- `apps/web/src/reviewCommentContext.ts` · 1L · 755 lines
- `apps/web/src/versionSkew.test.ts` · 1L · 249 lines
- `apps/web/src/versionSkew.ts` · 1L · 198 lines
- `apps/web/vite.config.ts` · 1L · 327 lines
- `apps/web/src/hooks/useT3ProjectFileScripts.ts` · 0L · 51 lines

### web-sidebar (4)

- `apps/web/src/components/CommandPalette.logic.ts` · 3L · 602 lines
- `apps/web/src/routes/__root.tsx` · 3L · 635 lines
- `apps/web/src/components/sidebar/SidebarChrome.tsx` · 2L · 243 lines
- `apps/web/src/routes/_chat.tsx` · 2L · 238 lines
