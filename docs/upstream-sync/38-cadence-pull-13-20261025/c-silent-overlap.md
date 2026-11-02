## Appendix C: silently merged overlap (144 files)

Both sides changed these since the base and git merged them without a marker.
`L` = lines mentioning `loom` in the merged file (a superset of `loom:`
markers). Gate 2 reads every file with a `loom` line (140) plus the upstream-only
files named in §6.1 and §6.2 (`ShellStream.ts`, `threadFamilies.ts`,
`olderSettledThreads.ts`, `GuestShareDecider.ts`, `DelegatedTaskQuestionReactor.ts`).

| zone | files | with `loom` | `loom` lines |
| --- | ---: | ---: | ---: |
| client-runtime | 9 | 9 | 20 |
| contracts | 7 | 7 | 33 |
| desktop | 3 | 3 | 4 |
| docs/config | 7 | 5 | 7 |
| mobile | 3 | 3 | 7 |
| provider-packages | 12 | 12 | 25 |
| root/config/scripts | 5 | 3 | 40 |
| server-core | 24 | 24 | 89 |
| server-other | 18 | 18 | 102 |
| server-persistence | 2 | 2 | 7 |
| server-provider/mcp | 8 | 8 | 26 |
| shared | 7 | 7 | 38 |
| web-chat | 10 | 10 | 37 |
| web-panels/other | 28 | 28 | 117 |
| web-sidebar | 1 | 1 | 3 |
| **total** | **144** | **140** | **555** |

### client-runtime (9)

- `packages/client-runtime/src/state/shellReducer.ts` · 6L · 202 lines
- `packages/client-runtime/src/connection/driver.ts` · 5L · 255 lines
- `packages/client-runtime/src/state/orchestrationV2Projection.ts` · 2L · 421 lines
- `packages/client-runtime/src/state/projectCommands.ts` · 2L · 253 lines
- `packages/client-runtime/src/rpc/session.test.ts` · 1L · 1045 lines
- `packages/client-runtime/src/state/models.ts` · 1L · 398 lines
- `packages/client-runtime/src/state/server.test.ts` · 1L · 1158 lines
- `packages/client-runtime/src/state/sharedSettings.test.ts` · 1L · 95 lines
- `packages/client-runtime/src/state/threadSearch.test.ts` · 1L · 251 lines

### contracts (7)

- `packages/contracts/src/providerRuntime.ts` · 11L · 1270 lines
- `packages/contracts/src/editor.ts` · 5L · 350 lines
- `packages/contracts/src/model.ts` · 4L · 229 lines
- `packages/contracts/src/providerUsageLimits.ts` · 4L · 208 lines
- `packages/contracts/src/server.ts` · 4L · 946 lines
- `packages/contracts/src/keybindings.ts` · 3L · 250 lines
- `packages/contracts/src/baseSchemas.ts` · 2L · 348 lines

### desktop (3)

- `apps/desktop/src/preview/Manager.test.ts` · 2L · 2555 lines
- `apps/desktop/src/preview/Manager.ts` · 1L · 3719 lines
- `apps/desktop/src/settings/DesktopClientSettings.test.ts` · 1L · 267 lines

### docs/config (7)

- `docs/user/source-control.md` · 3L · 355 lines
- `docs/README.md` · 1L · 71 lines
- `docs/user/composer.md` · 1L · 352 lines
- `docs/user/providers-claude.md` · 1L · 172 lines
- `docs/user/usage.md` · 1L · 187 lines
- `docs/user/keybindings.md` · 0L · 196 lines
- `third-party-licenses.config.json` · 0L · 884 lines

### mobile (3)

- `apps/mobile/src/features/threads/thread-list-v2-items.tsx` · 4L · 1442 lines
- `apps/mobile/src/state/use-thread-composer-state.ts` · 2L · 924 lines
- `apps/mobile/src/features/keyboard/commandPaletteItems.ts` · 1L · 110 lines

### provider-packages (12)

- `packages/provider-core/src/server/ProviderAdapter.ts` · 4L · 652 lines
- `packages/provider-pi/package.json` · 3L · 61 lines
- `packages/provider-core/src/server/textGenerationPrompts.ts` · 2L · 526 lines
- `packages/provider-core/src/server/usageLimits.test.ts` · 2L · 171 lines
- `packages/provider-pi/src/server/adapter.test.ts` · 2L · 4341 lines
- `packages/provider-pi/src/server/rpc.ts` · 2L · 423 lines
- `packages/provider-pi/src/server/status.ts` · 2L · 483 lines
- `packages/provider-pi/src/server/textGeneration.ts` · 2L · 148 lines
- `packages/provider-pi/src/settings.ts` · 2L · 44 lines
- `packages/provider-testing/src/fakeCli.ts` · 2L · 89 lines
- `packages/provider-core/src/server/managedProvider.test.ts` · 1L · 697 lines
- `packages/provider-core/src/server/snapshot.ts` · 1L · 28 lines

### root/config/scripts (5)

- `packages/client-runtime/package.json` · 30L · 541 lines
- `packages/shared/package.json` · 9L · 571 lines
- `scripts/lib/cli-external-packages.ts` · 1L · 95 lines
- `apps/server/package.json` · 0L · 95 lines
- `package.json` · 0L · 76 lines

### server-core (24)

- `apps/server/src/orchestration-v2/CheckpointService.ts` · 18L · 640 lines
- `apps/server/src/auth/RpcAuthorization.ts` · 12L · 318 lines
- `apps/server/src/orchestration-v2/runtimeLayer.ts` · 7L · 395 lines
- `apps/server/src/serverRuntimeStartup.autoPull.test.ts` · 7L · 215 lines
- `apps/server/src/orchestration-v2/ProjectionMaintenance.ts` · 4L · 403 lines
- `apps/server/src/orchestration-v2/ProviderTurnStartService.ts` · 4L · 1386 lines
- `apps/server/src/orchestration-v2/PullRequestWatchReactor.ts` · 4L · 649 lines
- `apps/server/src/auth/SessionStore.ts` · 3L · 1109 lines
- `apps/server/src/orchestration-v2/boundedSnapshotTransport.test.ts` · 3L · 654 lines
- `apps/server/src/orchestration-v2/legacy/LegacyV1Cutover.integration.test.ts` · 3L · 1033 lines
- `apps/server/src/orchestration-v2/runtimeLayer.test.ts` · 3L · 6873 lines
- `apps/server/src/orchestration-v2/testkit/ProviderReplayHarness.ts` · 3L · 554 lines
- `apps/server/src/orchestration-v2/RestartContinuation.ts` · 2L · 326 lines
- `apps/server/src/orchestration-v2/ThreadDeletion.ts` · 2L · 241 lines
- `apps/server/src/orchestration-v2/ThreadManagementService.ts` · 2L · 1307 lines
- `apps/server/src/orchestration-v2/ThreadSettlementService.test.ts` · 2L · 1431 lines
- `apps/server/src/orchestration-v2/http.test.ts` · 2L · 298 lines
- `apps/server/src/orchestration-v2/testkit/OrchestratorScenario.ts` · 2L · 734 lines
- `apps/server/src/orchestration-v2/EffectWorker.ts` · 1L · 923 lines
- `apps/server/src/orchestration-v2/Orchestrator.control-reads.test.ts` · 1L · 1412 lines
- `apps/server/src/orchestration-v2/ProviderTurnControlService.ts` · 1L · 406 lines
- `apps/server/src/orchestration-v2/ThreadDeletion.test.ts` · 1L · 300 lines
- `apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.ts` · 1L · 124 lines
- `apps/server/src/orchestration-v2/testkit/fixtures/simple/pi_output.ts` · 1L · 110 lines

### server-other (18)

- `apps/server/src/usage/cliproxyApi.ts` · 30L · 730 lines
- `apps/server/src/observability/RpcInstrumentation.ts` · 18L · 279 lines
- `apps/server/src/project/ProjectService.ts` · 12L · 619 lines
- `apps/server/integration/transferBudgetV2.integration.test.ts` · 6L · 421 lines
- `apps/server/src/checkpointing/CheckpointStore.ts` · 6L · 189 lines
- `apps/server/src/ws.test.ts` · 5L · 894 lines
- `apps/server/src/git/GitManager.ts` · 4L · 3301 lines
- `apps/server/src/workspace/WorkspaceSearchIndex.ts` · 4L · 592 lines
- `apps/server/src/git/GitWorkflowService.ts` · 3L · 562 lines
- `apps/server/src/project/ProjectService.deletion.test.ts` · 3L · 533 lines
- `apps/server/src/process/externalLauncher.ts` · 2L · 867 lines
- `apps/server/src/relay/AgentAwarenessRelay.ts` · 2L · 854 lines
- `apps/server/src/serverSettings.ts` · 2L · 1181 lines
- `apps/server/src/diagnostics/ProcessResourceMonitor.ts` · 1L · 231 lines
- `apps/server/src/keybindings.test.ts` · 1L · 574 lines
- `apps/server/src/storageCleanup.ts` · 1L · 1282 lines
- `apps/server/src/usage/usageScanCache.ts` · 1L · 380 lines
- `apps/server/src/workspace/WorkspaceEntries.test.ts` · 1L · 637 lines

### server-persistence (2)

- `apps/server/src/persistence/ProviderSessionRuntime.ts` · 4L · 486 lines
- `apps/server/src/persistence/initializeV2Database.test.ts` · 3L · 192 lines

### server-provider/mcp (8)

- `apps/server/src/mcp/McpSessionRegistry.test.ts` · 8L · 219 lines
- `apps/server/src/provider/ClaudeProvider.ts` · 8L · 1252 lines
- `apps/server/src/provider/builtInDrivers.ts` · 4L · 41 lines
- `apps/server/src/mcp/McpHttpServer.ts` · 2L · 1055 lines
- `apps/server/src/mcp/McpInvocationContext.ts` · 1L · 125 lines
- `apps/server/src/mcp/toolkits/pullRequests/handlers.ts` · 1L · 525 lines
- `apps/server/src/provider/ProviderInstanceRegistry.test.ts` · 1L · 650 lines
- `apps/server/src/provider/providerCompatibility.test.ts` · 1L · 300 lines

### shared (7)

- `packages/shared/src/usageLimits.ts` · 24L · 1043 lines
- `packages/shared/src/composerContextReferences.ts` · 6L · 379 lines
- `packages/shared/src/serverSettings.ts` · 3L · 693 lines
- `packages/shared/src/keybindings.ts` · 2L · 505 lines
- `packages/shared/src/composerContextReferences.test.ts` · 1L · 328 lines
- `packages/shared/src/model.ts` · 1L · 525 lines
- `packages/shared/src/shell.ts` · 1L · 998 lines

### web-chat (10)

- `apps/web/src/components/chat/MessagesTimeline.logic.ts` · 7L · 2525 lines
- `apps/web/src/components/chat/ModelPickerContent.tsx` · 6L · 1028 lines
- `apps/web/src/components/chat/RightPanelSurfaceContent.tsx` · 5L · 270 lines
- `apps/web/src/components/composerContextPresentation.tsx` · 4L · 481 lines
- `apps/web/src/components/chat/ComposerPendingUserInputPanel.navigation.browser.test.tsx` · 3L · 188 lines
- `apps/web/src/components/chat/composerFocusRedirect.ts` · 3L · 88 lines
- `apps/web/src/components/chat/modelPickerSearch.ts` · 3L · 136 lines
- `apps/web/src/components/chat/timelineMinimapItems.ts` · 3L · 114 lines
- `apps/web/src/session-logic.ts` · 2L · 1158 lines
- `apps/web/src/components/chat/ComposerCommandMenu.tsx` · 1L · 277 lines

### web-panels/other (28)

- `apps/web/src/components/RightPanelTabs.tsx` · 25L · 1533 lines
- `apps/web/src/components/settings/ProviderModelsSection.tsx` · 16L · 678 lines
- `apps/web/src/components/settings/ProviderSettingsPanel.tsx` · 13L · 1484 lines
- `apps/web/src/components/settings/ProviderInstanceCard.tsx` · 7L · 1280 lines
- `apps/web/src/components/ui/toast.tsx` · 7L · 824 lines
- `apps/web/src/components/usage/UsageLimitsPooled.tsx` · 7L · 713 lines
- `apps/web/src/composer-logic.ts` · 5L · 415 lines
- `apps/web/src/lib/composerContextRecords.ts` · 5L · 535 lines
- `apps/web/src/markdown-links.ts` · 5L · 452 lines
- `apps/web/src/reopenClosedView.test.ts` · 4L · 199 lines
- `apps/web/src/state/threads.ts` · 3L · 145 lines
- `apps/web/src/components/pullRequest/pullRequestDetail.logic.test.ts` · 2L · 1510 lines
- `apps/web/src/components/sidebar/SidebarChrome.tsx` · 2L · 243 lines
- `apps/web/src/hooks/useSettings.test.ts` · 2L · 343 lines
- `apps/web/src/components/GitActionsControl.tsx` · 1L · 2122 lines
- `apps/web/src/components/diffs/AnnotatableCodeView.tsx` · 1L · 310 lines
- `apps/web/src/components/files/FileMarkdownPreview.tsx` · 1L · 30 lines
- `apps/web/src/components/files/filePreviewMode.ts` · 1L · 84 lines
- `apps/web/src/components/pullRequest/PullRequestCodeTab.tsx` · 1L · 1490 lines
- `apps/web/src/components/pullRequest/pullRequestList.logic.ts` · 1L · 1067 lines
- `apps/web/src/components/ui/sidebar.tsx` · 1L · 840 lines
- `apps/web/src/composer-logic.test.ts` · 1L · 590 lines
- `apps/web/src/contextMenuFallback.ts` · 1L · 502 lines
- `apps/web/src/editorPreferences.test.ts` · 1L · 72 lines
- `apps/web/src/keybindings.ts` · 1L · 493 lines
- `apps/web/src/lib/diffRendering.ts` · 1L · 359 lines
- `apps/web/src/state/entities.ts` · 1L · 455 lines
- `apps/web/src/versionSkew.ts` · 1L · 184 lines

### web-sidebar (1)

- `apps/web/src/routes/_chat.tsx` · 3L · 251 lines
