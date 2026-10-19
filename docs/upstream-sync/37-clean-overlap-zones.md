# 37 — Clean-overlap zones for Gate 2 (pull 12)

The 172 files both sides changed since `737192594f` that git merged without a marker,
split into the four Gate 2 reviews of runbook §8. S3 recomputed the set from the merge
commit's parents (`13d7e62a9b` × `07d38b8d17`, `git merge-tree` for the 101 conflicted
paths, name-status M/R on both sides for the rest): it is exactly runbook Appendix C.

`L` = `loom:` lines in the merged file (S0's count). **post-merge** = a later S2/S3 commit
on this branch also touched the file, so read the file at the branch tip, not at `ddaaf837bb`.
Method per file (doc 29): read upstream's change (`737192594f..07d38b8d17`), Loom's hunks
(`737192594f..02a2297b61`) and what Loom carries on top of upstream at the branch tip
(`07d38b8d17..HEAD`); disposition **n/a / kept-compatible / adapted / DEFECT / loom behaviour
changed**. Tables go in `37-clean-overlap-review.md`.

## Gate 2a — server core and the orchestration seams (28)

Also read (named in runbook §4.2 / §8; not in the silently merged set):

- `apps/server/src/storageCleanup.ts` (silently merged; listed under 2b too) — #19748 `worktreeOwner()` on Loom's shared-worktree workstreams
- `packages/client-runtime/src/state/threadShell.ts` — #19630 `pendingSubagentRequestsByThread` on Loom children (DL-1270 relies on it)
- `apps/server/src/orchestration-v2/DelegatedTaskQuestionReactor.ts` (upstream-only) — its early returns on a Loom child (no `app_owned` record)
- the §4.2 seam table, row by row

### server-core (28)

- `apps/server/src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts` · 17L
- `apps/server/src/orchestration-v2/CheckpointService.ts` · 10L
- `apps/server/src/serverRuntimeStartup.ts` · 9L
- `apps/server/src/serverRuntimeStartup.autoPull.test.ts` · 7L
- `apps/server/src/auth/RpcAuthorization.ts` · 6L
- `apps/server/src/cli/config.ts` · 5L
- `apps/server/src/orchestration-v2/ProviderTurnStartService.ts` · 5L
- `apps/server/src/orchestration-v2/V1ImportBoundary.test.ts` · 5L · post-merge
- `apps/server/src/auth/SessionStore.ts` · 3L
- `apps/server/src/orchestration-v2/boundedSnapshotTransport.test.ts` · 3L
- `apps/server/src/orchestration-v2/runtimeLayer.test.ts` · 3L
- `apps/server/src/orchestration-v2/testkit/ProviderReplayHarness.ts` · 3L
- `apps/server/src/orchestration-v2/CheckpointCaptureService.test.ts` · 2L
- `apps/server/src/orchestration-v2/EffectWorker.ts` · 2L
- `apps/server/src/orchestration-v2/ProjectSettingsUpgrade.integration.test.ts` · 2L
- `apps/server/src/orchestration-v2/ProviderSessionManager.test.ts` · 2L
- `apps/server/src/orchestration-v2/ProviderTurnControlService.ts` · 2L
- `apps/server/src/orchestration-v2/ThreadDeletion.ts` · 2L
- `apps/server/src/orchestration-v2/ThreadManagementService.ts` · 2L
- `apps/server/src/orchestration-v2/ThreadSettlementService.test.ts` · 2L
- `apps/server/src/orchestration-v2/http.ts` · 2L
- `apps/server/src/orchestration-v2/legacy/LegacyV1Cutover.integration.test.ts` · 2L
- `apps/server/src/orchestration-v2/testkit/OrchestratorScenario.ts` · 2L
- `apps/server/src/orchestration-v2/Orchestrator.control-reads.test.ts` · 1L
- `apps/server/src/orchestration-v2/ProjectionControlReads.test.ts` · 1L
- `apps/server/src/orchestration-v2/ProjectionSettlement.test.ts` · 1L
- `apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.ts` · 1L
- `apps/server/src/orchestration-v2/testkit/fixtures/simple/pi_output.ts` · 1L

## Gate 2b — server other, provider packages, persistence, provider/MCP (60)

Also read (S3 findings):

- `apps/server/src/persistence/DatabaseStorage.ts` and `apps/server/src/orchestration-v2/ProjectionMaintenance.ts` (upstream-only, #19435) — the online history compaction that S3's timing comparison traced the first-boot slowdown to (DL-1295)
- `packages/provider-core/src/server/usageLimits.ts` / `managedProvider.ts` — Loom's silent-probe rule against upstream's org-switch clearing (DL-1291)

### server-other (38)

- `apps/server/src/project/ProjectSetupScriptRunner.ts` · 13L
- `apps/server/src/project/ProjectService.ts` · 11L
- `apps/server/src/serverSettings.test.ts` · 10L
- `apps/server/scripts/migrate-dev-db.ts` · 9L
- `apps/server/src/assets/AssetAccess.test.ts` · 7L
- `apps/server/integration/transferBudgetV2.integration.test.ts` · 6L
- `apps/server/src/project/ProjectService.test.ts` · 6L
- `apps/server/src/ws.test.ts` · 6L
- `apps/server/src/project/ProjectSetupScriptRunner.test.ts` · 5L
- `apps/server/src/terminal/Manager.ts` · 5L
- `apps/server/src/usage/cliproxyApi.ts` · 5L
- `apps/server/src/observability/RpcInstrumentation.ts` · 4L
- `apps/server/src/vcs/GitVcsDriverCore.test.ts` · 4L
- `apps/server/src/workspace/WorkspaceSearchIndex.ts` · 4L
- `apps/server/src/checkpointing/CheckpointDiffQuery.ts` · 3L
- `apps/server/src/git/GitWorkflowService.ts` · 3L
- `apps/server/src/project/ProjectService.deletion.test.ts` · 3L
- `apps/server/src/usage/UsageLimitSources.ts` · 3L
- `apps/server/src/assets/AssetAccess.ts` · 2L
- `apps/server/src/binCli.ts` · 2L
- `apps/server/src/git/GitManager.test.ts` · 2L
- `apps/server/src/git/GitManager.ts` · 2L
- `apps/server/src/http.test.ts` · 2L
- `apps/server/src/process/externalLauncher.ts` · 2L
- `apps/server/src/serverSettings.ts` · 2L
- `apps/server/src/workspace/WorkspaceEntries.ts` · 2L
- `apps/server/src/workspace/WorkspaceFileSystem.test.ts` · 2L
- `apps/server/src/cloud/ManagedEndpointRuntime.ts` · 1L
- `apps/server/src/http.ts` · 1L
- `apps/server/src/keybindings.test.ts` · 1L
- `apps/server/src/process/externalLauncher.test.ts` · 1L
- `apps/server/src/project/RepositoryIdentityResolver.test.ts` · 1L
- `apps/server/src/storageCleanup.ts` · 1L
- `apps/server/src/usage/cliproxyApi.test.ts` · 1L · post-merge
- `apps/server/src/usage/usageScanCache.test.ts` · 1L
- `apps/server/src/usage/usageScanCache.ts` · 1L
- `apps/server/src/workspace/WorkspaceEntries.test.ts` · 1L
- `apps/server/vite.config.ts` · 1L

### provider-packages (13)

- `packages/provider-pi/src/server/mcpExtensionSource.ts` · 16L
- `packages/provider-pi/src/server/mcpInjection.ts` · 7L
- `packages/provider-core/src/server/ProviderAdapter.ts` · 4L
- `packages/provider-pi/src/server/driver.ts` · 4L
- `packages/provider-core/src/server/notification.ts` · 2L
- `packages/provider-core/src/server/textGenerationPrompts.ts` · 2L · post-merge
- `packages/provider-pi/src/server/mcpExtensionSource.test.ts` · 2L
- `packages/provider-pi/src/server/rpc.ts` · 2L
- `packages/provider-pi/src/server/status.ts` · 2L
- `packages/provider-testing/src/fakeCli.ts` · 2L
- `packages/provider-core/src/server/managedProvider.test.ts` · 1L
- `packages/provider-core/src/server/snapshot.ts` · 1L
- `packages/provider-opencode/src/server/OpenCodeRuntime.ts` · 1L

### server-persistence (1)

- `apps/server/src/persistence/ProviderSessionRuntime.ts` · 4L

### server-provider/mcp (8)

- `apps/server/src/mcp/McpSessionRegistry.test.ts` · 8L
- `apps/server/src/provider/ProviderInstanceRegistryHydration.ts` · 6L
- `apps/server/src/mcp/McpHttpServer.ts` · 2L
- `apps/server/src/mcp/toolkits/worktree/registration.test.ts` · 2L
- `apps/server/src/provider/ClaudeCapabilitiesProbe.test.ts` · 2L
- `apps/server/src/mcp/McpInvocationContext.ts` · 1L
- `apps/server/src/mcp/toolkits/pullRequests/handlers.ts` · 1L
- `apps/server/src/provider/providerCompatibility.test.ts` · 1L

## Gate 2c — web and client-runtime (58)

### web-chat (16)

- `apps/web/src/components/chat/MessagesTimeline.logic.ts` · 6L
- `apps/web/src/composer-logic.ts` · 5L
- `apps/web/src/lib/composerContextRecords.ts` · 5L
- `apps/web/src/components/chat/ContextWindowMeter.tsx` · 4L
- `apps/web/src/components/composerContextPresentation.tsx` · 4L
- `apps/web/src/components/chat/timelineMinimapItems.ts` · 3L
- `apps/web/src/composerDraftStore.test.ts` · 3L
- `apps/mobile/src/state/use-composer-drafts.ts` · 2L
- `apps/web/src/components/chat/ChatHeader.tsx` · 2L
- `apps/web/src/components/chat/SkillInlineText.tsx` · 2L
- `apps/web/src/session-logic.ts` · 2L
- `apps/web/src/components/chat/modelPickerSearch.test.ts` · 1L
- `apps/web/src/components/chat/providerIconUtils.ts` · 1L
- `apps/web/src/lib/composerContextRecords.test.ts` · 1L
- `docs/user/composer.md` · 1L
- `apps/web/src/components/chat/modelPickerSearch.ts` · 0L

### web-panels/other (28)

- `apps/web/src/components/RightPanelTabs.tsx` · 24L
- `apps/web/src/index.css` · 19L
- `apps/web/src/rightPanelStore.test.ts` · 15L · post-merge
- `apps/web/src/components/ui/toast.tsx` · 6L
- `apps/web/src/diffPanelStore.ts` · 5L
- `apps/web/src/components/ThreadRouteView.tsx` · 3L
- `apps/web/src/components/files/projectFilesQueryState.ts` · 3L · post-merge
- `apps/web/src/modelSelection.test.ts` · 3L
- `apps/web/src/components/pullRequest/pullRequestDetail.logic.ts` · 2L
- `apps/web/src/components/settings/ProviderInstanceCard.tsx` · 2L
- `apps/web/src/modelSelection.ts` · 2L
- `apps/web/src/components/DiffWorkerPoolProvider.tsx` · 1L
- `apps/web/src/components/GitActionsControl.tsx` · 1L
- `apps/web/src/components/pullRequest/pullRequestDetail.logic.test.ts` · 1L
- `apps/web/src/components/pullRequest/pullRequestList.logic.ts` · 1L
- `apps/web/src/components/settings/providerDriverMeta.ts` · 1L
- `apps/web/src/components/ui/sidebar.tsx` · 1L
- `apps/web/src/components/usage/UsageProviderChart.test.ts` · 1L
- `apps/web/src/components/usage/usageProviders.ts` · 1L
- `apps/web/src/contextMenuFallback.ts` · 1L
- `apps/web/src/keybindings.test.ts` · 1L
- `apps/web/src/keybindings.ts` · 1L
- `apps/web/src/reopenClosedView.ts` · 1L
- `apps/web/src/reviewCommentContext.ts` · 1L
- `apps/web/src/versionSkew.test.ts` · 1L
- `apps/web/src/versionSkew.ts` · 1L
- `apps/web/vite.config.ts` · 1L
- `apps/web/src/hooks/useT3ProjectFileScripts.ts` · 0L

### web-sidebar (4)

- `apps/web/src/components/CommandPalette.logic.ts` · 3L
- `apps/web/src/routes/__root.tsx` · 3L
- `apps/web/src/components/sidebar/SidebarChrome.tsx` · 2L
- `apps/web/src/routes/_chat.tsx` · 2L

### client-runtime (10)

- `packages/client-runtime/src/state/shell.ts` · 13L
- `packages/client-runtime/src/state/shellReducer.ts` · 6L
- `packages/client-runtime/src/connection/presentation.ts` · 3L
- `packages/client-runtime/src/state/orchestrationV2Projection.ts` · 2L
- `packages/client-runtime/src/state/projectCommands.ts` · 2L
- `packages/client-runtime/src/connection/presentation.test.ts` · 1L
- `packages/client-runtime/src/rpc/session.test.ts` · 1L
- `packages/client-runtime/src/state/models.ts` · 1L
- `packages/client-runtime/src/state/server.test.ts` · 1L
- `packages/client-runtime/package.json` · 0L

## Gate 2d — contracts, shared, mobile, desktop, root config, docs (26)

### contracts (6)

- `packages/contracts/src/providerRuntime.ts` · 11L
- `packages/contracts/src/project.ts` · 9L
- `packages/contracts/src/model.ts` · 4L
- `packages/contracts/src/keybindings.ts` · 3L
- `packages/contracts/src/baseSchemas.ts` · 2L
- `packages/contracts/src/composerContext.test.ts` · 2L

### shared (9)

- `packages/shared/src/serverSettings.test.ts` · 4L
- `packages/shared/src/serverSettings.ts` · 3L
- `packages/shared/src/DrainableWorker.test.ts` · 2L
- `packages/shared/src/projectSettings.test.ts` · 2L
- `packages/shared/src/composerContextReferences.test.ts` · 1L
- `packages/shared/src/model.ts` · 1L
- `packages/shared/src/shell.test.ts` · 1L
- `packages/shared/src/shell.ts` · 1L
- `packages/shared/package.json` · 0L

### mobile (3)

- `apps/mobile/src/features/files/ThreadFilesRouteScreen.tsx` · 1L
- `apps/mobile/src/features/keyboard/commandPaletteItems.ts` · 1L
- `apps/mobile/src/features/threads/QuestionAnswerHistory.test.tsx` · 0L

### desktop (2)

- `apps/desktop/src/preview/Manager.test.ts` · 2L
- `apps/desktop/src/preview/Manager.ts` · 1L

### root/config/scripts (5)

- `scripts/dev-runner.ts` · 5L
- `vite.config.ts` · 5L
- `.gitignore` · 2L
- `AGENTS.md` · 1L
- `scripts/lib/cli-external-packages.ts` · 1L

### docs (1)

- `docs/operations/development.md` · 1L
