## 6. Other seams, read and recorded

### 6.1 The Pi adapter: compaction hold, short-lived `--offline`, extension status

Loom is Pi-first, so these are the hunks that get per-hunk care. All eight
`fix(pi)`/`feat(pi)` commits this week touch `packages/provider-pi/src/server/`;
three files conflict (`adapter.ts` ×3, `mcpInjection.ts`, `status.ts`,
`textGeneration.ts` + test), `driver.ts` (8 `loom` lines) and `adapter.test.ts`
merged silently.

| Upstream change | What it does | Loom seam | Verdict |
| --- | --- | --- | --- |
| #24388 hold messages until compaction ends (`18ac394ee4`, `adapter.ts` +123) | Pi 1.4.0 rejects a prompt while it compacts ("Cannot submit a prompt while compaction is in progress"); the adapter now routes every `turn_start`/`steer` send through `sendPrompt`, holds prompts in `heldPrompts` while `nativeCompacting`, re-sends them on `compaction_end`, and re-arms the settle probe for a released prompt | DL-1463 (mid-turn messages steer) and Loom's `bg_wait` steer wake (#433, `8350718b93`: a steer wakes `bg_wait` in the extension without touching the job) both ride the steer send, so a steer typed during a compaction is delivered when it ends instead of being rejected: strictly better. The hold engages on 1.3.0 (it emits `compaction_start`/`compaction_end`); only the re-hold of a prompt pi rejected is 1.4.0's. A held prompt whose turn ended, was interrupted or is stopping is dropped at `compaction_end`; Loom's `touchLoomPiCache` (hunk 3, a completed request refreshed the prompt cache) sits in the same event switch as upstream's new `t3.extension_status_reset` arm: union, Loom's arm first as before | Union; Gate 2b reads `sendPrompt` against `pendingSteering.ts`'s stash (DL-690/DL-1708: a steer pi accepted but never delivered is stashed at shutdown; a held prompt is not yet accepted, so a SIGTERM during compaction drops it, which is upstream's behaviour for upstream's steers too). S4: a steer during a pi turn still lands |
| #30187 short-lived Pi processes run `--offline` (`8be19ed3f1`) | `mcpInjection.ts` adds `--offline` when `input.shortLived`; `textGeneration.ts` and `status.ts` pass `shortLived: true` (title generation, the status probe) so a stop mid-request cannot lose a rotated OAuth token | Loom's `textGeneration.ts` keeps `disableExtensions: false` (standing: cliproxy-registered models carry `PI_DEFAULT_MODEL`) beside upstream's `shortLived: true`; `--offline` skips pi's startup catalog refresh, which is orthogonal to extensions (`args.js`: "Disable startup network operations"). `status.ts`: Loom's `loom: { … promptTemplates }` beside `shortLived: true`. `mcpInjection.ts`: Loom's `--append-system-prompt`/`--skill`/`--extension`/`--prompt-template` argv beside upstream's `--offline` line | Unions. `textGeneration.test.ts`'s conflict is upstream's new "runs Pi offline" test beside Loom's "names the model" test with its "extensions stay on" note: both stay (Rule T). S4: a thread title generates through cliproxy |
| #23901 extension status in existing controls (`adapter.ts` hunks 1–2) | `extensionStatusReset` tracks a status reset round-trip; a session close fails its `Deferred` | Loom's `loomJobs` line (the extension's `loom-jobs` status line, reset on close) sits at both sites | Union |
| #30025 SIGTERM before closing stdin, #29768 folder extension error names, #32231 atomic MCP extension file, #30690 `--session-dir` usage reports, #32389/#27397 thinking controls | Teardown order, error text, a temp-file rename for `pi-t3-mcp-extension.ts`, usage-scan paths, model-switch thinking | Silently merged (`adapter.ts` 47 `loom` lines; `driver.ts` 8). Loom's `mcpExtensionSource.loom` (DL-905: no upstream orchestration instructions for Pi) reads the extension source, not the file write; the atomic write changes the path's lifetime, not its content | Gate 2b reads `adapter.ts`'s teardown against Loom's `pendingSteering` stash (it writes at SIGTERM) and `mcpExtensionSource.loom.test.ts` stays the proof |
| `/clear` on a pi thread (#30325, §6.2) | A `freshContext` send releases the provider session (`sessionsReleasedByFreshContext`) and the next run opens a new one with no native thread id, so `ProviderSessionManager.open` runs Loom's `sessionComposer.compose(threadId)` again (hunk 2: Loom's compose before upstream's `readLinkedEnvironments`) and pi starts a new session file | `$PI_SESSION_FILE` is set per process, so it names the new file; `piSessionPathOf` ("the native ref of its latest pi provider thread", `loom/prompt/childPrompt.ts` l.13) is what context-viz (`contextUsageReport`), `consult_thread` forks and the workstream list's session paths read, so all three follow a `/clear` to the new session and the pre-clear history is reachable only through the report path, as the addendum already says. The goal binding, the workstream row and the report path are keyed by thread id: unchanged | Finding; S4 runs `/clear` on a pi root once and checks context-viz resets and `consult_thread` answers from the new session |

`ProviderSessionManager.ts` hunk 1 (Loom's `reportedError`, DL-1624, beside
upstream's `lastSessionStatus`) and its test's hunk (Loom's `.each` failure
cases beside upstream's `get providerSession()` getter and `Stream.fail`
shape) are unions on upstream's new shape (Rule D for the test).

### 6.2 `/clear`, thread tags, and a snooze with an open question

| Loom seam | What changed this week | Finding | Verdict |
| --- | --- | --- | --- |
| Open (non-blocking) questions, Loom #531 (`hasBlockingPendingRequest`, `loom.blocking` on the runtime request) | Upstream #20058 lets a thread with a pending `user_input` be snoozed: `Orchestrator.ts` hunk 1 replaces the `pendingRuntimeRequest !== null` guard with `some(pending && kind !== "user_input")`; `ProjectionStore.ts` hunk 3 orders the shell's `pending_request_payload_json` with approvals ahead of questions; `ThreadSettlementService.ts` (silent) lets a thread settle past a question asked before its snooze | At the snooze site upstream's rule covers Loom's and more (every question is non-blocking for snooze, not only Loom's open ones): take upstream's, drop Loom's `hasBlockingPendingRequest` call there (doctrine §4.3; the helper's other six call sites in `Orchestrator.ts` are untouched and stay). In the shell SQL, union: Loom's `COALESCE(json_extract(…'$.loom.blocking'), 1) = 1` filter stays and upstream's `ORDER BY (kind = 'user_input') ASC` is added, so an open Loom question is still listed apart and an approval still leads | Rule D, two lines; Gate 1 reads |
| `/clear` (#30325; `freshContext` on `thread.message`, `freshSession` on scheduled tasks #30326) | `Orchestrator.ts` hunk 3: the "wake an idle thread for this message" predicate gains `!freshContext && (delegatedCompletion ? … : command.notification?.source.kind === "delegated_task")` (#32573 wake idle parents for late delegated results); Loom's clause `command.loom?.origin !== undefined && dispatchMode.type === "queue_after_active"` (a queued Loom control message rides upstream's steer conversion, pull 12) is on the same lines; hunk 2: `readonly loom?` beside `readonly notification?` on the command shape | Union: `!freshContext && (upstream's) || loom's`. A Loom control message never carries `freshContext` (only the composer's `/clear` and the MCP `t3_thread_send` set it, and the latter is withheld), so Loom's steered tier is unchanged. `useComposerMenuItems.ts` hunk 2: upstream's `/clear` slash item beside Loom's `LOOM_DRAFT_SLASH_ITEMS` (union); `composer-logic.ts` hunk 1: `ComposerSlashCommand` gains upstream's `"clear"` beside Loom's `"handoff" \| "retro"` and Loom's `"thread"` trigger kind; hunk 2: upstream's `parseStandaloneComposerSlashCommand` signature now excludes `clear` (take upstream's, keep Loom's comment) | Unions; Gate 1 reads hunk 3 |
| Thread tags and hide-while-recording (#29053) | `hiddenThreadTagsAtom`/`hiddenThreadKeysAtom`/`visibleThreadShellsAtom` in client-runtime; `hideTaggedThreads: false`, `hiddenThreadTags: []` settings; web `state/threads.ts` wires `hiddenThreadTagsAtom` into the entity input (Loom's `loomEnvironmentSnapshotAtom` is the other line: union); `ThreadRouteView.tsx` and `ThreadNotificationCoordinator.tsx` gain hidden-thread early returns beside Loom's shell-less archived-root wait and the child-completion suppression (unions); `useComposerMenuItems.ts` hunk 1: `useVisibleThreadShells(isPathTrigger)` replaces `useThreadShells(…)`, Loom's `\|\| composerTriggerKind === "thread"` (the `!` thread trigger, DL-750) joins the argument | Off by default, so nothing changes on the cockpit. When on, Loom's sidebar sections (`Sidebar.logic.loom.ts`, `SideThreadRows.tsx`) and the workstream graph read the full shell list and keep showing a hidden thread; the palette and pickers hide it. A follow-up if Carl ever records (§8.3); not merge work | Unions; S2b typechecks |
| Snooze/limit recovery (`ChatView.tsx` hunk 1) | Upstream's `limitRecoveryHoldsSnooze` block lands on the lines of Loom's `queryForkWaiting` and `useSeedPromotedQueryComments` | Unrelated edits | Union |

### 6.3 Scheduled tasks and delegation

**Scheduled tasks** (#30326 one thread with a fresh session each run, #31379
move a task to another thread, #31764 tasks link to their thread, migration
080). Loom's `SCHEDULING` family (`families.ts`: `schedule_task`,
`list_scheduled_tasks`, `delete_scheduled_task`) is unchanged: **no tool was
renamed this week** (every `Tool.make` name in `apps/server/src/mcp/toolkits/*/tools.ts`
is identical at base and target). `bindToCurrentThread` survives on
`OrchestratorMcpSaveScheduledTaskInput` and in `OrchestratorMcpService.ts`
(Loom's one conflict there is an import line beside upstream's
`withLegacyUltracodeEffort`: union); the input gains an optional
`freshSession` ("Runs share one thread but each starts a fresh session");
`ScheduledTask` gains `threadMode: "new_thread" | "continue" | "fresh_session"`
with `scheduledTaskThreadMode()` defaulting an absent mode to `continue` for a
bound task. `schedule_task`'s description changed (upstream's text, taken
verbatim: upstream tool prose is not Loom's model-read text). The cockpit
holds three tasks, none of them a Monday summary: "Loom evals: weekly
dashboard" (unbound, worktree strategy → `new_thread`), "30-day check:
ship-type question cards after PR #531" and "Re-measure gate-reviewer
briefing after PR #532" (both bound to a thread → `continue`, today's
behaviour). Nothing for the withheld lists, `families.test.ts` or
`registration.test.ts`; nothing leaks.

**Delegation and subagents** (#32573, 079, #29622, #30363, #29285, #26737):
`DelegatedTaskQuestionReactor.ts` is untouched by both sides; `RemoteDelegation.ts`
changed upstream only; `families.ts` is Loom-only; `McpInvocationContext.ts`
(+7/−8 upstream, Loom's one line) and `requireWorkstreamCaller` are as pull 14
left them. #32573's wake clause is the `Orchestrator.ts` hunk 3 union above.
Migration 079's two partial indexes serve upstream's delegated-result
recovery (`lineage.relationshipToParent = 'subagent' AND forkedFrom.type =
'node'`; `delegatedCompletion.delivery`): a Loom child is a subagent-lineage
thread without a `delegatedCompletion`, so it is in the first index (6,000
rows on the cockpit) and never in the second. The reactor stays inert for
Loom children: delegation is still keyed on `app_owned` task records that
`workstream_spawn` never creates (pull 14 §5.2).

### 6.4 The usage hub: secret-provider keys and a `hub` value (Rule D)

Upstream #27760 reads the CLIProxy management key through `SecretResolver`
(`UsageLimitSources.readManagementKey`, a new `secrets` and `backgroundPolicy`
dependency) and #25579 normalises a `management.html` URL; `cliproxyApi.ts`
now takes a `hub: CliproxyHub` (`{ url, managementKey }`) where it took the
settings `config`, and `readAccounts(hub)` lists the auth files itself.
Loom's #435/#505 work on the same functions: one listing feeds login
detection and the usage reads (`listAccounts` then `readAccounts(config,
previous, files, record)`), per-account carry-forward of the last good
reading under Anthropic 429s, the one-year-token rule, and the hub-login
record (`hubLogins.loom.ts`, `cliproxyLogin.loom.ts`).

Resolution: upstream's shape, Loom's delta re-applied: `readAccounts(hub,
previous, accounts, record)` with `hub` built in `UsageLimitSources.ts` from
`readManagementKey(config)`; `listAccounts(hub)` stays Loom's export (upstream
folded listing back into `readAccounts`; Loom needs the list for login
detection); hunk 1 of `cliproxyApi.ts` (the long-lived-token early return)
and hunk 3 (the per-account `carried.find`/`record(email)` arguments) stay
with `hub` in place of `config`; `UsageLimitSources.ts` hunk 2 (B) takes
upstream's `readManagementKey`; hunk 3 keeps Loom's carry-forward and the
"one listing" block over upstream's `managementKey`/`missingManagementKey`
lines. Tests: `cliproxyApi.test.ts`'s hunk calls Loom's split API on the
`hub` shape; `UsageLimitSources.test.ts` hunk 3 keeps Loom's 114-line
hub-login test beside upstream's 66-line secret-provider test (both; the
`SecretResolver` import union in hunk 1, `TestClock` beside `Stream` in hunk
2). Web: `UsageLimitsPooled.tsx`'s `HubLoginNotices` and `UsagePage.tsx`'s
`UsageOverview` wrapper (Loom's usage ledger, seam 11) are unions. `ws.ts`
hunk 3 is the related stream: Loom's `Stream.scan` over `providers`/`marks`/`sources`
with `overlayProviderExhaustion` (the provider health registry's marks) is
re-applied around upstream's new `currentCatalogsPerCwd`-aware
`withoutWorkspaceSnapshots`; hunk 2 (A) keeps Loom's `providerHealthRegistry`
line and drops the two upstream locals upstream deleted. **Gate 1 reads**
`cliproxyApi.ts` and `ws.ts` hunk 3; S4 opens the Usage page with the hub
configured.

### 6.5 Web: the `lost-ours` names, Copy thread, the Labs tool-call filter, file chips

**(a) `lost-ours` (6 files, 19 names), each checked by word across the 661
Loom-only files and the 15,612 Loom-added lines:**

| File | Names | What happened upstream | Loom consumer |
| --- | --- | --- | --- |
| `orchestration-v2/ProviderEventIngestor.ts` | `ProviderTurnAnalytics`, `ProviderTurnAnalyticsContext`, `ProviderTurnOrigin`, `layerAnalytics` | #29001 moved them to `telemetry/ProviderUsageAnalytics.ts` (`server.ts` hunks: `ProviderUsageAnalytics.layer` replaces `ProviderEventIngestor.layerAnalytics`; Loom's `ToolOutputImageStore` import and layer sit beside, union) | None (Loom's prompt telemetry #448 is `ProviderDimensions.ts`'s `bindToCurrentThread` dimension, untouched) |
| `persistence/DatabaseMaintenance.ts` | `DatabaseProjectionsInvalidError` | #29806 dropped the verify-around-compact | None |
| `components/Sidebar.logic.ts` | `belongsInSidebarWorkingShelf`, `isSidebarEnvironmentDisconnected` | Upstream inlined the working-shelf predicate (`Sidebar.tsx` hunk 1: `workingShelfEnabled && (manuallyMoved ? isThreadWorking(thread) : inboxObservation.isWorking(thread))`) | Loom's `&& rowAttentionOf(thread) === null` (3d-3: a flagged thread stays in the inbox) re-applied on upstream's inline form |
| `components/composerContextPresentation.tsx` | `ComposerContextActions`, `ComposerContextActionsContext` | Moved to `composerContextActions.ts`; the presentation file imports and re-exports them | Loom's #529 line `use(ComposerContextActionsContext) // loom: promoted link back` merged silently under the new import (verified: l.13 import, l.290 use) |
| `components/files/filePreviewMode.ts` | `setMarkdownTaskChecked` | Moved to `@t3tools/shared/markdownTaskList` | `FilePreviewPanel.tsx` (silent part) and `ChatMarkdown.browser.test.tsx` (conflict) import the new path; Loom's `__setMetadataFetcherForTests` import stays beside |
| `packages/shared/src/keybindings.ts` | `EVENT_CODE_SHORTCUT_KEYS`, `ShortcutEventLike`, `isMacPlatform`, `matchesKeybindingShortcut`, `shortcutKeyFromEvent`, … (9) | Moved to `keybindingMatching.ts` | None in Loom-only files; Loom's `keybindings.test.ts` (silent, 5 lines, DL-1658) imports `DEFAULT_KEYBINDINGS` only |

The deletions stand; nothing is re-exported. Upstream deleted 4 test files
this week, none Loom-edited; Rule T applies to the conflicted tests only
(§7.1).

**(b) Copy thread copies a hosted link (#26290).** `threadLinks.ts` gains
`hostedThreadLink`/`formatHostedThreadLink` (`https://app.t3.codes/threads/<env>/<id>`,
`DEFAULT_HOSTED_APP_URL`) and `threadLinkCandidates` parses that form beside
`t3-thread://v1/` and `v2/`; the sidebar's Copy thread and
`MarkdownThreadLink.tsx` (hunk 2: upstream's `ThreadContextChip` with
`copyMarkdown={formatHostedThreadLink(…)}`) use it. `formatThreadLink` still
exists (Loom's `composerContextReferences.ts` hunk 1 keeps its DL-752 import
beside upstream's `replaceThreadLinks`). Loom's `ThreadMention` (DL-1626,
DL-1671) renders the resolved case and copies the v1 form, so the
`MarkdownThreadLink.tsx` resolution is pull 14's: upstream's resolution
chain (`writtenRef`, `threadLinkMetadata`, `guessThreadLinkRef`) with Loom's
`ThreadMention` in the resolved branch and upstream's `UnresolvedChip`
otherwise (Rule D, 48-line file). `t3-thread://v1/<id>` (what the addendum
tells agents to write) still parses and resolves to the message's
environment: no model-read text change. The product consequence is in §0
and §8.3: Copy thread's clipboard text is now a URL to T3's hosted app
rather than a `t3-thread://` URI; inside Loom both paste as the chip.

**(c) A Labs setting hides tool calls (#30000).** `toolCallVisibility`
(`showAll` default, `hideSuccessful`, `hideAll`, `zen`) filters
`MessagesTimeline.logic.ts`'s rows (`workShownAsFinalAnswerOnly`: in the
hiding modes a work entry survives only as an approval, a question answer, a
compaction, an error or a response start; an event entry survives unless it
is a subagent). Loom's rows: `ConsultCardRow` is an event entry (survives);
the spliced Loom rows (`loomTimelineRows.ts`: `loom-handoff`,
`loom-promotion`; `modelChangeRows.ts`) are inserted after the filter by
`insertLoomTimelineRows`, so they survive too; the context-viz rail reads
turn items, not rows. `MessagesTimeline.logic.ts` merged silently (11
`loom` lines). Gate 2c reads the filter against `insertLoomTimelineRows`;
S4 flips the setting to `hideAll` on a Loom root once and looks for the
consult and control cards.

**(d) File chip tooltips (#27993), `pullRequestDetail.logic.ts`.** Upstream
keys review contexts by PR URL ("repositories can share pull request
numbers"); Loom's `kind: "line"` discriminator (review contexts are a kind
union: line or MDX anchor) sits on the same object literals: unions at all
three sites, URL-keyed ids taken. `reviewCommentContext.test.ts` hunk 2 keeps
Loom's 129-line union tests beside upstream's new 32-line excerpt test;
hunk 1's import takes both names. Loom's artefact chips
(`apps/web/src/loom/`) are Loom-only files and merge clean.

**(e) Other web unions:** `SidebarThreadRow.tsx` (Loom's `rowAttentionOf`/`useLoomSubThreadsUnsettled`
recede guard beside upstream's `topStatus`; Loom's `PendingQuestionWaitAge`
beside upstream's `preparing || working` test), `FilePreviewPanel.tsx`
(Loom's 22 import lines beside upstream's `setMarkdownTaskChecked` import;
Loom's absolute-path prop doc beside upstream's `projectId` prop),
`PreviewView.tsx` (upstream's annotation voice config and `pickActiveRef` at
three sites around Loom's per-tab `endPreviewPick`; hunk 4 is the standing
"annotation survives unmount" ruling: Loom's side, DL-1214), `useThreadActionMenu.ts`
(Loom's goal submenu imports beside `configuredHostedAppUrl`), `terminal-links.ts`
(upstream's new `FILE_PATH_PATTERN` regex, Loom's marked `export` for
`chatPathScan.ts`; `chatPathScan.test.ts` tells if the regex changes what the
chat scanner finds), `markdown-links.ts` (Loom's doc comment beside
upstream's `isLocalEditorFileHref`; the test keeps both describe blocks),
`reopenClosedView.test.ts` (Loom's `absolutePath`/`reveal*` fixture fields on
upstream's new expectations; the `folderTrail` line takes upstream's shape
with Loom's fields), `Sidebar.tsx` hunk 2 (upstream's `<ul role="listbox">`
around Loom's 69 search-result lines: re-indent).

### 6.6 Pull requests and settlement

| Upstream | Loom seam | Verdict |
| --- | --- | --- |
| #30857 `#123`/`!123` completion, #30747 `@user` mentions, #22489 reviewer menu paging, #30704 description checkbox, #25761 host-reply updates, #27798 paint from held data, #30375 bare uuid → `mcp:` thread | `prToolkit` (Loom's PR toolkit layer, `prToolkit.test.ts` needs the `SecureRandom` swap, §5.2), `watch_pull_request`, ship tooling; `clientRpcPermissions.ts` and `commandPermissions.test.ts` conflict on one line each (Loom's `AuthProvidersManageScope // loom` beside upstream's unmarked import of the same name: take Loom's marked line) | Unions. `PullRequestWatchReactor.ts` (silent, 4 `loom` lines: DL-474 a Loom child keeps its watch) is now under upstream's `GROUP_READS` semaphore and `providerFailureReason`; Gate 2a reads it. `link_pull_request(s)` prose for Loom children (pull 14 Gate 2a B1) is still a follow-up, not merge work: `pullRequests/tools.ts` changed only to drop `PullRequestThreadNotFoundError` |
| #31857 stop opted-in project actions when threads settle | `ThreadSettlementService.ts`: `terminals.closeOnSettle` replaces `closeIdle` (two lines); Loom's #527 (a finished Loom root stays active while its PR is open, `71c25058b9`) and DL-1705 sit in the same file and merged silently; upstream's `user_input`-after-snooze settle rule (#20058) joins them | Gate 2a reads the three rules together; S4's settlement journey: a finished Loom root with an open PR stays active, one without a PR settles at its outcome time |
| Loom #534 false needs-attention flags | Loom-only files | Clean |

### 6.7 Migrations 077–080 against the fork lane and Loom's runtime

| Upstream migration | What it does | Touches a table a fork migration or Loom reads? (DL-1251's check) |
| --- | --- | --- |
| 077 `RepairBooleanSettledOverride` | `UPDATE orchestration_v2_projection_threads SET payload_json = json_set(…'$.settledOverride', IIF(= 'true', 'settled', NULL)) WHERE json_type IN ('true','false')` | Repairs a value Loom's cold-shell keep rule reads (`settledOverride !== "settled"`, DL-1650); **0 rows on the cockpit** (measured). Additive |
| 078 `DropOrchestrationEventCorrelationIndex` | `DROP INDEX IF EXISTS idx_orch_events_correlation_id` | The index exists on the cockpit; no Loom query filters by `correlation_id` (1054 inserts the column, nothing reads it). Fewer bytes per event write. **Irreversible but harmless** |
| 079 `DelegatedRecoveryIndexes` | two partial indexes: `orchestration_v2_projection_threads(thread_id, lineage.parentThreadId)` for subagent forks, `orchestration_v2_projection_runs(thread_id)` for `delegatedCompletion.delivery` | Additive; 6,576 threads and 6,397 runs on the cockpit: seconds (§6.3) |
| 080 `ScheduledTaskThreadMode` | `ALTER TABLE scheduled_tasks ADD COLUMN thread_mode … DEFAULT 'new_thread'`; `UPDATE … SET thread_mode = 'continue' WHERE thread_id IS NOT NULL` | Additive; 3 rows (§6.3); Loom's scheduling tools read through upstream's service |

No upstream migration drops or renames anything the fork lane (1001–1069) or
Loom's runtime reads. `Migrations.ts` is byte-identical in the trial tree.
`initializeV2Database.ts` (+25) and `Sqlite.ts` (+2: a larger WAL
autocheckpoint, #31804; Loom's `cache_size` line beside, silent) are
upstream's; `OrchestrationEventStore.ts` (+22) adds `prunedThroughSequence`
and the two metadata names (§4); `persistence/testkit/SqliteRouting.ts` is a
new test helper. `066_RepairClientSettlementTimestamps.test.ts`'s conflict
is Loom's `runLoomMigrations()` call (the rebuild writes Loom's sidecar
tables) beside upstream's switch from `ProjectionMaintenanceV2` to the new
`ProjectionReplay` testkit: union.

### 6.8 Voice, dictation and the new providers: Loom-clean

#30623 (device dictation), #30625 (environment transcription), #31769
(cloud dictation), #26734 (Android on-device), #31059 (mobile opt-in), #32035
(first-run model): 300+ files, none with a Loom line; every one merges clean
and is listed in Appendix C only where both sides touched it (`ComposerFooterControls.tsx`,
5 Loom lines beside the dictation button). Kiro (#14693), Antigravity 1.4.5
(#28629), Cursor SDK account usage (#32448), Claude Ultracode (#27034):
`builtInDrivers.ts`'s conflict is upstream's union growing by `KiroDriverEnv`
against Loom's `[PiDriver]` (standing, Pi-only; the `knip.jsonc` ignore
pattern DL-1692 covers `provider-kiro` only if S3's `knip:check` says so: a
marked workspace entry like `provider-fx`'s if it does); `contracts/settings.ts`'s
disabled-by-default driver list gains upstream's `kiro` and still omits
`pi` (standing; `pi` was already in upstream's list at base). Nothing in
Loom's settings defaults enables a new driver.

### 6.9 Config, `AGENTS.md` and docs

| File | Markers | Resolution |
| --- | ---: | --- |
| `AGENTS.md` | 3 | Loom's file (DL-1416). Hunk 1 (the intro) and hunk 2 (Entry points / Clients / Providers: Loom's "Loom runs pi" line, Australian spelling) take Loom's side. Hunk 3: keep Loom's "Smallest proof" line and replace the tsc-rs sentence with upstream's: "Use `vp run typecheck`; it caches per package. Each package runs `effect-tsgo tsrs --noEmit`, the Rust TypeScript 7 checker with Effect's diagnostics built in. There is no `typescript` package to run." The `.repos/effect/LLMS.md` line auto-merged. Upstream's new "Do not run repo-wide checks" line is not ported (Loom's completion gates are `vp check` and `vp run typecheck`) |
| `pnpm-workspace.yaml` | 3 | §5.1: pi catalog line and patch beside upstream's bumps (hunks 1, 3); `minimumReleaseAge: 0` kept, Loom's stale exclude copy dropped (hunk 2) |
| `pnpm-lock.yaml` | 17 | `git checkout --theirs`, then `vp i` until unchanged (DL-1220) |
| `apps/server/package.json` | 2 | §5.1: union; `jose` dropped |
| `evals/package.json`, `evals/README.md` | 1 + 1 | Union: Loom's `explainer-density` script and table row beside upstream's `pr-content` and `voice-cleanup` rows and the tsgo typecheck line |
| `docs/user/composer.md` | 2 | Hunk 1: take upstream's `/clear` paragraph, keep Loom's meter sentence (on by default, DL-1712) in place of upstream's "off by default" one. Hunk 2: Loom's `!` thread-search sentence beside upstream's "copies a link to the thread" wording (union) |
| `.repos/effect/.envrc` | DU | `git rm` (§5.1) |
| `apps/server/src/provider/agentContextBudget.json` | 1 | Take upstream's three values, then S2a re-runs `AgentContextBudget.test.ts` (Loom's stubs beside upstream's `NodeCrypto.layer`, union) and records Loom's measured `mcpToolListJsonBytes` (DL-1654's method); the file cannot carry a marker (§8.2) |

### 6.10 Mobile

4 conflicts, 5 markers, 18 `loom:` lines; every Loom hunk is a small addition
beside an upstream edit:

| File | Loom's hunk | Upstream's change | Resolution |
| --- | --- | --- | --- |
| `features/layout/AdaptiveWorkspaceLayout.tsx` (1) | `handleSelectThread` widened to `Pick<…, "environmentId" \| "id">` so an archived search hit opens (pull 14's `HomeRouteScreen` rule, moved here by upstream's shell refactor) | 33 lines of Android split-view animation on the same lines | Union; Rule C (no `useCallback`) |
| `features/threads/PendingUserInputCard.tsx` (1, A) | `askedAgo` ("Asked 3h ago") | Upstream deleted the `EXPANDED_CARD_IS_OVERLAY` constant Loom's lines sat under (§7.1 caveat: verified absent at `3fa57b92a2`) | Keep only Loom's three `askedAgo` lines |
| `features/threads/ThreadNavigationSidebar.tsx` (2) | `ArchivedSearchResultRow.loom` import; `searchArchivedItems` appended to the list (DL-1709) | Hunk 1: `useSelectWorkspaceDetail` moved to `../layout/workspace/` (take upstream's path, keep Loom's import). Hunk 2: upstream removed the 70-line `listMenuActions` block Loom's three lines preceded (#27086, the pane bar owns it) | Hunk 2: keep Loom's three lines, drop the moved block (§7.1 caveat) |
| `features/threads/threadListV2.ts` (1) | `shelllessArchivedMatches`, `rowAttentionOf` imports | `MenuAction` type import | Union |

Upstream's mobile shell refactors (AppBar/SheetHeader, the workspace shell in
layout, Nitro highlights) are in files Loom does not touch: take verbatim.
`apps/mobile` now runs the Effect diagnostics (#31111); Loom's nine silently
merged mobile files (`ThreadFeed.tsx` 12 lines, `thread-list-v2-items.tsx` 9,
`HomeScreen.tsx` 6) are not Effect code. `vp run lint:mobile` runs in S2b.
