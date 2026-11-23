## Appendix D: where a Loom hunk moves this pull

Upstream moved or deleted the code under these Loom hunks. Each row names the
new home; the zone file has the exact lines. A row whose new home is a file
with no conflict marker is the kind that is lost silently: §7.3 assigns each
to a lane. Everything not listed stays in its file (Rule U or in-file Rule D).

### D.1 Into a different file

| Loom hunk (`origin/main`) | Moves to | Why | Who |
| --- | --- | --- | --- |
| `apps/server/src/mcp/toolkits/pullRequests/handlers.ts`: the DL-471 exemption (`thread.workstream === undefined`) inside the watch body | `apps/server/src/pullRequest/PullRequestWatchService.ts` l.120 (trial), on the subagent refusal | #33389/#38926 moved the watch body into a new service; Loom's block is dead code in the `o` hunk (§4.4) | S1 lane 1 |
| `apps/web/src/components/chat/ContextWindowMeter.tsx` (Loom's modified copy) and what it imported from `ContextWindowMeter.logic.ts` | `apps/web/src/loom/ContextWindowMeter.tsx` and a new `apps/web/src/loom/contextWindowMeter.logic.ts`; the setting to `packages/contracts/src/settings.loom.ts`; its switch to `apps/web/src/loom/context-viz/ContextVizSettingsRows.tsx` | #33131 deleted both files and the setting (§6.1; under the §8.1 ruling) | S1 lane 6 (the component), S2b (the rest) |
| `patches/@pierre%2Fdiffs@1.6.1.patch`: Loom's `capturePendingLayoutAnchor()` line | a hunk in upstream's `patches/@pierre__diffs@1.7.0-beta.4.patch` (`dist/components/VirtualizedFileDiff.js`, top of `invalidateEditSessionLayout`) | #33627/#36974 moved to 1.7 with a new patch file (§6.1) | S2b |
| `apps/web/src/components/GitActionsControl.tsx`: the worktree-bound branch-sync guard (45 Loom lines, an `o` hunk) | upstream's new `ThreadGitActionsControl` (target l.~2141), on the effect upstream moved there | #35925/#39305 moved the branch-sync effect (B.10) | S1 lane 5 |
| `apps/server/src/http.ts`: Loom's APK path in the list of signed-URL prefixes kept out of traces | the APK route in `apps/server/src/loom/http/loomAgentRoutes.ts`, as `{ redactedParams: ["*"] }` | upstream dropped the prefix list and redacts route parameters instead (B.4) | S1 lane 1 (both; the route file is Loom-only and assigned in §7.3) |
| `packages/shared/src/usageLimits.ts`: Loom's calls to `formatDuration` and `limitsNotice` | `formatDuration`: a marked private copy in `usageLimits.ts`; `limitsNotice`: upstream's remaining English helper, or Loom's client-facing text in `usageLimitsCopy.ts` | #37893 moved both to the client-only `usageLimitsCopy.ts` with a `resolve` argument (B.7) | S1 lane 2 |
| `apps/mobile/src/features/usage/UsageLimitsPooled.tsx`: Loom's pi colour in the inline colour map | `apps/mobile/src/features/usage/providerColors.ts`, which the Android widget also reads | #34390 replaced the map with `providerColors(scheme)` (B.7) | S1 lane 2 |
| `apps/web/src/components/Sidebar.tsx` hunk 2: `<ThreadContextDragGhost/>` beside Loom's `<GoalFormDialogHost/>` | upstream moved the ghost into `CommandPalette.tsx` (already there); Loom's host goes first inside upstream's new `<SidebarFolderDrop>` | #33990, #35202 (B.11) | S1 lane 5 |
| `apps/web/src/components/chat/modelPickerSearch.ts` and its test (Loom's slug search, DL-180) | `packages/client-runtime/src/modelSearch.ts` and `modelSearch.test.ts`; merged silently with Loom's lines carried | #31207 renamed the file | nobody (verified); Gate 2 reads |
| Mobile `MdxDocumentView.loom.tsx` imports of `components/FilePreviewModal`, `components/VideoPreviewModal` | `components/ui/FilePreviewModal`, `components/ui/VideoPreviewModal` (props unchanged) | #33173 | S2b |

### D.2 Onto a restructured region of the same file (Rule D with a map)

| File | Loom's block | Its place in upstream's new shape |
| --- | --- | --- |
| `apps/web/src/components/ChatMarkdown.tsx` | file chips, thread mentions, in-fence path links, the document-follow open | islands upstream still renders through `CHAT_MARKDOWN_COMPONENTS`: B.9's re-homing map (its §3.3) gives each hunk's new home. `decorateCodeBlock` joins upstream's `pre` destructure; `openDocumentLink(threadRef, path, { line })` replaces the store call inside upstream's rewritten `openAt`; both `threadRef` and `fromThreadRef` are passed to `MarkdownThreadLink` |
| same | the two renderer plugins (`remarkReferenceLinks`, `rehypeChatFilePaths`) | no home: ports in `apps/web/src/markdown/wordsHast.ts` (§6.2), S2b |
| `packages/provider-pi/src/server/adapter.ts` | `loom: input.loom` launch option; the resume sanitiser | into upstream's new `startConnection`; before the spawn as well as before `switch_session` (§6.3) |
| `apps/server/src/orchestration-v2/ProjectionStore.ts` hunks 5 to 7 | the two tool-output-image attachment-id lines | inside upstream's new fork-aware `runAttachmentIds` (§6.8) |
| `apps/server/src/orchestration-v2/Orchestrator.ts` hunk 5 | the `start_if_idle` block | after upstream's `resolveMessageDispatch`, which passes it through |
| `apps/server/src/orchestration-v2/PullRequestWatchReactor.ts` | DL-474's `loomChild` parameter | on upstream's new `endsWithoutRead`; Loom's duplicate definition (trial l.494) deleted |
| `apps/server/src/vcs/VcsStatusBroadcaster.ts` | the repository batch call (DL-1614) | inside upstream's new `refreshRemoteAndLocalTotals` |
| `apps/server/src/usage/cliproxyApi.ts` | login detection, carry-forward, the one-year-token rule | around upstream's `HUB_PROVIDERS` table and `readAccount(hub, account, provider)` (B.7) |
| `apps/server/src/persistence/Sqlite.ts` | `runAllMigrations()` and `cache_size` | upstream's `makeLayerSetup(migrate)`, in both `layerSetup` and `layerCliConfig` |
| `apps/server/src/checkpointing/CheckpointDiffQuery.ts` | the Loom-baseline start of a one-run diff | before `const excludePaths`, passed into upstream's new `patchBetween` as `fromCheckpointRef` |
| `apps/server/src/orchestration-v2/CheckpointService.ts` (silently merged body) | the start-of-run baseline capture | after upstream's "skip after repeated capture timeouts" check in `captureScopeBaseline` |
| `apps/web/src/rightPanelStore.ts` | Loom's tab kinds, seeds and the saved-state decoder arms | upstream's reshaped `open`/`toggle` kind types and normaliser; version 17 (§6.9) |
| `apps/web/src/markdown-links.ts` | `isLinkablePathText` gate, Windows normalising, the `?? text` fallback | inside upstream's memoised `…Uncached` function |
| `apps/web/src/routes/__root.tsx` | Loom's three hosts | inside upstream's new `appHosts` fragment (they then also mount on `/welcome`; harmless) |
| `apps/web/src/routes/_chat.tsx` | `useThreadTabKeyboard(…)` | called with `shownTarget?.kind === "server" && !modalOpen ? shownTarget.threadRef : null` from upstream's new `useShownThreadRouteTarget` |
| `apps/web/src/components/CommandPalette.logic.ts`, `Sidebar.tsx` hunk 1 | uses of `isSidebarHiddenThread`, `resolveSidebarRowThreadId` | `isShownUnderParent`, `resolveListedAncestorThreadRef` from `@t3tools/client-runtime/state/threads` |
| `apps/mobile/src/features/threads/ThreadFeed.tsx` | Loom's relative-path lookup in `onLinkPress` | before upstream's `findFileLinkTarget` in the same function, which runs only when Loom's did not settle the path (§8.1) |
