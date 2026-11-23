## Appendix B: exact file-to-zone partition (193 conflicted paths)

Generated from the trial merge (`classify.py`, then `tools/hunks.py`; Appendix A). Every conflicted path is in exactly one zone, each zone is one file `bNN-*.md` holding the per-hunk doctrine, and each zone belongs to one S1 lane (§2, §9). `m` = conflict markers, `L` = `loom:` lines in Loom's blob, then each hunk as `[Loom lines/upstream lines kind]`: `c` both sides have content, `B` Loom's side is empty, `o` upstream's side is empty, `A` upstream's side has no code and Loom's has a `loom` line. An `o` or `B` hunk is not a verdict: the zone file says which are upstream deletions or duplicate declarations in disguise (§7.1).

| Lane | Zone | File | Paths | Markers | `loom:` lines |
| --- | --- | --- | ---: | ---: | ---: |
| S1-lead | B.1 config, lockfile and docs | [`b01-config-docs.md`](b01-config-docs.md) | 15 | 83 | 26 |
| lane 1 server core | B.2 orchestrator, settlement, deletion, runtime layer | [`b02-orchestration.md`](b02-orchestration.md) | 10 | 27 | 118 |
| lane 1 server core | B.3 projection store, shell stream, search, persistence | [`b03-store-shell-search.md`](b03-store-shell-search.md) | 11 | 32 | 91 |
| lane 1 server core | B.4 server entry, websocket, startup, connection presentation | [`b04-server-entry.md`](b04-server-entry.md) | 11 | 18 | 97 |
| lane 1 server core | B.5 MCP server, toolkits, PR watch reactor | [`b05-mcp-tools.md`](b05-mcp-tools.md) | 9 | 17 | 34 |
| lane 2 providers and usage | B.6 Pi adapter, provider core, provider session manager | [`b06-providers.md`](b06-providers.md) | 22 | 67 | 185 |
| lane 2 providers and usage | B.7 usage hub and limits (server, shared, web, mobile) | [`b07-usage.md`](b07-usage.md) | 9 | 21 | 76 |
| lane 3 VCS and projects | B.8 VCS, projects, checkpoints, workspace, dev-runner | [`b08-vcs-project-workspace.md`](b08-vcs-project-workspace.md) | 23 | 53 | 152 |
| lane 4 web chat | B.9 web chat and the markdown renderer | [`b09-web-chat.md`](b09-web-chat.md) | 23 | 57 | 210 |
| lane 5 web panels and sidebar | B.10 web panels: files, diff, right panel, preview, PR detail | [`b10-web-panels.md`](b10-web-panels.md) | 19 | 70 | 275 |
| lane 5 web panels and sidebar | B.11 web sidebar, thread row, palette, routes | [`b11-web-sidebar.md`](b11-web-sidebar.md) | 15 | 27 | 113 |
| lane 6 client | B.12 contracts, settings, the two files upstream deleted | [`b12-contracts-settings.md`](b12-contracts-settings.md) | 15 | 20 | 100 |
| lane 6 client | B.13 mobile and the client permission tables | [`b13-mobile-client.md`](b13-mobile-client.md) | 11 | 21 | 53 |
| | **total** | | **193** | **513** | **1530** |

### B.1 config, lockfile and docs (15) · S1-lead · [`b01-config-docs.md`](b01-config-docs.md)

- `.gitignore` · 1m · 2L · 60 lines · [4/2c]
- `AGENTS.md` · 7m · 7L · 239 lines · [1/1c] [1/1c] [1/1c] [3/3c] [3/3c] [3/9c] [0/2B]
- `README.md` · 2m · 1L · 95 lines · [15/52c] [11/41c]
- `apps/server/package.json` · 2m · 0L · 109 lines · [1/1c] [3/2c]
- `apps/web/package.json` · 4m · 0L · 127 lines · [2/2c] [7/0o] [2/0o] [2/1c]
- `docs/operations/development.md` · 2m · 2L · 373 lines · [10/25c] [10/19c]
- `docs/operations/observability.md` · 1m · 3L · 741 lines · [6/4c]
- `docs/user/composer.md` · 1m · 2L · 411 lines · [4/3c]
- `docs/user/providers-acp.md` · 1m · 1L · 144 lines · [3/3c]
- `docs/user/providers-claude.md` · 1m · 2L · 183 lines · [4/3c]
- `docs/user/providers-pi.md` · 1m · 1L · 91 lines · [3/3c]
- `packages/client-runtime/package.json` · 1m · 0L · 636 lines · [3/3c]
- `packages/shared/package.json` · 1m · 0L · 624 lines · [15/3c]
- `pnpm-lock.yaml` · 56m · 0L · 24360 lines · 56 hunks
- `pnpm-workspace.yaml` · 2m · 5L · 333 lines · [5/3c] [6/4c]

### B.2 orchestrator, settlement, deletion, runtime layer (10) · lane 1 server core · [`b02-orchestration.md`](b02-orchestration.md)

- `apps/server/src/orchestration-v2/EffectWorker.ts` · 1m · 2L · 956 lines · [1/3c]
- `apps/server/src/orchestration-v2/Orchestrator.ts` · 13m · 61L · 14846 lines · [1/1c] [3/3c] [1/1c] [11/14c] [20/14c] [1/3c] [3/1c] [3/2c] [15/8c] [2/1c] [2/1c] [1/4c] [2/1c]
- `apps/server/src/orchestration-v2/RestartContinuation.ts` · 1m · 3L · 368 lines · [5/4c]
- `apps/server/src/orchestration-v2/ThreadDeletion.test.ts` · 1m · 1L · 300 lines · [1/1c]
- `apps/server/src/orchestration-v2/ThreadDeletion.ts` · 1m · 2L · 241 lines · [2/2c]
- `apps/server/src/orchestration-v2/ThreadSettlementService.test.ts` · 1m · 6L · 1821 lines · [1/1c]
- `apps/server/src/orchestration-v2/ThreadSettlementService.ts` · 5m · 18L · 753 lines · [2/1c] [16/1c] [9/4c] [4/14c] [1/1c]
- `apps/server/src/orchestration-v2/http.ts` · 1m · 2L · 291 lines · [2/1c]
- `apps/server/src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts` · 1m · 17L · 897 lines · [1/3c]
- `apps/server/src/orchestration-v2/runtimeLayer.ts` · 2m · 6L · 406 lines · [1/1c] [2/1c]

### B.3 projection store, shell stream, search, persistence (11) · lane 1 server core · [`b03-store-shell-search.md`](b03-store-shell-search.md)

- `apps/server/src/orchestration-v2/ProjectionStore.ts` · 10m · 36L · 7699 lines · [2/1c] [1/1c] [2/2c] [2/20c] [7/8c] [12/7c] [13/78c] [4/1c] [9/17c] [3/63c]
- `apps/server/src/orchestration-v2/ShellStream.test.ts` · 2m · 2L · 715 lines · [2/2c] [1/5c]
- `apps/server/src/orchestration-v2/ShellStream.ts` · 5m · 10L · 715 lines · [6/1c] [2/2c] [3/2c] [1/1c] [1/1c]
- `apps/server/src/orchestration-v2/ThreadSearch.test.ts` · 2m · 7L · 926 lines · [3/1c] [1/197c]
- `apps/server/src/orchestration-v2/ThreadSearch.ts` · 3m · 5L · 712 lines · [7/5c] [3/2c] [3/2c]
- `apps/server/src/persistence/DatabaseMaintenance.ts` · 1m · 2L · 234 lines · [1/1c]
- `apps/server/src/persistence/Sqlite.ts` · 2m · 4L · 90 lines · [5/4c] [39/19c]
- `apps/server/src/storageCleanup.ts` · 1m · 1L · 1512 lines · [2/1c]
- `packages/client-runtime/src/state/assets.test.ts` · 1m · 1L · 413 lines · [1/0o]
- `packages/client-runtime/src/state/shell.ts` · 3m · 14L · 700 lines · [4/1c] [18/2c] [6/2c]
- `packages/client-runtime/src/state/shellReducer.ts` · 2m · 9L · 291 lines · [7/1c] [5/1c]

### B.4 server entry, websocket, startup, connection presentation (11) · lane 1 server core · [`b04-server-entry.md`](b04-server-entry.md)

- `apps/server/src/binCli.ts` · 1m · 4L · 127 lines · [2/1c]
- `apps/server/src/cli/server.ts` · 1m · 1L · 98 lines · [8/12c]
- `apps/server/src/http.ts` · 1m · 2L · 746 lines · [8/2c]
- `apps/server/src/server.ts` · 1m · 15L · 1249 lines · [6/2c]
- `apps/server/src/serverRuntimeStartup.autoPull.test.ts` · 1m · 5L · 207 lines · [24/20c]
- `apps/server/src/serverRuntimeStartup.test.ts` · 1m · 9L · 405 lines · [66/57c]
- `apps/server/src/serverRuntimeStartup.ts` · 1m · 7L · 739 lines · [7/4c]
- `apps/server/src/ws.test.ts` · 2m · 15L · 1651 lines · [72/27c] [6/1c]
- `apps/server/src/ws.ts` · 5m · 35L · 3777 lines · [2/9c] [7/2c] [2/15c] [2/17c] [13/12c]
- `packages/client-runtime/src/connection/presentation.test.ts` · 1m · 1L · 222 lines · [1/2c]
- `packages/client-runtime/src/connection/presentation.ts` · 3m · 3L · 161 lines · [2/5c] [7/1c] [7/3c]

### B.5 MCP server, toolkits, PR watch reactor (9) · lane 1 server core · [`b05-mcp-tools.md`](b05-mcp-tools.md)

- `apps/server/src/mcp/McpHttpServer.ts` · 1m · 2L · 1256 lines · [1/1c]
- `apps/server/src/mcp/McpInvocationContext.ts` · 1m · 1L · 229 lines · [1/2c]
- `apps/server/src/mcp/McpSessionRegistry.test.ts` · 3m · 8L · 221 lines · [1/3c] [10/2c] [1/14c]
- `apps/server/src/mcp/McpSessionRegistry.ts` · 1m · 4L · 236 lines · [13/9c]
- `apps/server/src/mcp/OrchestratorMcpService.ts` · 7m · 12L · 3359 lines · [6/5c] [1/1c] [1/1c] [1/1c] [1/1c] [1/1c] [2/5c]
- `apps/server/src/mcp/toolkits/orchestrator/handlers.ts` · 1m · 2L · 230 lines · [3/2c]
- `apps/server/src/mcp/toolkits/pullRequests/handlers.ts` · 1m · 1L · 619 lines · [32/0o]
- `apps/server/src/orchestration-v2/PullRequestWatchReactor.ts` · 1m · 4L · 681 lines · [11/94c]
- `apps/server/src/provider/agentContextBudget.json` · 1m · 0L · 5 lines · [3/3c]

### B.6 Pi adapter, provider core, provider session manager (22) · lane 2 providers and usage · [`b06-providers.md`](b06-providers.md)

- `apps/server/src/orchestration-v2/ProviderEventIngestor.test.ts` · 1m · 3L · 2387 lines · [45/42c]
- `apps/server/src/orchestration-v2/ProviderSessionManager.test.ts` · 7m · 3L · 4448 lines · [2/1c] [0/6B] [1/1c] [3/3c] [1/1c] [1/1c] [66/58c]
- `apps/server/src/orchestration-v2/ProviderSessionManager.ts` · 5m · 23L · 2867 lines · [2/2c] [1/1c] [3/1c] [1/2c] [20/23c]
- `apps/server/src/orchestration-v2/ProviderTurnStartService.ts` · 1m · 6L · 1760 lines · [9/13c]
- `apps/server/src/orchestration-v2/testkit/ProviderReplayHarness.ts` · 1m · 3L · 585 lines · [2/10c]
- `apps/server/src/orchestration-v2/testkit/fixtures/provider_thread_resume/pi_transcript.ndjson` · 1m · 0L · 120 lines · [2/1c]
- `apps/server/src/orchestration-v2/testkit/fixtures/simple/pi_output.ts` · 1m · 1L · 110 lines · [25/22c]
- `apps/server/src/orchestration-v2/testkit/fixtures/thread_rollback/pi_transcript.ndjson` · 1m · 0L · 161 lines · [4/0o]
- `apps/server/src/orchestration-v2/testkit/fixtures/thread_rollback_after_stop/pi_transcript.ndjson` · 2m · 0L · 272 lines · [4/5c] [4/0o]
- `apps/server/src/provider/ClaudeCapabilitiesProbe.test.ts` · 2m · 4L · 227 lines · [34/2c] [98/22c]
- `apps/server/src/provider/ClaudeProvider.ts` · 4m · 8L · 1303 lines · [6/4c] [6/4c] [1/0o] [61/28c]
- `apps/server/src/provider/ProviderInstanceRegistryHydration.ts` · 1m · 6L · 230 lines · [5/2c]
- `apps/server/src/provider/ProviderRegistry.test.ts` · 1m · 15L · 3410 lines · [4/148c]
- `packages/provider-core/src/server/IdAllocator.ts` · 3m · 7L · 398 lines · [1/5c] [1/1c] [1/2c]
- `packages/provider-core/src/server/managedProvider.test.ts` · 2m · 2L · 905 lines · [5/11c] [20/64c]
- `packages/provider-core/src/server/managedProvider.ts` · 8m · 12L · 450 lines · [1/1c] [2/3c] [30/9c] [1/2c] [8/7c] [9/3c] [5/1c] [9/34c]
- `packages/provider-core/src/server/snapshot.ts` · 1m · 1L · 33 lines · [14/2c]
- `packages/provider-pi/src/server/adapter.ts` · 10m · 52L · 3862 lines · [2/1c] [7/14c] [5/0o] [4/1c] [24/2c] [120/2c] [2/2c] [1/1c] [6/1c] [9/1c]
- `packages/provider-pi/src/server/driver.ts` · 1m · 8L · 239 lines · [12/4c]
- `packages/provider-pi/src/server/mcpExtensionSource.test.ts` · 1m · 3L · 542 lines · [2/43c]
- `packages/provider-pi/src/server/mcpExtensionSource.ts` · 7m · 17L · 512 lines · [1/2c] [2/1c] [2/1c] [1/3c] [2/10c] [6/4c] [0/8B]
- `packages/provider-pi/src/server/status.ts` · 6m · 11L · 578 lines · [2/1c] [2/2c] [1/4c] [7/33c] [1/1c] [2/6c]

### B.7 usage hub and limits (server, shared, web, mobile) (9) · lane 2 providers and usage · [`b07-usage.md`](b07-usage.md)

- `apps/mobile/src/features/usage/UsageLimitsPooled.tsx` · 2m · 2L · 669 lines · [2/0o] [7/3c]
- `apps/mobile/src/features/usage/usageProviders.ts` · 1m · 3L · 60 lines · [12/1c]
- `apps/server/src/usage/UsageLimitSources.test.ts` · 2m · 2L · 295 lines · [1/0o] [119/314c]
- `apps/server/src/usage/UsageLimitSources.ts` · 2m · 12L · 422 lines · [13/2c] [6/14c]
- `apps/server/src/usage/cliproxyApi.test.ts` · 2m · 12L · 723 lines · [11/9c] [2/5c]
- `apps/server/src/usage/cliproxyApi.ts` · 6m · 21L · 731 lines · [11/9c] [8/1c] [18/3c] [141/14c] [56/2c] [14/29c]
- `apps/server/src/usage/usageScanCache.test.ts` · 1m · 1L · 346 lines · [22/17c]
- `apps/web/src/components/usage/UsageLimitsPooled.tsx` · 3m · 4L · 713 lines · [2/0o] [1/1c] [5/2c]
- `packages/shared/src/usageLimits.ts` · 2m · 19L · 1148 lines · [2/2c] [5/6c]

### B.8 VCS, projects, checkpoints, workspace, dev-runner (23) · lane 3 VCS and projects · [`b08-vcs-project-workspace.md`](b08-vcs-project-workspace.md)

- `apps/server/scripts/migrate-dev-db.ts` · 4m · 23L · 584 lines · [0/41B] [17/6c] [23/56c] [9/9c]
- `apps/server/src/assets/AssetAccess.test.ts` · 4m · 6L · 1646 lines · [23/22c] [1/1c] [1/1c] [1/1c]
- `apps/server/src/assets/AssetAccess.ts` · 4m · 6L · 1072 lines · [10/4c] [1/1c] [2/3c] [1/1c]
- `apps/server/src/checkpointing/CheckpointDiffQuery.ts` · 2m · 3L · 337 lines · [2/3c] [73/13c]
- `apps/server/src/orchestration-v2/CheckpointCaptureService.test.ts` · 1m · 4L · 1116 lines · [1/3c]
- `apps/server/src/orchestration-v2/CheckpointService.test.ts` · 1m · 2L · 102 lines · [3/1c]
- `apps/server/src/orchestration-v2/CheckpointService.ts` · 1m · 10L · 628 lines · [1/6c]
- `apps/server/src/process/externalLauncher.ts` · 1m · 2L · 875 lines · [5/10c]
- `apps/server/src/project/ProjectService.test.ts` · 2m · 7L · 879 lines · [43/89c] [2/1A]
- `apps/server/src/project/ProjectService.ts` · 1m · 11L · 666 lines · [18/41c]
- `apps/server/src/project/ProjectSetupScriptRunner.test.ts` · 1m · 2L · 203 lines · [2/2c]
- `apps/server/src/project/RepositoryIdentityResolver.test.ts` · 1m · 2L · 364 lines · [26/32c]
- `apps/server/src/vcs/GitVcsDriver.ts` · 6m · 2L · 1616 lines · [2/1c] [3/5c] [5/8c] [4/4c] [4/27c] [6/15c]
- `apps/server/src/vcs/GitVcsDriverCore.test.ts` · 3m · 3L · 6931 lines · [115/1c] [2/64c] [16/39c]
- `apps/server/src/vcs/GitVcsDriverCore.ts` · 6m · 11L · 5493 lines · [9/14c] [0/36B] [7/20c] [16/14c] [6/10c] [1/2c]
- `apps/server/src/vcs/VcsStatusBroadcaster.test.ts` · 2m · 5L · 1569 lines · [2/1c] [128/41c]
- `apps/server/src/vcs/VcsStatusBroadcaster.ts` · 7m · 14L · 1048 lines · [1/2c] [3/4c] [14/56c] [0/32B] [174/55c] [30/6c] [0/84B]
- `apps/server/src/workspace/WorkspaceFileSystem.test.ts` · 1m · 3L · 1103 lines · [14/23c]
- `apps/server/src/workspace/WorkspaceFileSystem.ts` · 1m · 6L · 906 lines · [10/9c]
- `apps/server/src/workspace/WorkspaceSearchIndex.ts` · 1m · 4L · 601 lines · [2/2c]
- `packages/client-runtime/src/state/projectCommands.ts` · 1m · 2L · 252 lines · [34/1c]
- `scripts/dev-runner.test.ts` · 1m · 10L · 940 lines · [9/10c]
- `scripts/dev-runner.ts` · 1m · 14L · 1053 lines · [0/10B]

### B.9 web chat and the markdown renderer (23) · lane 4 web chat · [`b09-web-chat.md`](b09-web-chat.md)

- `apps/web/src/components/ChatMarkdown.browser.test.tsx` · 2m · 6L · 540 lines · [3/7c] [19/13c]
- `apps/web/src/components/ChatMarkdown.tsx` · 11m · 28L · 1958 lines · [4/18c] [5/1c] [22/8c] [3/3c] [19/3c] [10/4c] [25/1c] [3/2c] [9/7c] [31/6c] [12/12c]
- `apps/web/src/components/ChatView.tsx` · 7m · 40L · 4197 lines · [13/6c] [19/8c] [3/4c] [10/11c] [4/2c] [3/2c] [6/5c]
- `apps/web/src/components/chat/ChatComposer.tsx` · 2m · 6L · 3778 lines · [6/11c] [6/0o]
- `apps/web/src/components/chat/ComposerCommandMenu.tsx` · 1m · 1L · 296 lines · [5/4c]
- `apps/web/src/components/chat/ComposerFooterControls.tsx` · 3m · 4L · 416 lines · [7/1c] [4/0o] [16/0o]
- `apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx` · 1m · 7L · 363 lines · [2/2c]
- `apps/web/src/components/chat/MarkdownFileLink.tsx` · 1m · 3L · 429 lines · [65/3c]
- `apps/web/src/components/chat/MarkdownThreadLink.browser.test.tsx` · 4m · 4L · 162 lines · [5/5c] [1/5c] [10/8c] [6/81c]
- `apps/web/src/components/chat/MarkdownThreadLink.tsx` · 5m · 8L · 92 lines · [1/4c] [1/1c] [11/19c] [7/7c] [14/1c]
- `apps/web/src/components/chat/MessagesTimeline.logic.ts` · 1m · 7L · 2708 lines · [3/2c]
- `apps/web/src/components/chat/MessagesTimeline.tsx` · 2m · 25L · 1803 lines · [2/1c] [7/4c]
- `apps/web/src/components/chat/ThreadNow.tsx` · 1m · 5L · 122 lines · [20/10c]
- `apps/web/src/components/chat/TimelineAssistantRows.tsx` · 2m · 4L · 393 lines · [2/5c] [7/2c]
- `apps/web/src/components/chat/TimelineUserMessageRow.tsx` · 1m · 14L · 1229 lines · [6/5c]
- `apps/web/src/components/chat/TimelineWorkEntryRow.tsx` · 1m · 2L · 634 lines · [18/10c]
- `apps/web/src/components/chat/UserMessageContextChips.tsx` · 2m · 14L · 624 lines · [1/3c] [8/2c]
- `apps/web/src/components/chat/useComposerMenuItems.ts` · 3m · 8L · 446 lines · [3/3c] [6/8c] [8/11c]
- `apps/web/src/components/chat/useComposerSend.ts` · 1m · 7L · 1586 lines · [2/2c]
- `apps/web/src/components/composerContextPresentation.tsx` · 2m · 7L · 511 lines · [1/2c] [1/1c]
- `apps/web/src/session-logic.ts` · 1m · 2L · 1149 lines · [2/5c]
- `packages/shared/src/composerContextReferences.test.ts` · 1m · 1L · 539 lines · [2/48c]
- `packages/shared/src/composerContextReferences.ts` · 2m · 7L · 478 lines · [4/2c] [16/9c]

### B.10 web panels: files, diff, right panel, preview, PR detail (19) · lane 5 web panels and sidebar · [`b10-web-panels.md`](b10-web-panels.md)

- `apps/web/src/components/DiffPanel.tsx` · 13m · 37L · 1635 lines · [8/3c] [3/0o] [1/1c] [1/1c] [13/17c] [13/12c] [4/2c] [4/5c] [7/15c] [45/42c] [12/8c] [2/1c] [9/1c]
- `apps/web/src/components/GitActionsControl.tsx` · 1m · 1L · 1933 lines · [45/0o]
- `apps/web/src/components/RightPanelTabs.tsx` · 3m · 23L · 1627 lines · [2/2c] [4/2c] [5/4c]
- `apps/web/src/components/diffs/AnnotatableCodeView.tsx` · 4m · 20L · 438 lines · [2/1c] [16/1c] [3/1c] [1/2c]
- `apps/web/src/components/diffs/useCodeViewFileReveal.ts` · 3m · 3L · 48 lines · [1/6c] [11/82c] [2/1c]
- `apps/web/src/components/files/FileBrowserPanel.tsx` · 8m · 21L · 639 lines · [2/3c] [9/2c] [5/1c] [3/1c] [2/2c] [2/4c] [1/1c] [11/15c]
- `apps/web/src/components/files/FilePreviewPanel.tsx` · 14m · 66L · 2027 lines · [1/9c] [26/1c] [10/27c] [13/38c] [1/1c] [1/1c] [14/17c] [1/7c] [29/21c] [6/1c] [14/68c] [1/4c] [1/1c] [37/32c]
- `apps/web/src/components/files/filePreviewMode.ts` · 1m · 1L · 68 lines · [4/4c]
- `apps/web/src/components/preview/PreviewView.tsx` · 2m · 7L · 1079 lines · [0/2B] [2/1c]
- `apps/web/src/components/pullRequest/pullRequestDetail.logic.test.ts` · 2m · 4L · 1861 lines · [2/1c] [6/31c]
- `apps/web/src/components/pullRequest/pullRequestDetail.logic.ts` · 1m · 5L · 1503 lines · [5/4c]
- `apps/web/src/index.css` · 1m · 28L · 4111 lines · [136/0o]
- `apps/web/src/lib/composerContextRecords.ts` · 1m · 7L · 558 lines · [2/6c]
- `apps/web/src/lib/diffRendering.ts` · 3m · 1L · 356 lines · [17/25c] [0/6B] [0/4B]
- `apps/web/src/markdown-links.ts` · 2m · 7L · 426 lines · [4/18c] [8/12c]
- `apps/web/src/reviewCommentContext.test.ts` · 1m · 1L · 403 lines · [1/1c]
- `apps/web/src/rightPanelStore.ts` · 7m · 34L · 1502 lines · [2/0o] [4/12c] [1/7c] [2/6c] [8/10c] [4/6c] [1/14c]
- `apps/web/src/terminal-links.ts` · 2m · 4L · 233 lines · [4/4c] [3/2c]
- `apps/web/vite.config.ts` · 1m · 5L · 439 lines · [7/0o]

### B.11 web sidebar, thread row, palette, routes (15) · lane 5 web panels and sidebar · [`b11-web-sidebar.md`](b11-web-sidebar.md)

- `apps/web/src/components/CommandPalette.logic.ts` · 2m · 4L · 910 lines · [2/0o] [1/6c]
- `apps/web/src/components/CommandPalette.tsx` · 2m · 7L · 2968 lines · [1/1c] [1/2c]
- `apps/web/src/components/CommandPaletteThreadItems.tsx` · 1m · 6L · 298 lines · [70/19c]
- `apps/web/src/components/NoProjectsHero.tsx` · 1m · 2L · 63 lines · [4/3c]
- `apps/web/src/components/Sidebar.tsx` · 2m · 21L · 3747 lines · [15/1c] [3/1c]
- `apps/web/src/components/ThreadNotificationCoordinator.tsx` · 1m · 5L · 425 lines · [5/2c]
- `apps/web/src/components/ThreadRouteView.tsx` · 1m · 5L · 237 lines · [3/3c]
- `apps/web/src/components/ThreadSearchMatch.tsx` · 1m · 4L · 67 lines · [14/9c]
- `apps/web/src/components/ThreadStatusIndicators.tsx` · 1m · 1L · 894 lines · [36/1c]
- `apps/web/src/components/sidebar/SidebarThreadRow.tsx` · 8m · 39L · 1888 lines · [13/2c] [3/3c] [3/1c] [14/1c] [1/1c] [11/6c] [3/1c] [2/0o]
- `apps/web/src/composer-logic.ts` · 2m · 5L · 383 lines · [12/2c] [13/0o]
- `apps/web/src/hooks/useThreadActionMenu.ts` · 2m · 5L · 376 lines · [2/1c] [2/8c]
- `apps/web/src/routes/__root.tsx` · 1m · 6L · 402 lines · [33/19c]
- `apps/web/src/routes/_chat.tsx` · 1m · 2L · 79 lines · [25/5c]
- `apps/web/src/state/entities.ts` · 1m · 1L · 452 lines · [16/4c]

### B.12 contracts, settings, the two files upstream deleted (15) · lane 6 client · [`b12-contracts-settings.md`](b12-contracts-settings.md)

- `apps/web/src/components/chat/ContextWindowMeter.tsx` · 0m · 4L · 184 lines · UD: deleted upstream, modified by Loom · 
- `apps/web/src/components/settings/ProviderModelsSection.tsx` · 4m · 6L · 693 lines · [6/2c] [15/15c] [10/4c] [1/1c]
- `apps/web/src/components/settings/ProviderSettingsPanel.tsx` · 1m · 5L · 1473 lines · [3/12c]
- `apps/web/src/components/settings/SettingsPanels.tsx` · 3m · 6L · 2119 lines · [2/1c] [2/1c] [2/31c]
- `apps/web/src/components/settings/settingsSearch.ts` · 2m · 4L · 1538 lines · [1/6c] [1/5c]
- `apps/web/src/components/settings/useAvailableSettingsSearchItems.ts` · 2m · 4L · 65 lines · [1/2c] [1/5c]
- `apps/web/src/editorPreferences.ts` · 1m · 2L · 136 lines · [4/2c]
- `apps/web/src/keybindings.ts` · 1m · 1L · 497 lines · [13/10c]
- `apps/web/src/modelSelection.test.ts` · 1m · 10L · 1374 lines · [30/20c]
- `apps/web/src/modelSelection.ts` · 1m · 6L · 453 lines · [2/1c]
- `packages/contracts/src/index.ts` · 1m · 4L · 79 lines · [1/1c]
- `packages/contracts/src/orchestrationV2.ts` · 1m · 26L · 4419 lines · [5/9c]
- `packages/contracts/src/settings.test.ts` · 1m · 8L · 719 lines · [37/3c]
- `packages/contracts/src/settings.ts` · 1m · 13L · 1963 lines · [6/0o]
- `patches/@pierre%2Fdiffs@1.6.1.patch` · 0m · 1L · 1106 lines · UD: deleted upstream, modified by Loom · 

### B.13 mobile and the client permission tables (11) · lane 6 client · [`b13-mobile-client.md`](b13-mobile-client.md)

- `apps/mobile/src/features/files/ThreadFilesRouteScreen.tsx` · 1m · 8L · 1052 lines · [3/2c]
- `apps/mobile/src/features/files/WorkspaceFilePreviewError.tsx` · 1m · 3L · 63 lines · [9/3c]
- `apps/mobile/src/features/home/HomeRouteScreen.tsx` · 1m · 1L · 239 lines · [7/6c]
- `apps/mobile/src/features/keyboard/CommandPalette.tsx` · 1m · 3L · 755 lines · [2/2c]
- `apps/mobile/src/features/threads/PendingUserInputCard.tsx` · 3m · 4L · 358 lines · [1/1c] [25/26c] [29/18c]
- `apps/mobile/src/features/threads/ThreadFeed.tsx` · 7m · 13L · 4061 lines · [5/8c] [1/1c] [1/4c] [2/1c] [1/116c] [2/1c] [1/1c]
- `apps/mobile/src/features/threads/ThreadNavigationSidebar.tsx` · 1m · 5L · 717 lines · [19/34c]
- `apps/mobile/src/features/threads/thread-list-v2-items.tsx` · 1m · 9L · 1578 lines · [3/2c]
- `apps/mobile/src/features/threads/thread-search-match.tsx` · 2m · 3L · 82 lines · [3/1c] [2/28c]
- `packages/client-runtime/src/state/commandPermissions.test.ts` · 1m · 2L · 649 lines · [55/3c]
- `packages/contracts/src/clientRpcPermissions.ts` · 2m · 2L · 109 lines · [1/1c] [6/4c]
