## 7. Upstream change digest and per-zone resolution doctrine

Doctrine §4.3 (`05-strategy.md`): where upstream now expresses the same
functionality, upstream's mechanism is the baseline and Loom's variant is
deleted. Otherwise upstream wins verbatim and Loom's seam is re-applied behind
`// loom:`.

### 7.1 The rules, as they apply this week

- **Rule A: comment-adjacent (3 markers), and the caveat applies to all
  three.** `hunks.py` labels a hunk A whenever upstream's side has no code and
  Loom's side has a `loom` line, so an A hunk can be upstream deleting or
  moving a block that holds a Loom line. Before keeping Loom's side of **any**
  A hunk, grep upstream's blob for each non-`loom` code line in it; a line
  upstream deleted is dropped, one upstream moved gets Loom's change at its
  new home. This week all three are moves or deletions: `pnpm-workspace.yaml`
  [135/0] (upstream moved `minimumReleaseAgeExclude`; keep `minimumReleaseAge:
  0` and its comment, drop the list copy, §5.1), `ws.ts` [3/0] (upstream
  deleted the `modelManifest`/`providerLatestVersions` locals; keep Loom's
  `providerHealthRegistry` line), mobile `PendingUserInputCard.tsx` [9/0]
  (upstream deleted `EXPANDED_CARD_IS_OVERLAY`; keep `askedAgo`). Two
  content hunks are the same shape in disguise and are treated the same way:
  mobile `ThreadNavigationSidebar.tsx` [75/1] (upstream removed
  `listMenuActions`) and `apps/server/package.json` [2/0] (upstream removed
  `jose`; keep `google-auth-library`).
- **Rule A caveat, second form: a Loom clause the upstream code already
  covers** is deleted as superseded (doctrine §4.3), with a DL row: the
  snooze guard's `hasBlockingPendingRequest` call in `Orchestrator.ts` hunk 1
  (§6.2) this week.
- **Rule B: upstream-only insertion (2 markers).** `UsageLimitSources.ts`
  hunk 2 (`readManagementKey`), `PreviewView.tsx` hunk 1 (`pickActiveRef`,
  `annotationVoice`, `keybindings`): take upstream's. DL-1203's warning holds
  (a "B" that is a Loom deletion against an upstream edit takes Loom's side);
  neither of these is that.
- **Rule C: React Compiler shape.** Mobile `AdaptiveWorkspaceLayout.tsx`
  (Loom's widening on the plain function). No `useMemo`/`useCallback` in a
  web file (DL-1273).
- **Rule D: re-apply onto upstream's shape (23 hunks with a side ≥ 20 lines,
  in 20 files).** Method unchanged (DL-1222): resolve to upstream's side,
  re-apply Loom's delta for the region from `git diff fa31b66bbb origin/main
  -- <file>` where the surrounding code now sits, then confirm per file that
  every `loom`-bearing line of `origin/main`'s version is present in the
  merged tree or named in a DL row. Files: `ProjectionMaintenance.ts` (§4:
  Loom's guard becomes two clauses in upstream's new passes, the old loop is
  gone), `ws.ts` (hunk 3), `UsageLimitSources.ts`, `cliproxyApi.ts` (§6.4),
  `serverSettings.ts` (Loom's embedder-key redaction inside upstream's
  `shaped`/`withEchoedSecretReferences` block), `builtInDrivers.ts`
  (standing), `ProviderSessionManager.test.ts`, `ProviderRegistry.test.ts`,
  `ThreadSearch.test.ts`, `UsageLimitSources.test.ts`, `serverSettings.test.ts`,
  `textGeneration.test.ts` (Rule T forms), `ChatView.tsx` (hunks 2 and 3:
  upstream's `WorkspaceMutationIdContext` and `<div className="relative">`
  wrappers around Loom's blocks: re-indent, every Loom prop and line kept),
  `Sidebar.tsx` (hunk 2: the `<ul>`), `ThreadRouteView.tsx`, `FilePreviewPanel.tsx`
  (hunk 1: 22 Loom import lines beside one upstream import), `UsagePage.tsx`,
  `MarkdownThreadLink.tsx` (§6.5 (b)), mobile `ThreadNavigationSidebar.tsx`
  and `AdaptiveWorkspaceLayout.tsx`, the three web tests with large sides.
- **Rule T: test prune.** Pull 13 §5.2's five rules. Upstream deleted 4 test
  files, none Loom-edited; 16 conflicted test files carry 25 markers, each a
  Loom case beside an upstream rewrite or a new upstream test. Keep Loom
  cases that guard Loom behaviour and compile on upstream's harness
  (`UsageLimitSources.test.ts` hub login, `cliproxyApi.test.ts` split
  listing, `ProviderSessionManager.test.ts` `.each` failures, `ThreadSettlementService.test.ts`
  LoomStore mock, `ProviderRegistry.test.ts` Fable 5.1 and the retired-test
  notes, `serverSettings.test.ts` allow-list const, `ClaudeCapabilitiesProbe.test.ts`
  imports, `AgentContextBudget.test.ts` stubs, `066_….test.ts`
  `runLoomMigrations`, `commandPermissions.test.ts`, `ChatMarkdown.browser.test.tsx`,
  `markdown-links.test.ts`, `reopenClosedView.test.ts`, `reviewCommentContext.test.ts`,
  `textGeneration.test.ts`); take upstream's new tests beside them; the
  `ThreadSearch.test.ts` hunks (24 + 148 upstream lines of tests over 069's
  index, which Loom's 1065 dropped) keep Loom's two marked notes and drop
  upstream's tests, as pull 14 did (§6.7 of doc 39); S2a may keep the
  `indexed: false` arm of the `each` if it runs green without the table.
- **Rule U: union.** The majority of the 128 content hunks are two unrelated
  edits to the same lines (an import list, a props list, a layer list, a
  settings struct). Both sides, Loom's lines marked. Appendix B says "union"
  where that is the whole resolution.
- **Rule E (new this week): Effect 4.1 renames inside a Loom hunk.** Where
  upstream's side of a hunk shows the 4.1 name (`SecureRandom`, `Digest`,
  `random.uuidV4()`) and Loom's side the 4.0 name in a Loom line, S1 writes
  Loom's line with the 4.1 name (`CheckpointService.ts`, `ProjectSetupScriptRunner.ts`,
  `ThreadSettlementService.test.ts`, `ProviderInstanceRegistryHydration.ts`).
  Loom-only files are S2a's (§5.2).

### 7.2 Server zones

| Area / file | Upstream change | Resolution |
| --- | --- | --- |
| `orchestration-v2/ProjectionMaintenance.ts` (3) | #29806 (§4) | Upstream's file; hunk 1 import union; hunks 2–3 are the old loop against the new passes: take upstream's and add the two marked clauses of §4.3. **Gate 1 reads**; S2a tests |
| `orchestration-v2/Orchestrator.ts` (3) | #20058 snooze with a question, #30325 `freshContext`, #32573 delegated wake | Hunk 1: upstream's (Loom's call superseded, DL row); hunk 2: union; hunk 3: union with `!freshContext &&` outside both arms (§6.2). **Gate 1 reads** |
| `orchestration-v2/ProjectionStore.ts` (3) | `readRows("…")` table reader (hunk 1: Loom's `decodeMessageRows` for the messages row, marked, inside upstream's new reader list), `preview_recording_stop` in the turn-item scan (hunk 2: union with Loom's `attachmentId`), the pending-request ORDER BY (hunk 3, §6.2 union) | Rule D (hunk 1), unions |
| `orchestration-v2/ProviderSessionManager.ts` (2) + test (1) | `lastSessionStatus`, `readLinkedEnvironments` | Unions; test Rule D (§6.1) |
| `orchestration-v2/CheckpointService.ts` (2) | `Digest` replaces `Crypto` | Rule E: Loom's `NodeCrypto` sync-digest import and its off-switch comment stay beside upstream's `Digest` import; Loom's env union reads `Digest.Digest \| … \| LoomStoreV2` |
| `orchestration-v2/ThreadSearch.test.ts` (2), `ThreadSettlementService.test.ts` (1), `UsageLimitRecoveryWorker.ts` (1) | new index tests; `SecureRandom`; `createdBy: "agent"` now upstream's own line | Rule T (drop the index tests); union (Rule E); upstream now writes `createdBy: "agent"` itself, so Loom's marked comment is superseded: take upstream's line (DL row) |
| `cli/config.ts` (1), `cli/server.ts` (1) | `selectAutomaticPort` option and its `AutomaticPort.make` | Union with Loom's `refuseWhenHomeIsLive` (DL-87) |
| `server.ts` (2) | `ProviderUsageAnalytics.layer` replaces `ProviderEventIngestor.layerAnalytics` | Take upstream's line, keep Loom's `ToolOutputImageStore` import and layer (§6.5 (a)) |
| `ws.ts` (4) | `threadStreamEventItem`, the deleted locals, the provider-status stream with `currentCatalogsPerCwd`, `readSettingsClient` on `layerWsRpc` | Hunk 1: Loom's `isLoomDomainEvent` filter then upstream's map; hunk 2: Rule A caveat; hunk 3: Rule D (§6.4); hunk 4: upstream's call with Loom's `Layer.merge(layerLoomWsRpc)` on it. **Gate 1 reads hunk 3** |
| `mcp/McpHttpServer.ts` (1), `OrchestratorMcpService.ts` (1) | `requestUrl` import; `withLegacyUltracodeEffort` import | Unions; `LoomToolkitRegistrationLive` stays in `layerTools` (§5.2) |
| `provider/builtInDrivers.ts` (1), `ProviderInstanceRegistryHydration.ts` (1), `ProviderRegistry.test.ts` (3), `ClaudeCapabilitiesProbe.test.ts` (2), `AgentContextBudget.test.ts` (1), `agentContextBudget.json` (1) | Kiro, `SecureRandom` type import, new codex/claude tests, `NodeCrypto.layer`, new byte counts | Standing Pi-only; Rule E; Rule T; union; §6.9 |
| `persistence/Migrations/066_….test.ts` (1) | `ProjectionReplay` testkit | Union |
| `project/ProjectSetupScriptRunner.ts` (1) | `random.uuidV4()` | Rule E inside Loom's breadcrumb block |
| `serverSettings.ts` (1) + test (1) | secret references shaped per client (`client.secretReferences`), `withEchoedSecretReferences` | Rule D: Loom's embedder-key redaction spread on `shaped`; test union |
| `usage/UsageLimitSources.ts` (3) + test (3), `cliproxyApi.ts` (3) + test (1) | §6.4 | Rule D; **Gate 1 reads** |
| `vcs/GitVcsDriver.ts` (2), `VcsStatusBroadcaster.ts` (1) | `BackgroundGitWork` reference beside Loom's `GitRemoteStatusBatchInput`; `hostEnv` beside Loom's capture-index comment; the poller's `cached?.local` check beside upstream's "turn completion updates divergence" comment | Unions (Loom's repository batch, DL-1614, is otherwise silent this week) |
| `packages/provider-pi/src/server/*` (5) | §6.1 | Unions |
| `packages/contracts/src/*` (2), `packages/client-runtime/src/*` (2), `packages/shared/src/*` (1) | `kiro` in the disabled list; `AuthProvidersManageScope` now upstream's import; `subscribeDynamicWithSession`; `replaceThreadLinks` | As Appendix B |
| config: `AGENTS.md` (3), `pnpm-workspace.yaml` (3), `pnpm-lock.yaml` (17), `apps/server/package.json` (2), `evals/*` (2), `docs/user/composer.md` (2), `.repos/effect/.envrc` (DU) | §6.9 | §6.9's table |

### 7.3 Web and mobile zones

| Area / file | Upstream change | Resolution |
| --- | --- | --- |
| `ChatView.tsx` (3) | limit-recovery snooze; `WorkspaceMutationIdContext`; the composer wrapper | Union; Rule D ×2 (re-indent) |
| `chat/MarkdownThreadLink.tsx` (2), `chat/useComposerMenuItems.ts` (2), `ChatMarkdown.browser.test.tsx` (1) | hosted links, `/clear`, visible shells, `markdownTaskList` | §6.5 (b), §6.2 unions, Rule T |
| `Sidebar.tsx` (2), `ThreadNotificationCoordinator.tsx` (1), `ThreadRouteView.tsx` (1) | inlined working-shelf predicate, the search `<ul>`, hidden threads | §6.5 (a), Rule D, §6.2 unions |
| `files/FilePreviewPanel.tsx` (2), `preview/PreviewView.tsx` (4), `pullRequest/pullRequestDetail.logic.ts` (3), `sidebar/SidebarThreadRow.tsx` (2), `usage/UsageLimitsPooled.tsx` (1), `usage/UsagePage.tsx` (1), `composer-logic.ts` (2), `hooks/useThreadActionMenu.ts` (1), `markdown-links.ts` (1), `state/threads.ts` (1), `terminal-links.ts` (1) | §6.5 (c)–(e) | Unions; `PreviewView.tsx` hunk 4 standing (DL-1214); Appendix D for `composer-logic.ts` |
| `markdown-links.test.ts` (2), `reopenClosedView.test.ts` (2), `reviewCommentContext.test.ts` (2) | new upstream tests beside Loom's | Rule T: both |
| mobile (4) | §6.10 | Unions; Rule A caveat ×2; Rule C |

### 7.4 New upstream directories and files: take verbatim

`apps/server/src/secrets/settingsSecretValue.ts` and the secret-reference
shaping, `apps/server/src/telemetry/ProviderUsageAnalytics.ts`,
`apps/server/src/orchestration-v2/testkit/ProjectionReplay.ts`,
`apps/server/src/persistence/testkit/SqliteRouting.ts`, `packages/provider-kiro/`,
`packages/client-runtime/src/state/threadTagFilter.ts`, `packages/contracts/src/threadTags.ts`,
`apps/web/src/components/chat/{ComposerFreshSession,freshSessionArms}.ts*`,
`apps/web/src/components/composerContextActions.ts`, `packages/shared/src/{keybindingMatching,markdownTaskList}.ts`,
the voice and dictation trees (`apps/*/src/**/voice*`, `evals/voice-cleanup/`,
`evals/pr-content/`), `tsconfig.effect.json`, the mobile `AppBar`/`SheetHeader`
and Nitro highlights modules, the `patches/` additions, and `.repos/effect/`
(all of it except `.envrc`, §5.1).
