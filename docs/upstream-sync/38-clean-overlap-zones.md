# 38 — Clean-overlap zones for Gate 2 (pull 13)

The 144 files both sides changed since `07d38b8d17` that git merged without a marker, split
into the four Gate 2 reviews of runbook §9. S3 recomputed the set from the merge commit's
parents (`20b1d6f162` × `b76a110aa4`): `git merge-tree --write-tree` gives the same 173
conflicted paths as S0, and the 317 paths both sides changed since the base, less those 173,
are exactly runbook Appendix C (an empty diff against its list).

`L` = lines mentioning `loom` in the merged file and `lines` its length (S0's counts).
**post-merge** = a later S2/S3 commit on this branch also touched the file, so read it at the
branch tip, not at the merge commit `5d2d0d25af`. Method per file (doc 29): read upstream's
change (`07d38b8d17..b76a110aa4`), Loom's hunks (`07d38b8d17..7935f6a1ec`) and what Loom
carries on top of upstream at the branch tip (`b76a110aa4..HEAD`); disposition **n/a /
kept-compatible / adapted / DEFECT / loom behaviour changed**. Tables go in
`38-clean-overlap-review.md`.

The server-provider/mcp zone (8) goes to 2a rather than 2b (pull 12 put it in 2b): §6.1's MCP
seams (`McpHttpServer.ts`, the hosted gate, `OrchestratorMcpService.ts`) are orchestration
seams, and §9's 2b count (32) is server-other + provider packages + persistence without it.

## Gate 2a — server core, orchestration and MCP seams (32)

Also read (runbook §6.1–§6.3, §9's Gate 2 row; not in the silently merged set unless noted):

- `apps/server/src/orchestration-v2/ShellStream.ts` (upstream-only, #24648/#24723) with Loom's `keepsLoomChildInColdShell` in `apps/server/src/loom/projection/loomShellJoin.ts` (DL-1404, DL-1453): the two marked `||`s
- `packages/client-runtime/src/state/threadFamilies.ts`, `packages/client-runtime/src/state/olderSettledThreads.ts` (upstream-only): a Loom child loaded on family open, the older-settled shelf beside Loom's sidebar sections
- `apps/server/src/orchestration-v2/GuestShareDecider.ts` (upstream-only, #24104): a guest cannot reach a Loom tool or ws method (§6.3)
- `apps/server/src/mcp/OrchestratorMcpService.ts` (upstream-only this pull): `t3_background_wait` withheld by construction (DL-1454)
- `apps/server/src/orchestration-v2/DelegatedTaskQuestionReactor.ts` (upstream-only): inert for a Loom child (§6.1 row 1)
- `apps/server/src/orchestration-v2/Orchestrator.ts` (conflicted, Rule D): DL-1460 moved Loom's rule 0 above upstream's read watermark
- `apps/server/src/orchestration-v2/ProjectionMaintenance.ts` is in this zone's list; its DL-1300 guard is read in 2b
- the §6.1 seam table, row by row

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

### server-provider/mcp (8)

- `apps/server/src/mcp/McpSessionRegistry.test.ts` · 8L · 219 lines
- `apps/server/src/provider/ClaudeProvider.ts` · 8L · 1252 lines · post-merge
- `apps/server/src/provider/builtInDrivers.ts` · 4L · 41 lines · post-merge
- `apps/server/src/mcp/McpHttpServer.ts` · 2L · 1055 lines
- `apps/server/src/mcp/McpInvocationContext.ts` · 1L · 125 lines
- `apps/server/src/mcp/toolkits/pullRequests/handlers.ts` · 1L · 525 lines
- `apps/server/src/provider/ProviderInstanceRegistry.test.ts` · 1L · 650 lines
- `apps/server/src/provider/providerCompatibility.test.ts` · 1L · 300 lines

## Gate 2b — server other, provider packages, persistence (32)

Also read:

- `apps/server/src/orchestration-v2/ProjectionMaintenance.ts` (listed under 2a): the DL-1300 V1 Loom-history guard in `compactEventStore` (S3's boot counts the rows before and after the first compaction)
- `apps/server/src/persistence/DatabaseMaintenance.ts` (upstream-only file, one marked Loom line): `rebuildThreadSearchIndex` after `rebuildMessageSearch` (DL-1452; S3's `t3 doctor --fix` dry run)
- `apps/server/src/storageCleanup.ts` (listed here): #23900 lets a deleted thread clean the worktree its remaining subagents share; Loom children run in the parent's worktree, so read it against the location rule (§8.3)
- `apps/server/src/vcs/GitVcsDriverCore.ts` (conflicted; Gate 1 read it): DL-1461's stderr fold now only for unclassified failures
- `apps/server/src/persistence/Migrations/069_ThreadMessageSearch.ts` (upstream) beside Loom's 1063 `ThreadSearchTextGuard` (DL-1495): both trigger families on `orchestration_v2_projection_messages`

### server-other (18)

- `apps/server/src/usage/cliproxyApi.ts` · 30L · 730 lines · post-merge
- `apps/server/src/observability/RpcInstrumentation.ts` · 18L · 279 lines
- `apps/server/src/project/ProjectService.ts` · 12L · 619 lines · post-merge
- `apps/server/integration/transferBudgetV2.integration.test.ts` · 6L · 421 lines
- `apps/server/src/checkpointing/CheckpointStore.ts` · 6L · 189 lines
- `apps/server/src/ws.test.ts` · 5L · 894 lines · post-merge
- `apps/server/src/git/GitManager.ts` · 4L · 3301 lines
- `apps/server/src/workspace/WorkspaceSearchIndex.ts` · 4L · 592 lines · post-merge
- `apps/server/src/git/GitWorkflowService.ts` · 3L · 562 lines
- `apps/server/src/project/ProjectService.deletion.test.ts` · 3L · 533 lines · post-merge
- `apps/server/src/process/externalLauncher.ts` · 2L · 867 lines
- `apps/server/src/relay/AgentAwarenessRelay.ts` · 2L · 854 lines
- `apps/server/src/serverSettings.ts` · 2L · 1181 lines
- `apps/server/src/diagnostics/ProcessResourceMonitor.ts` · 1L · 231 lines · post-merge
- `apps/server/src/keybindings.test.ts` · 1L · 574 lines
- `apps/server/src/storageCleanup.ts` · 1L · 1282 lines
- `apps/server/src/usage/usageScanCache.ts` · 1L · 380 lines
- `apps/server/src/workspace/WorkspaceEntries.test.ts` · 1L · 637 lines

### provider-packages (12)

- `packages/provider-core/src/server/ProviderAdapter.ts` · 4L · 652 lines
- `packages/provider-pi/package.json` · 3L · 61 lines
- `packages/provider-core/src/server/textGenerationPrompts.ts` · 2L · 526 lines · post-merge
- `packages/provider-core/src/server/usageLimits.test.ts` · 2L · 171 lines
- `packages/provider-pi/src/server/adapter.test.ts` · 2L · 4341 lines
- `packages/provider-pi/src/server/rpc.ts` · 2L · 423 lines · post-merge
- `packages/provider-pi/src/server/status.ts` · 2L · 483 lines
- `packages/provider-pi/src/server/textGeneration.ts` · 2L · 148 lines
- `packages/provider-pi/src/settings.ts` · 2L · 44 lines
- `packages/provider-testing/src/fakeCli.ts` · 2L · 89 lines
- `packages/provider-core/src/server/managedProvider.test.ts` · 1L · 697 lines
- `packages/provider-core/src/server/snapshot.ts` · 1L · 28 lines

### server-persistence (2)

- `apps/server/src/persistence/ProviderSessionRuntime.ts` · 4L · 486 lines · post-merge
- `apps/server/src/persistence/initializeV2Database.test.ts` · 3L · 192 lines

## Gate 2c — web and client-runtime (48)

Also read:

- `apps/web/src/loom/review/FileChangeView.tsx`: the `@pierre/diffs` 1.6.1 worker logs `Theme "pierre-dark" has not been resolved` in light mode while rendering correctly (DL-1478 (4)); check whether upstream's own `DiffPanel` logs it too
- the S2b re-homes into upstream's new modules (DL-1419) and the restored search surfaces (DL-1494)

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
- `apps/web/src/composer-logic.ts` · 5L · 415 lines · post-merge
- `apps/web/src/lib/composerContextRecords.ts` · 5L · 535 lines · post-merge
- `apps/web/src/markdown-links.ts` · 5L · 452 lines · post-merge
- `apps/web/src/reopenClosedView.test.ts` · 4L · 199 lines
- `apps/web/src/state/threads.ts` · 3L · 145 lines
- `apps/web/src/components/pullRequest/pullRequestDetail.logic.test.ts` · 2L · 1510 lines
- `apps/web/src/components/sidebar/SidebarChrome.tsx` · 2L · 243 lines
- `apps/web/src/hooks/useSettings.test.ts` · 2L · 343 lines
- `apps/web/src/components/GitActionsControl.tsx` · 1L · 2122 lines · post-merge
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

### client-runtime (9)

- `packages/client-runtime/src/state/shellReducer.ts` · 6L · 202 lines
- `packages/client-runtime/src/connection/driver.ts` · 5L · 255 lines · post-merge
- `packages/client-runtime/src/state/orchestrationV2Projection.ts` · 2L · 421 lines
- `packages/client-runtime/src/state/projectCommands.ts` · 2L · 253 lines
- `packages/client-runtime/src/rpc/session.test.ts` · 1L · 1045 lines
- `packages/client-runtime/src/state/models.ts` · 1L · 398 lines
- `packages/client-runtime/src/state/server.test.ts` · 1L · 1158 lines
- `packages/client-runtime/src/state/sharedSettings.test.ts` · 1L · 95 lines
- `packages/client-runtime/src/state/threadSearch.test.ts` · 1L · 251 lines · post-merge

## Gate 2d — contracts, shared, mobile, desktop, root config, docs (32)

Also read:

- `scripts/dev-runner.ts` (conflicted, Rule D): DL-1500, upstream's first-start seeding now targets Loom's port-scoped worktree home
- Loom lines that cannot carry a marker (§8.2): `scripts/effect-budget.json` (DL-1473), `apps/web/package.json` `mermaid` and `jsdom` (DL-1470, DL-1301), root `package.json` scripts (DL-1415)

### contracts (7)

- `packages/contracts/src/providerRuntime.ts` · 11L · 1270 lines · post-merge
- `packages/contracts/src/editor.ts` · 5L · 350 lines
- `packages/contracts/src/model.ts` · 4L · 229 lines · post-merge
- `packages/contracts/src/providerUsageLimits.ts` · 4L · 208 lines · post-merge
- `packages/contracts/src/server.ts` · 4L · 946 lines · post-merge
- `packages/contracts/src/keybindings.ts` · 3L · 250 lines
- `packages/contracts/src/baseSchemas.ts` · 2L · 348 lines

### shared (7)

- `packages/shared/src/usageLimits.ts` · 24L · 1043 lines · post-merge
- `packages/shared/src/composerContextReferences.ts` · 6L · 379 lines
- `packages/shared/src/serverSettings.ts` · 3L · 693 lines
- `packages/shared/src/keybindings.ts` · 2L · 505 lines
- `packages/shared/src/composerContextReferences.test.ts` · 1L · 328 lines
- `packages/shared/src/model.ts` · 1L · 525 lines
- `packages/shared/src/shell.ts` · 1L · 998 lines · post-merge

### mobile (3)

- `apps/mobile/src/features/threads/thread-list-v2-items.tsx` · 4L · 1442 lines
- `apps/mobile/src/state/use-thread-composer-state.ts` · 2L · 924 lines · post-merge
- `apps/mobile/src/features/keyboard/commandPaletteItems.ts` · 1L · 110 lines

### desktop (3)

- `apps/desktop/src/preview/Manager.test.ts` · 2L · 2555 lines
- `apps/desktop/src/preview/Manager.ts` · 1L · 3719 lines
- `apps/desktop/src/settings/DesktopClientSettings.test.ts` · 1L · 267 lines

### root/config/scripts (5)

- `packages/client-runtime/package.json` · 30L · 541 lines
- `packages/shared/package.json` · 9L · 571 lines
- `scripts/lib/cli-external-packages.ts` · 1L · 95 lines
- `apps/server/package.json` · 0L · 95 lines
- `package.json` · 0L · 76 lines

### docs/config (7)

- `docs/user/source-control.md` · 3L · 355 lines
- `docs/README.md` · 1L · 71 lines
- `docs/user/composer.md` · 1L · 352 lines
- `docs/user/providers-claude.md` · 1L · 172 lines
- `docs/user/usage.md` · 1L · 187 lines
- `docs/user/keybindings.md` · 0L · 196 lines
- `third-party-licenses.config.json` · 0L · 884 lines
