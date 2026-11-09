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
