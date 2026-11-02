## 6. Other seams, read and recorded

### 6.1 Orchestration: Stop always completes (#27252), bounded history pages (#26240), managed policy (#27197)

| Loom seam | What changed this week | Finding | Verdict |
| --- | --- | --- | --- |
| `workstream_stop` (`handlers/stop.ts` dispatches `run.interrupt`), the cascade cancel | #27252: `run.interrupt` now waits for the provider to confirm within a timeout (`ProviderAdapterInterruptTimeoutError`), a new `thread.interrupt.unresponsive` command kills the agent's process scope (`agentScope.ts`), the web offers **Force stop** (`useForceStopThread.ts`) when a stop does not complete | Loom's stop goes through the same `run.interrupt`, so it gains the completion guarantee; the Pi adapter's `interruptTurn` must confirm (82 Loom lines in `adapter.ts` silently merged, the interrupt path is upstream's) | Gate 2a/2b read `adapter.ts`'s interrupt path; S4: `workstream_stop` on a running pi child completes, Stop on a pi root completes without Force stop |
| `isLoomCommand` receipted no-ops (`Orchestrator.ts` hunk 6) | Upstream rewrote the clause as `Effect.filterOrFail` with `thread.interrupt.unresponsive` and `thread.delete … onlyIfUnused` added, and `refuseAboveRuntimeModeCeiling` (managed policy) tapped before it | Union: Loom's `isLoomCommand(command)` joins the list | Rule D |
| Loom's delegation guard arm (hunk 5) and `loomStore` binding (hunk 2) | Upstream inserted `updateDelegatedCompletionOnlyRunId` and the managed-policy `runtimeModeCeiling` read at the same lines | Union; Loom's arm stays first | Rule D; Gate 1 reads |
| **The `ask_user_question` answer path** (`runtime-request.respond`, hunk 4 `[29/0A]`, trial l.9280–9311): Loom's `loomAskAnswer` (joins a multi-select array for a `loom-ask:` request, DL-720) and `if (yield* loomAskTakesAnswer(runtimeRequest.id)) return;` (a live `mcp__t3-code__ask_user_question` waiter takes the answer as its tool result and no chat message is posted, P3-21/DL-347) | Upstream **hoisted** the answer validation above the event emission (#19229 "agent questions stay answerable after a server restart"; `fa31b66bbb` l.8952–9015) and now accepts multi-select itself (`isMessageQuestionAnswer` takes a string or a non-empty array, `answer.join(", ")`), so the old site inside the `responseCapability.type === "message"` branch is empty on upstream's side | Not Rule A. `sideresolve.py --ours` would keep a second, shadowed validation; `--theirs` would drop `loomAskTakesAnswer` and every answer to an agent's question would also post as a chat message while the tool keeps polling. **Take upstream's hoisted validation; delete `loomAskAnswer` as superseded (doctrine §4.3: export in `Orchestrator.loom.ts` and import); re-home the one marked `loomAskTakesAnswer` line into upstream's `if (runtimeRequest.responseCapability.type === "message")` branch after `if (resolvedNodeStatus === "cancelled") return;` and before `dispatchMode`** | Rule D; **Gate 1 reads**; S4 answers an agent's `ask_user_question` in the UI and sees the tool result with no duplicate chat message (DL-1607) |
| `joinLoomShellFields` / `joinLoomThreadShell` (hunk 7) | Every service method became a named `Effect.fn` | Both joins inside upstream's wrappers; `listActiveShellIndex` is the new read (§4) | Rule D |
| V1 Loom-history guard (`ProjectionMaintenance.ts`, DL-1300) | Comment-only hunk (upstream shortened its comment) | `LOOM_HISTORY_EVENT_TYPES` set stays | Rule A; S3 counts history rows before and after compaction (DL-1300's method) |
| Bounded history pages (#26240) | `ProjectionStore.getThreadHistoryPage`, `threadHistoryPaging.ts`, client `threadHistoryController`/`threadHistoryMerge`; `MessagesTimeline.tsx` loads older pages on scroll | Loom's timeline rows (`loomTimelineRows.ts`: handoff receipts, control cards, model-change dividers) are spliced "before the first later row"; a Loom row older than the loaded page's first message lands at the top until the page loads. The sidecar rows are not paged | Gate 2c reads the splice; **S4 opens a root longer than one page** and checks Loom rows do not pile at the top; a DL row if they do |
| Managed policy (#27197) | `/etc/t3code/policy.json` (`managedPolicyPath`), read once at startup; `settings` record with `locked` values overlays `ServerSettings`; `limits.maxRuntimeMode` caps dispatch; `providers.allowedDrivers` | The cockpit has no policy file, so `ManagedSettings.unmanagedSettings` applies. Loom's defaults (`contextWindowMeterEnabled: true`, `autoResumeLimitedThreads: true`, pi enabled, allow-list fields) live at schema decode, below the overlay, exactly where upstream's own defaults live: a policy could override them as it could upstream's | Finding; no change. `t3 policy show` is new CLI surface, not Loom's |
| Secret providers (#27115, #27746) | `SecretResolver.layer`, `ResolvedProviderInstanceEnvironment`, `ProviderInstanceRegistryHydration.ts` env union, `serverSettings.ts` `withoutUnknownSecretProviderConfigs` | Loom's `ProviderUsageSource*` block and embedder-key redaction are unrelated fields beside them; upstream **re-solved Loom's settings materialisation memo** (`materialized`/`secretWriteGeneration` vs Loom's `memo`/`writeEpoch`, same job) | Unions; the memo follows doctrine §4.3: upstream's replaces Loom's (`serverSettings.ts` hunk 3), `resolveTextGenerationProvider` stays (hunks 4–5) |
| `ProviderSessionManager.ts` last-error (Loom #435) | Upstream now bounds the banner message with `makeProviderFailure({cause}).message` and renamed the log event | Keep Loom's "adapter's own error outranks the stream failure" (the liveness sweep resumes only a classed failure) and use upstream's bounded message as the fallback detail | Read; Gate 1 |
| `databaseMigrationHead.ts` (new): `t3 service`/self-update preflight refuses a database that recorded a migration above the build's head | Reads `effect_sql_migrations` only | Loom's ledger is `loom_sql_migrations` (ids 1001+), so no false "newer build" refusal; the cockpit's upstream ledger max is 69 | Finding |

### 6.2 Side chats and the sidebar (see §5.3)

Resolution per file in §7.3. Loom's `rightPanelStore.ts` surfaces sit beside
upstream's side-chat tabs (three small content hunks); `RightPanelTabs.tsx`'s
seven markers are Loom's `onAddTasks`/`loomSurfaceActions` props beside
upstream's `onAddSideChat`/`sideChatAvailable` at each site (union).

### 6.3 The dead-code deletion (#26238), the `lost-ours` list and the broken Loom imports

Upstream deleted "18k lines of code that nothing reaches" (876 files). Three
consequences for the merge:

**(a) Large Loom-side regions classed A are upstream deletions or hoists.** git
keeps a deleted or moved block on Loom's side when a Loom line sits inside it,
and `hunks.py` classes the hunk A because upstream's side has no code. Take
upstream's side and keep only Loom's own lines, after grepping upstream's blob
for each non-`loom` code line (pull 13's Rule A caveat, §7.1): `Orchestrator.ts`
hunk 4 (29 lines: the `ask_user_question` answer validation upstream hoisted,
§6.1; `loomAskAnswer` superseded, `loomAskTakesAnswer` re-homed); `ProjectionStore.ts`
hunk 5 (914 lines: `layerMemory`, the in-memory projection store; no Loom-only
file imports `ProjectionStore.layerMemory`, and Loom's one line inside it, the
tool-output-image ids, is also in the SQLite layer at l.5473);
`packages/contracts/src/providerRuntime.ts` hunks 2–4 (921 lines of V1 provider
runtime schemas: `ProviderRuntimeEvent`, `thread.queue.updated`,
`UserInputRequestedPayload`; Loom's `costUsd` consumers read
`OrchestrationV2ProviderTurnTokenUsage`, Loom's `dismissible` consumers read
the V2 runtime request, so only the `recommended` field on
`UserInputQuestionOption`, which upstream kept, is re-applied);
`TimelineV2EventRow.tsx` hunk 2 (84 lines: the non-lifecycle event branch; keep
Loom's `ConsultCardRow` early return at the top of the new `V2EventRow`);
`CommandPalette.tsx` hunk 3 (130 lines); `routes/_chat.tsx` (192 lines: the
`logicalProject` grouping; the dangling `../logicalProject` import goes with
it, Loom's `useThreadTabKeyboard` hook is mounted in upstream's
`ChatRouteLayout`).

**(b) The `lost-ours` list (24 files, 53 names)** is cleared: every name is an
upstream de-export or deletion, checked by word across all 672 Loom-authored
files and across Loom's added lines in shared files. Two Loom consumers remain:
`ThreadSettlementService.layer` (upstream removed the `layer` export; Loom's
`apps/server/src/loom/prToolkit.test.ts` builds its layer with it → use
`Layer.effect(ThreadSettlementServiceV2, ThreadSettlementService.make)`, S2a)
and `encodeScanCache` (Loom's hunk in the conflicted `usageScanCache.test.ts`
→ Rule T). The other 51 (`useThreadFamily`, `resolveProjectAutoPull`,
`clientRuntimeModeCeiling` → `clientModeCeiling`, `RuntimeItemId`, …) have no
Loom consumer.

**(c) Broken imports in Loom-only files** (`imports.py` over 698 Loom-only
`.ts/.tsx/.mjs` files; relative, `~/` and `@t3tools/*` specifiers resolved
against the trial tree, named imports checked against the target's exports):

| Loom file | Missing | Fix (S2b unless noted) |
| --- | --- | --- |
| `apps/web/src/loom/DeployToastCoordinator.tsx`, `loom/HandoffToastCoordinator.tsx` | `useEnvironmentIds` from `~/state/environments` (deleted) | `useEnvironments().map((e) => e.id)` (exported), or `useConnectedEnvironmentIds()` if the coordinators only need connected ones (S2b reads; DL row) |
| `apps/web/src/loom/ThreadTabsStrip.tsx` | `ThreadStatusLabel` from `~/components/ThreadStatusIndicators` (de-exported, still defined at l.606) | one marked `export` restored |
| `apps/web/src/preview/fixtures.tsx`, `preview/loomPreviewGroups.tsx` | `setPendingUserInputCustomAnswer`, `togglePendingUserInputOptionSelection`, `PendingUserInputDraftAnswer` from `../pendingUserInput` | moved to `@t3tools/client-runtime/state/pending-user-input`; repoint |
| `apps/server/src/loom/prToolkit.test.ts` | `ThreadSettlementService.layer` | `Layer.effect(ThreadSettlementServiceV2, make)` (S2a) |
| conflicted: `FilePreviewPanel.tsx` | `./useFileSaveCoordinator` (upstream replaced it with `fileSaveSessions.ts`) | Rule D in §6.4: Loom's save-coordinator hunk re-expressed on `useFileSaveSession`; Loom's `useFileSaveCoordinator.browser.test.tsx` goes with the module (S1 deletes it) |
| conflicted: mobile `ThreadFeed.tsx`, mobile `state/entities.ts`, web `MarkdownThreadLink.tsx` | `resolveThreadLinkRef` from `@t3tools/shared/threadLinks` (replaced by `guessThreadLinkRef`/`threadLinkCandidates`, #26239) | repoint (the two mobile files silently merged; S2b) |

Every other relative, `~/` and `@t3tools/*` import in Loom-only files
resolves. `dangling.py`'s other six hits are pre-existing false positives
(string fixtures in `pullRequestFileOrder.logic.test.ts`, a font path, codegen
output, a runtime-only `app.shared.js`, `bundledDev.test.ts`'s built assets,
a mobile test's moved context).

### 6.4 Web shape churn: where Rule D applies this week

No Loom-edited file was split into modules. Upstream grew or shrank the files
Loom marks, so Rule D is in-file: resolve to upstream's side, then re-apply
Loom's `base..main` lines where the surrounding code now sits.

| File | Upstream change | Loom's hunks and where they go |
| --- | --- | --- |
| `files/FilePreviewPanel.tsx` (14 markers, 62 `loom:` lines) | #21362/#21467/#21469 previews (office, fonts, archives, sqlite, images: `isDocument`, `PreviewImage`, `lazy`/`Suspense`), `fileSaveSessions.ts` replaces `useFileSaveCoordinator`, `useFileLineReveal`, `revisionedQuery` | Loom's #500/#502 scroll restore (`fileScrollKey`, the remembered position, the Virtualizer wrapper), revision-keyed image reload (`RevisionImage`, `useAssetUrlRefresh`), long-line elision (`elideLongLines`, `LONG_LINE_RENDER_CAP`), MDX truncation guard (`mdxTruncated`), read-cap and line-cap notices, `documentKey` revision. 53 of 59 hunks stay by context; the save-coordinator hunk is re-expressed on `useFileSaveSession(saveTarget, onPendingChange)`. **Gate 1 reads** |
| `DiffPanel.tsx` (10, 19) | #19941 local commits: `diffSelection.kind === "commit"`, `branchCommitsQuery`, `openCommitMenu`, `toolCallSelection`, `useLiveRefresh` replaces `useWorkspaceMutationRefresh` | Loom's #424/#502 change review (`loomReview`: scope entries, `selectedRunId` guard, `branchDiffPreview` swap, `currentLoadDiffFiles`, the refresh gate) re-applied on each new selector; `LoomScopeMenuEntries` keeps its place in the scope menu above upstream's commit submenu. **Gate 1 reads** |
| `RightPanelTabs.tsx` (7, 21) | side-chat add action and props | Union at all seven sites |
| `preview/PreviewView.tsx` (5, 7) | element pick via `pickActiveRef` and `pickActive` state; the unmount-cancel effect restored upstream | **Standing:** Loom's side of hunk 5 (no cancel on unmount: the annotation note lives in the page). Loom's per-tab `endPreviewPick(runtimeTabId, …)` where upstream reads `pickActiveRef` (read) |
| `ChatView.tsx` (9, 29) | side chats (+462/−), force stop, thread state at the timeline end | 20 of 22 Loom hunks stay by context; the Rule A hunks keep only Loom's lines |
| `chat/MessagesTimeline.tsx` (6, 21) | #26240 paged history, #25401 end-state rows | Loom's bleed budget, model-change rows, W3 jump and the kickoff split stay; 9 of 16 by context, the rest are Loom imports |
| `chat/ChatComposer.tsx` (4, 8) | #25869 simpler composer (3,971 → 3,589 lines) | `!` menu, spend block, `/handoff` items: all stay |
| `settings/SettingsPanels.tsx` (2, 4) | #25651 regroup moved 241 lines of rows | `<LoomAutoOpenSettingsRows>` re-applied after `<BackgroundActivitySettingsRow />` at its new line (1976 upstream) |
| `settings/providerDriverMeta.ts` (1, 1) | now a one-line re-export of `@t3tools/client-runtime/provider-clients` (mobile's copy deleted) | Loom's "pi leads the driver list" moves to `packages/client-runtime/src/providerClients.ts` (Appendix D) |
| `routes/_chat.tsx` (1, 2), `routes/__root.tsx` (2, 6), `ThreadRouteView.tsx` (2, 5) | large upstream cuts (192, 153, 43 lines) | Loom's tab keyboard hook, root lines and shell-less archived-root open re-applied inside the shorter files |
| `chat/MarkdownThreadLink.tsx` (2, 4) | #26239: props take a parsed `ThreadLink`, `UnresolvedChip` for an unknown thread, `formatThreadLink` for copy | Loom's status-led `ThreadMention` renders the resolved case with `fromThreadRef`; v1 links (`t3-thread://v1/<id>`, what Loom's addendum tells agents to write) still parse and resolve to the message's environment, so no model-read text changes |
| `components/chat/ComposerActivityStatus.tsx` (UD) | deleted by #25401 | Loom's sync-error diagnostic beside "Loading messages…" re-homes to `chat/ThreadNow.tsx`'s `ThreadSyncLine` (the row that now renders `threadSyncLabel(phase)` at the end of the timeline); Appendix D |
| `index.css` (2, 19) | plain-text fence rule; diagnostics-table cell wrapping (upstream's answer to the same problem as Loom's #499) | Scanned-path link block stays; the table rule is a read: take upstream's wrapping where it covers #499's case, keep Loom's lines only where it does not; S2b's `/preview` table fixtures decide |

#25778 ("the new design is the only design") removes pull 13's beta toggle: the
new look is now the only one, so S4's visual pass covers Loom's chips, MDX
plan, workstream panel and graph on it without a toggle.

### 6.5 Settings, providers and the Pi-only registry (standing rulings in new shapes)

- `contracts/settings.ts`: `contextWindowMeterEnabled: true` and
  `autoResumeLimitedThreads: true` stay (upstream still ships `false`);
  upstream's `snoozePresets` default is taken beside them; the
  disabled-by-default driver list gains upstream's `fx` (Vercel fx, #18277)
  and still omits `pi`.
- `builtInDrivers.ts`: `BUILT_IN_DRIVERS = [PiDriver]` (standing); upstream's
  union now includes `AcpRegistryDriver` and `fx`. Import only what the usage
  readers need (DL-1450's `MuseDriver` precedent); S2a's typecheck tells.
- `contracts/model.ts`: Loom's `[PI_DRIVER_KIND]: PI_DEFAULT_MODEL` + upstream's
  opencode default change.
- `ProviderInstanceRegistryHydration.ts`: the Pi-only env union gains
  upstream's `SecretResolver`, `Path`, `FileSystem`, `PortDiscovery` members.
- `textGeneration.ts`: `disableExtensions: false` (standing) silently merged;
  the conflict is Loom's dialog-cancel block beside upstream's `message_end`
  turn-error read (union). DL-1514's message stays.
- `serverSettings.ts`: see §6.1 (upstream's materialisation memo replaces
  Loom's).

### 6.6 Migrations 070–076 against the fork lane and Loom's runtime

| Upstream migration | What it does | Touches a table a fork migration or Loom reads? |
| --- | --- | --- |
| 070 `PeerLinks` | `CREATE TABLE peer_environment_links` | Additive, new table. `migrate-dev-db.ts` skips it (upstream's own line; union) |
| 071 `PeerLinkFence` | `ALTER TABLE peer_environment_links ADD COLUMN fenced` | Additive |
| 072 `WaitingLinkRequestIndex` | partial `CREATE INDEX` on `orchestration_v2_projection_turn_items` (`type = 'link_request' AND status = 'waiting'`) | Additive; 304,894 turn items on the cockpit, 2 active: one table scan, seconds |
| 073 `ActiveTurnItemIndexes` | two partial indexes on turn items (`status IN ('pending','running','waiting')`) | Additive; same scan |
| 074 `ExcludeAttachmentPlaceholdersFromSearch` | `SELECT 1 FROM sqlite_master WHERE name = 'orchestration_v2_message_search'`; **returns early when absent**; else drops and recreates the three triggers via `createMessageSearchTriggers` (now shared with 069) | **On the cockpit: a no-op**, since Loom's 1065 dropped the table (verified read-only: 0 tables, 0 triggers named `orchestration_v2_message_search*`, 15 `loom_ts_*` triggers). **On a fresh home:** 069 creates, 074 recreates the triggers, then 1065 drops the triggers first and the table, so nothing is left behind. S3 proves the fresh-home order (no `orchestration_v2_message_search*` objects after boot) |
| 075 `SubagentDeliveryState` | `ALTER TABLE orchestration_v2_projection_subagents ADD COLUMN completion_delivery_state`, backfill from `payload_json`, new index | Additive; the cockpit has 0 subagent rows (Loom children are threads, not upstream subagent items) |
| 076 `ProjectionProjectsPinArchive` | `ALTER TABLE projection_projects ADD COLUMN pinned_at, archived_at` | Additive; 40 projects |

No upstream migration drops or renames anything the fork lane (1001–1066) or
Loom's runtime reads (DL-1251's check). `Migrations.ts` is byte-identical in
the trial tree. `initializeV2Database.ts` (+43) only cleans abandoned
`.v2-import-<pid>-*` copies and tags new ones with the pid. `Sqlite.ts` adds
`PRAGMA temp_store = MEMORY` beside Loom's `cache_size` (union).

### 6.7 Thread search after pull 13

Loom keeps its hybrid index with upstream's surfaces (pull 13 §8.1 row 1,
1065). This week upstream changed `ThreadSearch.ts` by 13 lines (exclude
`lineage.sideChat` threads from every eligible set; `nonPlaceholderMessageCondition`
skips attachment-only bootstrap prompts) and `messageSearchIndex.ts` by 71
(the trigger DDL moved into `createMessageSearchTriggers`, shared by 069 and
074; the placeholder predicate), and both merged silently onto Loom's seven
marked lines. Everything that reads `orchestration_v2_message_search` at
runtime is guarded on `sqlite_master` (`ThreadSearch.ts` l.441 and
`rebuildMessageSearch` l.108), so nothing assumes 069's table exists.
`paletteSearch.ts` (+157) and `CommandPalette.logic.ts` (+151) are #26936
(per-thread fields reused across keystrokes) and #26350 (flattened call
chains): ranking unchanged, Loom's `CommandPaletteThreadContentMatch` sits
beside upstream's new `AddProjectEntry` (union). The mobile jump is unchanged.
`ThreadSearch.test.ts`'s one conflict is upstream's new `EXPLAIN QUERY PLAN`
test over `messageHitsQuery`, which needs 069's table at test time and 1065
drops it: keep Loom's marked one-line note, as pull 13 did for the first such
test. `DatabaseMaintenance.ts` (silent) still runs both rebuilds after VACUUM.
No S2c.

### 6.8 Lint and typecheck rules that are new errors on Loom files

`vp check` and `vp run typecheck` must pass before ship. Measured by grep
where possible; the exact counts come from the first `vp lint`/`vp run
typecheck` in S2.

| Rule | Scope | Loom hits | Fix |
| --- | --- | --- | --- |
| `t3code/no-unreasoned-state-sync` (new, replaces `react-effect-budget`) | `apps/web/src/**`, `apps/mobile/src/**`, `packages/*/src/**`, tests excluded | **54 effects in 37 Loom-only files** (`MdxPlanAnnotationLayer` 6, `WorkstreamGraph` 5, `MdxPlanRenderer` 3, `canvas.tsx` 3, `useThreadTabsSync` 2, `FileChangeView` 2, `WorkstreamTimeline` 2, `questionRefs` 2, 29 files with 1) **+ 2 Loom-added effects in shared files** (`FileBrowserPanel.tsx`, `MarkdownCodeBlock.tsx`); none carries a reason yet | **Pre-ruled (§8.2):** a `// oxlint-disable-next-line t3code/no-unreasoned-state-sync -- <what it keeps in step and why>` above each, written per site (upstream's own mechanism: 505 such lines), no file-level disable, no exemption list; an effect that the message's alternatives cover is removed instead if the change is a line or two |
| `react/purity`, `react/no-unstable-nested-components`, `react/set-state-in-effect`, `react/exhaustive-effect-dependencies`, `react/immutability`, `react/no-array-index-key`, `react/static-components`, `react/capitalized-calls`, `react/memo-dependencies`, `react/refs` (promoted or added as error) | lint config | Pull 13 ended with 429 warnings; one known `no-unstable-nested-components` warning is in Loom's #442 user-message fallback (DL-1538), now an error | Fix at the site; counts from the first `vp check` |
| `eslint/no-unused-vars` (error, #25100), `oxc/no-accumulating-spread`, `typescript/no-extraneous-class`, `eslint/no-empty-pattern`, `eslint/no-new`, `unicorn/no-useless-spread`, `eslint/no-unsafe-optional-chaining`, `eslint/no-unneeded-ternary`, `unicorn/no-useless-fallback-in-spread`, `unicorn/require-module-specifiers`, `t3code/no-inline-schema-compile` (warn → error) | lint config | Unknown until lint runs | Mechanical |
| 22 `@effect/language-service` diagnostics at `error` (`tsconfig.base.json`: `effectFnOpportunity`, `preferSucceedSomeOrNone`, `unnecessaryEffectGen`, `catchToIgnore`, `flatMapConditionalToFilterOrFail`, `redundantMapError`, `optionMatchToFromOption`, `allOfMapToForEach`, `raceFirstWithSleepToTimeout`, `abortControllerInEffect`, `runEffectInsideEffect`, `tryCatchInEffectGen`, …; `effectFnOpportunity` off in tests and testkits) | enforced by tsc-rs (`vp run typecheck`; the drop-in has Effect diagnostics built in) | grep over 441 Loom-authored non-test source files: 0 `=> Effect.gen(` arrows (pull 13's codemod), 1 `Effect.succeed(Option.…)`, 4 `Effect.succeed(undefined)`, 1 `new AbortController`; the rest need the checker | Mechanical per diagnostic; S2a/S2b by package; a DL row with the counts. The typecheck gate is therefore stricter than pull 13's |
| `t3code/no-dom-test-environment` | `apps/**/src/**`, `packages/**/src/**` | Upstream deleted the (empty for it) `DOM_TEST_ENVIRONMENT_ALLOWLIST` and the `excludeFiles` on this rule and on `require-disposable-render`; Loom's 12 jsdom tests (`mdx-plan/**` 10, `loom/chatPathScan.test.ts`, `preview/questionPeek.test.tsx`) still need the escape | Keep Loom's list and re-add both `excludeFiles` lines, marked (DL-1474's shape); converting them to browser tests remains the follow-up |
| lint-staged (`vite.config.ts` `*` hook) now runs `vp lint` and `vp run knip:check` on every commit | pre-commit | Merge commits use `--no-verify` as before; `pnpm ship` runs its own gates | Tooling note (§13) |

Already satisfied by Loom at the base, unchanged: `no-em-dash-copy` (ruled (a)
in pull 13; new Loom strings since are caught by the same lint),
`no-low-value-comments`, `prefer-effect-fn`, the test-hygiene rules,
`require-disposable-render`.

### 6.9 Versions and toolchain

| Item | Base → target | Consequence |
| --- | --- | --- |
| Effect, `@effect/*` | 4.0.5 → 4.0.5 | No change; no Slack-bridge check |
| React | 19.3.0 → 19.3.0 | No change |
| Node (`engines.node`) | 26.12.1 → 26.12.1 | No change; host and VM already on 26.12.1 (DL-1509) |
| pnpm (`packageManager`) | 12.14.0 → 12.14.0 | No change |
| TypeScript | `npm:@tsc-rs/typescript@0.8.0` both sides | No change; the Effect diagnostics it enforces grew (§6.8) |
| Vite+ | 1.4.0 → 1.4.0 | No change; `vp i` converges in one or two passes |
| pi | `@earendil-works/pi-coding-agent` 1.3.0 (catalog + patch) | Upstream does not depend on it; the catalog line (`pnpm-workspace.yaml` conflict) and patch survive |
| Electron | 44.9.3 → 44.10.0 | Desktop only |
| `alchemy`, `@alchemy.run/*`, `@distilled.cloud/cloudflare` | beta.80 → beta.84, rc.13 → rc.17 | Relay infrastructure, not Loom's |
| `@cursor/sdk` | 1.0.35 → 1.0.38 | `apps/server/package.json` conflict beside Loom's pi line (union); dormant driver |
| `ffi-rs` 1.3.2 (new), `google-auth-library` | new upstream dep; Loom's stays | `apps/server/package.json`, `knip.jsonc` unions |
| `patches/` | + `micromark@4.0.2`, `mdast-util-to-hast@13.2.1` (perf), `react-native-keyboard-controller` 1.22.7 → 1.22.8, `alchemy` re-cut; − `@muse-code/sdk@1.4.6` | The two markdown patches sit under Loom's MDX pipeline (`@mdx-js/mdx`, remark); S2b's `/preview` MDX fixtures are the check |
| `@pierre/diffs` | 1.6.1 → 1.6.1 | No change |

### 6.10 Mobile, config and tooling

**Mobile** (6 conflicts, 10 markers, 33 `loom:` lines; every Loom hunk is a
small addition beside an upstream edit):

| File | Loom's hunk | Upstream's change | Resolution |
| --- | --- | --- | --- |
| `features/home/HomeRouteScreen.tsx` (1) | `handleSelectThread` widened to `Pick<…, "environmentId" \| "id">` so an archived search hit (no shell) opens | the `useCallback` wrapper removed (React Compiler) | Rule C: Loom's widening on the plain function |
| `features/keyboard/CommandPalette.tsx` (2) | `threadSearchExcerptLabel` import; the content-match map (`useMemo`, allowed on mobile) | `isListedThreadLineage` import; triage, new-task and draft-environment hooks (#22753, #26901) | Unions |
| `features/threads/PendingUserInputCard.tsx` (1) | `askedAgo` ("Asked 3h ago") | `proseDirectionStyle` (RTL text) | Union |
| `features/threads/ThreadFeed.tsx` (1) | the control-bubble block (channel colour, who is talking) | `hasBubble`/media attachment layout (#26240, #26239) | Read: Loom's block inside upstream's layout |
| `features/threads/thread-list-v2-items.tsx` (4) | rollup imports (`attentionLabel`, `pendingQuestionOf`, `relativeTime`), `WorkstreamBadge.loom`, the question-age row, the accessibility label parts | `threadChipCopyTarget`, `useScaledTextRole`, `rowAccessibilityLabel`, `environmentLabel` | Unions; Loom's label parts appended to upstream's `rowAccessibilityLabel` |
| `features/threads/threadListV2.ts` (1) | `shelllessArchivedMatches`, `rowAttentionOf` imports | `isListedThreadLineage`, `SnoozePresetSetting` imports | Union |

Upstream reworked crash reporting (#19093, Axiom with symbolicated stacks) and
queued edits (#25468) in files Loom does not touch: take verbatim. Two mobile
files silently merged with a now-missing import (`resolveThreadLinkRef`, §6.3
(c)). `vp run lint:mobile` runs in S2b.

**Config and tooling** (the lock/config zone plus the config files in the
server-other zone):

| File | Markers | Resolution |
| --- | ---: | --- |
| `AGENTS.md` | 5 | Loom's file is Loom's (pull 13 DL-1416's rule). Port from upstream's side only the rules that bind Loom code after this pull: `vp run typecheck`, not `npx tsc` (tsc-rs underneath); `node -e` snippets run from a package directory; `vp test run <files>` with `-t "<name>"`; the 500 MiB seed guard sentence, since Loom's dev-runner adopts it (below). Keep Loom's seed/`--base-dir` text (DL-1516) and the computer-use line. Drop GitCafe and "never make a PR". DL row listing what was ported |
| `README.md` | 4 | Loom's file (rewritten for the fork): take Loom's side of all four hunks; upstream's provider list, install matrix and doc index describe T3 Code, not Loom |
| `.gitignore` | 1 | Union (Loom's `.artifacts/` and render outputs + upstream's `artifacts/mobile-behavior/`) |
| `knip.jsonc` | 2 | Union (Loom's `@earendil-works/pi-coding-agent` ignore + upstream's `ffi-rs`) |
| `vite.config.ts` | 1 | Loom's 12-entry `DOM_TEST_ENVIRONMENT_ALLOWLIST` stays; re-add the two `excludeFiles` lines upstream removed with its empty list, marked (§6.8) |
| `pnpm-workspace.yaml` | 1 | Union: Loom's pi catalog line beside upstream's `@alchemy.run/*`; patches list is upstream's plus Loom's pi patch |
| `pnpm-lock.yaml` | 31 | `git checkout --theirs`, then `vp i` until unchanged (DL-1220) |
| `apps/server/package.json` | 2 | Union: Loom's pi dependency + upstream's `@cursor/sdk` 1.0.38 and `ffi-rs`; `google-auth-library` stays |
| `apps/web/package.json` | 2 | Union: Loom's `zod` and `jsdom` (DL-1301) + upstream's `vfile`, `micromark-util-types`; `mermaid` (DL-1470) is outside the hunks, check it survived |
| `scripts/dev-runner.ts` | 2 | Union: upstream's 500 MiB first-start seed guard (`LARGE_DEV_DATABASE_BYTES`) inside Loom's `$T3CODE_HOME`-sourced, port-scoped seed (DL-1500, DL-1515); the `--seed` help text says both |
| `scripts/lib/cli-external-packages.test.ts` | 1 | Rule A (one marker) |
| `apps/server/scripts/migrate-dev-db.ts` | 3 | Union: Loom's imports and `MigrateDevDbSlotCollisionError` + upstream's `MigrateDevDbServerRunningError` and four more skipped tables (`peer_environment_links` among them); both index rebuilds stay |
| `docs/user/composer.md` | 1 | Union: upstream's linked-machine and Copy-thread sentences + Loom's `!` thread-search sentence |

New upstream tooling to know: the lint-staged `*` hook now runs `vp lint` and
`vp run knip:check` (merge commits stay `--no-verify`); `vp run typecheck` is
tsc-rs with the Effect diagnostics (§6.8); `t3 policy show` and `t3 triage`
are new CLI surfaces Loom does not touch.
