# 40: Pull 15 clean-overlap semantic review (Gate 2)

The 187 files both sides changed since the merge-base `fa31b66bbb` that git merged **without** a
conflict marker (runbook doc 40 Appendix C; zone lists in `clean-overlap-zones.md`), plus the
extra reads the zones file names. Each was read three ways: upstream's change
(`fa31b66bbb..3fa57b92a2`), Loom's hunks before the merge (`fa31b66bbb..ce1bdbcd96`) and what Loom
carries on top of upstream at the branch tip (`3fa57b92a2..HEAD`), and dispositioned **n/a /
kept-compatible / adapted / DEFECT / loom behaviour changed**, as in doc 29 and doc 39. Four
read-only reviewers split the list by zone (Gate 2a to 2d); each appends its own section below.

---

## Clean-overlap semantic review, Gate 2a: server core and MCP seams (38 files + 9 extra reads)

Refs: base `fa31b66bbb`, loom `ce1bdbcd96`, upstream `3fa57b92a2`, merged = branch tip `688d38030f`.
Reviewer: thread `thread:mcp:b55997f1-0508-49a3-a752-d3c313374c13:workstream-scaffold:8edd8671-04a7-477a-ad51-c840fcf687de:0`, read-only (`git`/`rg`/read tool; no tests, installs or servers).

**Machine check.** For all 47 files, the sorted `+`/`-` lines of `fa31b66bbb..ce1bdbcd96` were compared with those of `3fa57b92a2..HEAD`. 41 are byte-identical (the 6 extra reads Loom never touched trivially: it changed nothing and carries nothing). The 6 that differ are all accounted for: `ProjectionMaintenance.ts` (DL-1811, the guard re-homed into upstream's two prune passes), `ws.test.ts` and `CheckpointCaptureService.test.ts` (DL-1836; `ws.test.ts` adds one whitespace re-indent beside the marked `.omit(...)` line), `runtimeLayer.test.ts` (DL-1893), `ProviderInstanceRegistry.test.ts` (DL-1891: pull 12's DL-1291 amendment removed on purpose), and `ClaudeProvider.ts`, whose only difference is Loom's `type ServerProviderModel` import, which upstream now adds itself. No Loom code line was lost.

**Totals (47 rows):** n/a 6 · kept-compatible 36 · adapted 5 · DEFECT 0 · loom behaviour changed 0.

**The history guard's surroundings.** Upstream's `pruneEventStore` publishes `event-log-pruned-through` before deleting, and `ws.ts` is its only reader (four sites, all resync-from-snapshot for a client cursor below it). No Loom module replays application events from a cursor: the only Loom reads of `orchestration_events` are `LoomStore.history` (filtered by `aggregate_kind = 'thread'` and `HISTORY_EVENT_TYPES`, exactly the guard's two clauses), `ToolOutputImageReclaim.loom.ts` (rewrites in place, so a pruned row is simply not rewritten) and `loomMigrate.loom.ts` (copies, §8.3). In this zone `LegacyV1ThreadImporter.ts`'s V1 `thread.consult-recorded` reads run only before a thread's transcript import, and the V1 pass deletes only threads whose `transcript_imported_at` is set; the V2 pass never touches V1 rows. `DatabaseStorage.ts` only renames the call; the `compacted-at` breadcrumb is still written after every pass and nothing in Loom reads it.

**Settlement, three rules together.** All three `resolveAutoSettlementAt` call sites still pass `loomFinishedRootAt` (DL-1705), Loom's blocker filter still runs before upstream's candidate list, and #527's "pending lookup" (`undefined`) still holds a finished root with a branch until its PR is known not to be open. Upstream's #20058 change to `isSnoozed` reads `pendingRuntimeRequest`, which the shell SQL still filters by `loom.blocking`, so a Loom open question neither blocks nor wakes a snooze. #31857's `closeOnSettle` runs on `thread.settled` after Loom has decided. The six remaining `hasBlockingPendingRequest` sites in `Orchestrator.ts` (in-flight check, limit-recovery configure, two restart/limit continuation guards, rule-0 veto, idle-child probe) read exactly as at `ce1bdbcd96`; only the snooze guard took upstream's `kind !== "user_input"` (DL-1805).

**Upstream ahead of a Loom handler (DL-1895's shape).** Looked for at every Loom hunk in the zone; none found. `ProviderEventIngestor.ts` still has one turn-item write path and Loom's `toolOutputImageStore.persist` is on it; `AgentAwarenessRelay.ts`'s `isLoomEventType` early return still precedes upstream's switch (now with `thread.tags-updated`); `PullRequestWatchReactor.ts`'s `loomChildren` set is built before the loop that calls `endsWithoutRead`, and upstream's `GROUP_READS` semaphore only bounds `readGroup`, which a Loom child now reaches as before; `McpHttpServer.ts`'s new `provideRegistrationServices`, `withToolSpans` and `withToolAnalytics` wrap only `toolkitRegistration` toolkits, while `LoomToolkitRegistrationLive` registers with `server.addTool` and reads `McpInvocationContext` from the request fiber, which upstream's reshaped auth middleware still provides per request (`requireWorkstreamCaller` and the hosted/thread-less refusals unchanged; `layerInProcessMcpServer` is test-only).

| # | file | upstream change consumed by loom | disposition | note / fix |
| --- | --- | --- | --- | --- |
| 1 | `apps/server/src/persistence/OrchestrationEventStore.ts` | `EVENT_LOG_PRUNED_THROUGH`/`EVENT_LOG_PRUNE_MARK`, `prunedThroughSequence`; global replay pinned to the application-sequence index | n/a | No Loom lines. No Loom reader replays from a cursor (see "history guard" above). |
| 2 | `apps/server/src/persistence/DatabaseStorage.ts` | `compactEventStore` → `pruneEventStore` | n/a | Loop, 10 % duty slicing and `compacted-at` write unchanged. |
| 3 | `apps/server/src/orchestration-v2/ProjectionMaintenance.ts` | full rewrite: day-old prune mark, V2 pass keeps stream heads/`thread.created`/running `run.updated`, V1 pass for imported threads | adapted | DL-1811 (DL-1803, DL-1823): both marked clauses present, `aggregate_kind = 'thread'` matches `LoomStore.history`'s filter; S3 proved the counts. |
| 4 | `apps/server/src/mcp/McpHttpServer.ts` | `layerMcpTransport(registrations)`, `provideRegistrationServices`, per-tool spans, auth middleware split, `requestUrl` | kept-compatible | `LoomToolkitRegistrationLive` still in `layerTools`; its `addTool` handler is untouched by the new wrappers and still gets the request's `McpInvocationContext`. Its calls are traced by `registration.callLoomTool`, not upstream's `mcp.tool.*` span. |
| 5 | `apps/server/src/orchestration-v2/RestartContinuation.ts` | none (upstream unchanged) | kept-compatible | DL-690/DL-1708 stash hunks intact. A `/clear` run is a context boundary for later runs; a continuation of a cut fresh-context run is a later run, so the stashed steer lands in the new session. |
| 6 | `apps/server/src/telemetry/ProviderUsageAnalytics.ts` | new module (#29001), replaces `ProviderEventIngestor.layerAnalytics` | n/a | No Loom reader; `server.ts` hunk took upstream's layer (Gate 1). |
| 7 | `apps/server/src/scheduledTasks/ScheduledTaskService.ts` | `threadMode` (080), `fresh_session` sends `freshContext` | n/a | §6.3 holds; Loom's `SCHEDULING` family and `bindToCurrentThread` unchanged. |
| 8 | `apps/server/src/orchestration-v2/ThreadForkService.ts` | side chats no longer forced to `approval-required` | n/a | Loom children cannot start side chats (pull 14 §8.1). |
| 9 | `apps/server/src/orchestration-v2/DelegatedTaskQuestionReactor.ts` | none; #32573 changed `OrchestratorMcpService.ts`/`ProviderContinuationService.ts`/`Orchestrator.ts` | n/a | Everything #32573 touches is keyed on `app_owned` task records or `delegatedCompletion`; `workstream_spawn` creates neither, and 079's delivery index excludes Loom children. Stays inert for Loom children. |
| 10 | `apps/server/src/observability/RpcInstrumentation.ts` | 7 new upstream methods mapped | kept-compatible | Loom's 21 `LOOM_WS_METHODS` aggregates unchanged. |
| 11 | `apps/server/src/orchestration-v2/ThreadSettlementService.ts` | #20058 `isSnoozed`, #31857 `closeOnSettle`, `.git`-aware lookup cwd, `BackgroundGitWork`, `SecureRandom` | kept-compatible | See "Settlement" above. |
| 12 | `apps/server/src/auth/RpcAuthorization.ts` | 6 new upstream method scopes | kept-compatible | Loom's scopes unchanged and still right: writes Operate, reads Read, hub login ProvidersManage, review FilesystemRead, out-of-workspace files FilesystemRead. |
| 13 | `apps/server/src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts` | three reads made `readOnly` | kept-compatible | DL-610 columns and T3 consult interleave intact; consult reads precede the V1 prune (see above). |
| 14 | `apps/server/src/serverRuntimeStartup.test.ts` | `SecureRandom` | kept-compatible | |
| 15 | `apps/server/src/ws.test.ts` | 237-line replay rewrite, new shell-stream cases | adapted | DL-1836: `provideLoomShellServices`, `WsRpcGroup.omit(...LOOM_WS_METHODS)`; the extra re-indent is whitespace only. |
| 16 | `apps/server/src/orchestration-v2/ThreadSearch.ts` | short non-ASCII word spellings (`shortSpellings`) | kept-compatible | Loom's `title`/`updatedAt` columns sit beside the new filter in both SELECT arms. |
| 17 | `apps/server/src/serverRuntimeStartup.ts` | `SecureRandom`, `server.shutdown` span | kept-compatible | `home.provenance` still first, `loom.recovery` still after V2 recovery; Pi auto-bootstrap default intact. |
| 18 | `apps/server/integration/transferBudgetV2.integration.test.ts` | small case changes | kept-compatible | Loom's goal/cache/store/consult layers serve them. |
| 19 | `apps/server/src/orchestration-v2/runtimeLayer.ts` | `WorktreeBranchSync.layer` in `layerProduction` | kept-compatible | `LoomStore.layer` and `LoomSessionComposerLive` wiring intact. Note F1. |
| 20 | `apps/server/src/orchestration-v2/ProviderTurnStartService.ts` | rolled-back turns excluded from a native fork, `ProviderAdapterThreadInUseError` fails instead of a fresh session, side-chat policy removed, `runSettled` analytics | kept-compatible | Loom's run-less fork source: `sourceRun === undefined` still resolves via `runlessForkSourceProviderThread`; the rolled-back filter needs no `sourceRun`. `loom` author label still carried. |
| 21 | `apps/server/src/binCli.ts` | `NodeCrypto.layer`, `__service-launcher`, `speechWorkerCommand` | kept-compatible | `goal` and `loom-migrate` still registered. |
| 22 | `apps/server/src/orchestration-v2/PullRequestWatchReactor.ts` | `GROUP_READS` semaphore, `providerFailureReason` (host failures keep the watch), head SHA fallback | kept-compatible | DL-474 hunks intact and upstream of the semaphore (see above). |
| 23 | `apps/server/src/orchestration-v2/runtimeLayer.test.ts` | repeated host-read-failure cases | adapted | DL-1893: per-case workspace root (migration 1018). |
| 24 | `apps/server/src/auth/SessionStore.ts` | `PayloadSigner`, `SecureRandom` | kept-compatible | Loom's `Cause.pretty` on two warnings intact. |
| 25 | `apps/server/src/orchestration-v2/CheckpointCaptureService.test.ts` | late-capture case | adapted | DL-1836: `LoomStoreV2` mock. |
| 26 | `apps/server/src/orchestration-v2/ProjectSettingsUpgrade.integration.test.ts` | small changes | kept-compatible | Loom ledger table seed (DL-177) intact. |
| 27 | `apps/server/src/orchestration-v2/ProviderEventIngestor.test.ts` | analytics moved | kept-compatible | |
| 28 | `apps/server/src/orchestration-v2/ProviderEventIngestor.ts` | analytics moved to `telemetry/` | kept-compatible | One turn-item write path; Loom's `persist` on it. |
| 29 | `apps/server/src/orchestration-v2/http.ts` | history cursor decode via `Result.try` | kept-compatible | `loomSnapshotGoals` on the snapshot intact. |
| 30 | `apps/server/src/orchestration-v2/legacy/LegacyV1Cutover.integration.test.ts` | new cases | kept-compatible | Loom ledger seed intact. |
| 31 | `apps/server/src/orchestration-v2/testkit/ProviderReplayHarness.ts` | harness tweaks | kept-compatible | |
| 32 | `apps/server/src/orchestration-v2/CheckpointService.test.ts` | two lines | kept-compatible | |
| 33 | `apps/server/src/orchestration-v2/Orchestrator.control-reads.test.ts` | new cases | kept-compatible | Loom's corrupt-plan-row variant intact. |
| 34 | `apps/server/src/orchestration-v2/RestartContinuation.test.ts` | two `ProviderRuntimeRecovery` shutdown cases | kept-compatible | DL-1708 case intact; upstream's cases do not touch `continueRestartedRun`. |
| 35 | `apps/server/src/orchestration-v2/ThreadManagementService.ts` | `freshContext` on send, `settleAfterRun` waits out automatic follow-ups, new read pass-throughs | kept-compatible | Loom's `thread.spawn`/`thread.fork.prepare` hydration ids intact. `settleAfterRun` has no Loom caller. |
| 36 | `apps/server/src/orchestration-v2/testkit/OrchestratorScenario.ts` | tweaks | kept-compatible | |
| 37 | `apps/server/src/relay/AgentAwarenessRelay.ts` | `EnvironmentSigningKey`, `getAgentAwarenessSnapshot`, tombstone rework | kept-compatible | Loom-event early return precedes the switch. |
| 38 | `apps/server/src/http.ts` | `requestUrl`, `Schema.TaggedError` | kept-compatible | Loom's mutable-asset revalidate override intact. |
| 39 | `apps/server/src/orchestration-v2/EffectWorker.ts` | notifications also queue on follow-up retry | kept-compatible | Loom's `loom` field still carried on the retried send. |
| 40 | `apps/server/src/mcp/McpSessionRegistry.test.ts` | `SecureRandom`/`Digest` | kept-compatible | |
| 41 | `apps/server/src/provider/ClaudeProvider.ts` | gateway model discovery grace, reported models, `withUltracodeToggle` | kept-compatible | Machine-check diff is only the shared `ServerProviderModel` import. Loom's probe spawn still installed via `spawnClaudeCodeProcess`; Claude is unregistered on Loom. |
| 42 | `apps/server/src/mcp/McpSessionRegistry.ts` | `SecureRandom`/`Digest` | kept-compatible | Loom's exact-capability issue and consult-fork `client` intact. |
| 43 | `apps/server/src/mcp/toolkits/thread/tools.ts` | `SecureRandom` | kept-compatible | |
| 44 | `apps/server/src/mcp/McpInvocationContext.ts` | `webOrigin` → `hostedAppUrl` | kept-compatible | `workstream` capability intact; outside clients cannot reach Loom tools. |
| 45 | `apps/server/src/mcp/toolkits/pullRequests/handlers.ts` | `threadNotFound` helper | kept-compatible | DL-471 Loom-child watch exemption intact. |
| 46 | `apps/server/src/provider/ProviderInstanceRegistry.test.ts` | Antigravity/OpenCode secret cases | adapted | DL-1891: back to upstream's expectation. |
| 47 | `apps/server/src/provider/providerCompatibility.test.ts` | small changes | kept-compatible | |

**Follow-ups (not merge work).**

- F1. `WorktreeBranchSync` (new upstream layer, row 19) rewrites `branch` on every thread whose worktree's checkout changes. Loom children share their root's worktree, so their branch labels and #527's branch PR lookup now follow `git checkout` there. `pnpm ship` does not switch branches, and a linked PR answers settlement without a lookup, so nothing is expected to change; S4's "finished root with an open PR stays active" journey covers it.

---

## Clean-overlap semantic review, Gate 2d: contracts, shared, mobile, desktop, docs and config (49 files + 3 extra)

Refs: base `fa31b66bbb`, loom `ce1bdbcd96`, upstream `3fa57b92a2`, merged = branch tip `688d38030f`.
Reviewer: thread `thread:mcp:b55997f1-0508-49a3-a752-d3c313374c13:workstream-scaffold:8edd8671-04a7-477a-ad51-c840fcf687de:3`, read-only (`git`/`rg`; no tests, installs or servers).

**Machine check.** For every file, the sorted `+`/`-` lines of `fa31b66bbb..ce1bdbcd96` were compared with those of `3fa57b92a2..HEAD`. 48 of 49 carry Loom's hunks byte-identical. The one that differs is `knip.jsonc`, where S3 added the marked `packages/provider-kiro` entry (row 46). No Loom line was lost. The three extra reads are `clientRpcPermissions.ts` (conflicted in S1), `settings.ts` (the standing defaults) and `AGENTS.md`.

**Totals (52 rows):** n/a 0 · kept-compatible 50 · adapted 1 · DEFECT 1 · loom behaviour changed 0.

| # | file | upstream change consumed by loom | disposition | note / fix |
| --- | --- | --- | --- | --- |
| 1 | `packages/contracts/src/orchestrationV2.ts` | `freshContext` on runs, user-message turn items and the send command; thread `tags` on app thread and shell, `thread.tag.set`, `thread.tags-updated`; `thread.settle.expectedLatestRunId`; `extensionStatuses`; `modelSwitch`; new reads `getThreadTitles`, `getThreadLinkMetadata`, `getNativeChildWork` | kept-compatible | Loom's spliced union members (sidecar events, client/internal commands, goal/consult/cache shell items) share no type literal with upstream's new ones (checked against every literal in `orchestrationV2.loom.ts`). `OrchestrationV2ThreadShellJson` is a `mapFields` of the shell, so `tags` and Loom's `workstream` both ride it; Loom's `openQuestions` override still decodes with its default. `role` on `thread.create`, `loom` on messages and runtime requests, `costUsd`, `header`, `start_if_idle` and `subscribeShell.loom` intact. |
| 2 | `packages/contracts/src/rpc.ts` | `providerAuthRemoveMethod`, `sourceControlStar`, `subscribeVcsBranch`, `vcsRefreshBranch`, the three orchestration reads, `providerCatalogsOnDemand`, `pullRequestsRunAction` returns a summary | kept-compatible | Loom's absolute-path read/list/locate RPCs and `...LoomWsRpcs` still in `WsRpcGroup`; no name collides. |
| 3 | `packages/contracts/src/settings.test.ts` | hidden-tag decode, usage model filter, voice settings cases | kept-compatible | Loom's cases (restart continuation, auto-resume, quiescence graces, meter on, pi text-generation default, pi enabled, workstream presets/profiles) unchanged and still describe the schema (row 51). |
| 4 | `packages/contracts/src/project.ts` | `ProjectScript.stopOnSettle` | kept-compatible | |
| 5 | `packages/contracts/src/server.ts` | `threadLinkMetadata`, `secretRequestReferences` capability flags | kept-compatible | |
| 6 | `packages/contracts/src/editor.ts` | `LOCAL_FILE_LINK_SCHEMES`, `isLocalEditorFileUrl` over `goto` editors with a `remoteScheme` | kept-compatible | Loom's `zed-remote` is `direct-path` with no `remoteScheme`, so it is not taken for a local-file scheme; `isClientLaunchEditor` unchanged. |
| 7 | `packages/contracts/src/index.ts` | exports `speech.ts`, `threadTags.ts` | kept-compatible | |
| 8 | `packages/contracts/src/model.ts` | Kiro driver kind, its `"default"` model and display name | kept-compatible | Pi keeps `PI_DEFAULT_MODEL` for both default maps; `gpt-6-sol` preference intact. |
| 9 | `packages/contracts/src/keybindings.ts` | `composer.dictation` | kept-compatible | Loom's `tab.*` and `notifications.dismissAll` commands still in `STATIC_KEYBINDING_COMMANDS`. |
| 10 | `packages/contracts/src/providerInstance.ts` | a secret env var decodes as `sensitive: true` | kept-compatible | `usageSources` untouched. |
| 11 | `packages/contracts/src/providerRuntime.ts` | turn usage gains `models`, `localCommand`, `otherUsage` | kept-compatible | Those live in `TurnTokenUsageCommonFields`; Loom's ledger fields are on `ThreadTokenUsageSnapshot`, a different struct; `recommended` on question options intact. |
| 12 | `packages/shared/src/usageLimits.ts` | hub account names drop `.json`; a hub e-mail beats the driver's default display name; `/usage-limits` offered when any source is unreadable | kept-compatible | §6.4's `hub` shape is in the server files (DL-1806); here Loom's `login` merge, dead-account carry, pool exclusion, login alerts, re-login reminder and `unlinkedUsageSources` sit beside upstream's display-name rule without touching it. A dead hub account still enters `collectLimitAccounts` (Loom's `!dead` guard) and gets upstream's `hubAccountName`. |
| 13 | `packages/shared/package.json` | new subpaths (`keybindingMatching`, `speech`, …), `jose` dropped, `typecheck` is `effect-tsgo tsrs` | kept-compatible | Loom's eight subpaths intact. |
| 14 | `packages/shared/src/serverSettings.ts` | observability-only lenient decode; per-host source-control token merge; `speechPostProcessingModelSelection` | kept-compatible | Speech cleanup falls back to the text-generation model, which on Loom is pi's default. Loom's allow-list defaults, presets/profiles, embedder key-keeping and `providerFailover` merge intact. |
| 15 | `packages/shared/src/serverSettings.test.ts` | token-merge, retired streaming mode, speech cases | kept-compatible | |
| 16 | `packages/shared/src/toolOutput.ts` | `previewRecordingIdFromToolItem`, `mcpToolResultOutput` (keeps `content` beside `structuredContent` when images exist), Claude-style MCP app names | kept-compatible | `mcpToolResultOutput` is used only by the ACP, Claude and Codex adapters; its `{content, structuredContent}` object is still read by `outputBlocks`, so Loom's attachment-id images and `omitToolOutputImageData` apply to it. |
| 17 | `packages/shared/src/keybindings.ts` | §6.5 (a): nine matching names moved to `keybindingMatching.ts` and re-exported; `mod+shift+d` → `composer.dictation` outside the terminal | kept-compatible | Every moved name is re-exported from `keybindings.ts`, so Loom importers resolve unchanged. Duplicate-key scan of `DEFAULT_KEYBINDINGS`: only upstream's terminal/non-terminal pairs; Loom's `mod+alt+[`/`]`/`1…9` and `mod+shift+backspace` collide with nothing, dictation included. |
| 18 | `packages/shared/src/model.ts` | `withLegacyUltracodeEffort` inside the descriptor helpers | kept-compatible | Loom's pi default driver and DL-1720's options-free pick rule in `draftModelPickMatchesThread` (a function upstream did not touch) intact. |
| 19 | `packages/shared/src/projectSettings.test.ts` | new cases | kept-compatible | |
| 20 | `packages/shared/src/shell.test.ts` | Windows probe and console-free git cases | kept-compatible | |
| 21 | `packages/shared/src/usageLimits.test.ts` | display-name and command-offer cases | kept-compatible | |
| 22 | `packages/shared/src/composerContextReferences.test.ts` | `threadLinkContextReferences` (pasted hosted/v2 links become chips; v1 links kept as written), review excerpt whitespace | kept-compatible | Loom's provider projection to `[title](t3-thread://v1/<id>)` (DL-752) is a different function; upstream leaves v1 links as text, so the agent-facing link still resolves (§6.5 (b)). |
| 23 | `packages/shared/src/shell.ts` | Windows shell probe deadline, `runsGitWithoutConsole` | kept-compatible | `withLocalNodeModulesBin` untouched. |
| 24 | `apps/mobile/src/features/threads/ThreadFeed.tsx` | `DisclosureRow` motion, tool-call visibility filter, bar inset, hosted thread links | kept-compatible | The user bubble still renders in `renderFeedEntry`; Loom's control-bubble label and tint sit in it, and `controlBubbles` is still in `listAppearanceData`, the list's `extraData`. The filter acts on work rows, not user messages. |
| 25 | `apps/mobile/src/features/threads/thread-list-v2-items.tsx` | row menus rebuilt through `layoutThreadListV2RowMenuActions` | kept-compatible | The menu change does not touch the status line or subtitle row; Loom's attention labels, pending-question subtitle, workstream badge and accessibility suffix render where they did, and `ThreadListV2Status` still includes `LoomAttentionReason`. |
| 26 | `apps/mobile/src/features/home/HomeScreen.tsx` | AppBar refactor; #27289 draws a row as a sidebar row only when `usePaneRole() === "sidebar"` (`sidebarSurface`), since a collapsed split also provides `NativePrimaryColumnContext` | **DEFECT** (DL-1909) | DL-1709's archived search hits still join `threadListV2Items`, but Loom's `ArchivedSearchResultRow` still keys its look on the old idiom: `{...(primaryColumn ? { pane: "sidebar" as const } : {})}`. On an iPhone (and an iPad in compact width), searching Home lists archived roots as inset, rounded drawer-coloured rows under full-width screen-coloured ones. **Fix:** in that one line use `sidebarSurface` for `primaryColumn`; nothing else changes (`ThreadNavigationSidebar.tsx` passes `pane="sidebar"` literally and is right). Proof: S4's mobile pass, a Home search on iPhone that matches an archived root. |
| 27 | `apps/mobile/src/features/keyboard/CommandPalette.tsx` | `useVisibleThreadShells` (hides tagged threads); workspace hook paths | kept-compatible | Loom's archived items come from `search.matches`, not shells; see follow-up 2. |
| 28 | `apps/mobile/src/features/usage/UsageLimitsPooled.tsx` | Cursor prompt removed | kept-compatible | DL-1819: upstream's deletion of `cursorPrompt` taken; Loom's login-alert banner and its empty-state term unchanged. |
| 29 | `apps/mobile/src/features/files/ThreadFilesRouteScreen.tsx` | header/AppBar refactor | kept-compatible | `defaultViewMode` still decides the opening mode; markdown opens rendered. |
| 30 | `apps/mobile/src/features/home/HomeRouteScreen.tsx` | AppBar refactor | kept-compatible | `handleSelectThread` still takes an id pair and feeds Home's `onSelectThread`. |
| 31 | `apps/mobile/src/lib/filePreview.test.ts` | new cases | kept-compatible | |
| 32 | `apps/mobile/src/state/thread-task-permissions.test.ts` | new cases | kept-compatible | |
| 33 | `apps/desktop/src/preview/Manager.test.ts` | voice and shown-state cases | kept-compatible | |
| 34 | `apps/desktop/src/preview/Manager.ts` | annotation voice per pick session, `setShown`, platform-correct refresh shortcut, `SecureRandom` | kept-compatible | Loom's same-document guard on `did-start-navigation` keeps the pick, and now its voice listener with it; cleanup removes both together. |
| 35 | `apps/desktop/src/settings/DesktopClientSettings.test.ts` | new fields | kept-compatible | |
| 36 | `docs/operations/observability.md` | MCP request spans paragraph | kept-compatible | Loom's opt-in `sqlite` statement spans paragraph and env row stand. |
| 37 | `docs/user/source-control.md` | ghq clone layout, PR description checkboxes | kept-compatible | |
| 38 | `docs/README.md` | Voice input, Secrets, Kiro guide, Mobile layout links | kept-compatible | |
| 39 | `docs/operations/development.md` | `stopOnSettle` Dev action, tsgo typecheck paragraph, Linux bytecode builds | kept-compatible | Loom's git-prerequisite and per-port dev home paragraphs agree with upstream's; Loom's `t3.json` carries the `Dev` action with `stopOnSettle` upstream's paragraph names. |
| 40 | `docs/user/providers-claude.md` | mobile Add Claude account, mobile compaction | kept-compatible | "Meter on by default" agrees with `composer.md` and the schema. |
| 41 | `docs/user/keybindings.md` | dictation chord, `rightPanelOpen` | kept-compatible | Loom's `[`/`]` change navigation does not collide. |
| 42 | `docs/user/providers-pi.md` | extension status text near the composer | kept-compatible | Agrees with DL-1895 (pi statuses taken, Loom's jobs status kept). |
| 43 | `docs/user/thread-sidebar.md` | seven-day auto-settle, hosted copy link, stop-on-settle, side-chat permissions, snooze with a question | kept-compatible | Seven days matches `DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS`; the copy-link and snooze text are §8.3/§8.2's rulings. Loom's in-messages search paragraph stands. |
| 44 | `docs/user/usage.md` | Cursor via sign-in or API key; `usageModelFilter` | kept-compatible | Loom's hub login and re-login paragraph sits after the hub section it extends. |
| 45 | `vite.config.ts` | `knip:check:all` task; mobile `no-restricted-imports` override; `max-settings-description-length` | kept-compatible | Loom's jsdom allow-list and its two `excludeFiles`, the fmt ignores and the workstream registration override intact (as §8.2 says). |
| 46 | `knip.jsonc` | Linux afterPack entry, `transcribe-cpp`, `t3-highlights` entry | adapted | S3 added the marked `packages/provider-kiro` ignore beside `provider-fx`/`provider-acp-registry` (§8.2, DL-1816); `knip:check:exports` now lists that workspace. |
| 47 | `scripts/lib/cli-external-packages.test.ts` | new case | kept-compatible | |
| 48 | `package.json` | `knip:check` split into `knip:check:files`/`:exports` run through `vp run knip:check:all`; `@effect/tsgo` replaces `typescript` | kept-compatible | Loom's `dev:seed*`, `dev:fake-hub`, `cockpit*`, `loom-evals` and `ship` scripts intact; `scripts/ship.ts` calls `vp run typecheck`, not knip. |
| 49 | `scripts/lib/cli-external-packages.ts` | new external prefixes | kept-compatible | |
| 50 | `packages/contracts/src/clientRpcPermissions.ts` (extra; conflicted in S1) | `providerAuthRemoveMethod`, `serverRefreshProviders`, `sourceControlStar` guarded | kept-compatible | `CLIENT_GUARDED_RPC_SCOPES` still lists both Loom protected methods (`usageLimitSourceLoginStart`/`Finish` under `AuthProvidersManageScope`), the only two Loom ever had. |
| 51 | `packages/contracts/src/settings.ts` (extra; defaults) | `toolCallVisibility`, `hideTaggedThreads`, `hiddenThreadTags`, the speech/dictation settings, Kiro | kept-compatible | Schema: `contextWindowMeterEnabled` true, `autoResumeLimitedThreads` true, `followUpBehavior` `steer`, pi absent from `DEFAULT_DISABLED_PROVIDER_DRIVERS` (which gains `kiro`) and present in the enabled default instances, allow-list fields via `LoomModelPreferenceFields`; upstream's new fields at upstream's defaults (`showAll`, `false`, `[]`, speech defaults). Tests pin the meter, auto-resume, pi enabled and upstream's tag/voice cases; see follow-up 1. |
| 52 | `AGENTS.md` (extra) | tsgo typecheck sentence, `.repos/effect` path | kept-compatible | Read whole: every command it names is a root script (`check:changed`, `typecheck`, `lint:mobile`, `dev:seed`, `migrate-dev-db`, `mobile:install`, `sync:repos`, `ship`, …), every linked doc and path exists, every lint rule it names is configured. "Each package runs `effect-tsgo tsrs`" is true; that tsrs cannot start on the cockpit host is DL-1926's, not the file's. |

**Follow-ups (not merge work):**

1. Nothing pins `followUpBehavior: steer`, `toolCallVisibility: showAll` or `kiro` in the disabled-by-default list in `settings.test.ts`; the schema has all three. A one-line test each would catch a future silent merge that flips a default.
2. §8.3's thread-tags finding reaches Loom's archived search rows too: with the Labs switch on, upstream hides tagged threads from its lists and its archived list (`hiddenThreadTagsAtom`), but Loom's archived search hits (mobile palette `archivedItems`, Home's `threadListV2SearchArchivedItems`) are built from search matches and take no tag filter. Only matters if Carl turns the switch on.
