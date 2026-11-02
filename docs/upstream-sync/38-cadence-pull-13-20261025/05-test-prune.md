## 5. The test prune, and the rule that decides it

### 5.1 What upstream did

#22557 deleted 11k tests (1,895 files), the four "second pass" prunes
(#22588–#22599, ~400 files) and #24058 ("delete low-value tests and dead
test-only exports") followed, and #22187 added a disposable `render` helper
(`apps/web/test/render.tsx`) with a lint rule (`t3code/require-disposable-render`,
error over `apps/web/**/*.test.{ts,tsx}`). Upstream also restored four tests it
had cut by mistake (#23977, #23980, #23991, #24011). Of the 173 conflicted
paths, 80 are files the prune touched; 37 are test files whose Loom side is a
block of tests against an upstream side that is empty or a few lines, and 11
are tests upstream deleted outright after Loom had edited them.

### 5.2 Rule T, test prune

For a conflict hunk in a test file where upstream's side is empty or smaller
and Loom's side holds test code:

1. **No `loom:` line in Loom's side → take upstream's deletion.** These are
   upstream's own tests that git kept on Loom's side only because Loom edited
   something nearby (`GitManager.test.ts` 121 lines, `ProviderSessionManager.test.ts`
   80, `terminal/Manager.test.ts` 479, `VcsStatusBroadcaster.test.ts` 96,
   `WorkspaceFileSystem.test.ts` 75, `composerContextRecords.test.ts` 49/96/87,
   `modelSelection.test.ts` 55, `keybindings.test.ts` 7, `CommandPalette.logic.test.ts`
   18, `CodexProvider.test.ts` 10).
2. **A `loom:` line that marks a Loom fixture adjustment** (a field added so an
   upstream assertion still passes under Loom's defaults; a Loom service stub
   so an upstream layer builds) **goes with the upstream test it fed**: deleted
   with it.
3. **A `loom:` line that marks a Loom assertion is kept only if it guards a
   Loom behaviour nothing else tests.** Behaviours such as (examples, not a
   closed set; DL-1410 lists the further keeps S1 found): hosted
   refusals and the thread-less-scope refusal; the withheld-tool list; the
   Pi-only registry and pi-enabled-by-default; Loom's settings defaults
   (`contextWindowMeterEnabled`, `autoResumeLimitedThreads`, allow-list fields);
   the V1 import boundary; the foreign-home guard; the two-ledger migrator;
   workstream fields on shells; the repository status batch (DL-1221,
   `VcsStatusBroadcaster.test.ts`); verified chips and scanned paths; the
   annotation surviving unmount; the thread-search index; agent-created
   messages in the minimap; the question age; the trailing-window subtree
   activity. A kept Loom test moves into a **Loom-only file** (`<name>.loom.test.ts`
   beside the upstream file, as pull 12's browser re-homings did) when the
   upstream file around it is otherwise gone or thinned to nothing, so the next
   prune cannot delete it again. It stays in place, marked, when the upstream
   file keeps its structure.
4. **A kept test must compile against upstream's exports.** The `lost-ours`
   names (§5.4) were de-exported because their only tests are gone; a kept Loom
   test that imports one re-exports it with a marked line rather than restoring
   the deleted upstream test.
5. **New test lint rules apply to what is kept** (§6.9): a re-homed browser
   test uses `apps/web/test/render.tsx` with `using`/`await using`, no
   `beforeEach`, no module-level screens.

### 5.3 The 11 UD files and the DU, dispositioned

| File upstream deleted (in #22557) | Loom's delta | What it was | Disposition |
| --- | --- | --- | --- |
| `apps/server/src/diagnostics/ProcessResourceMonitor.test.ts` | +154 | `recentProcessTreeActivity` (trailing-window subtree health behind the live-subtree settle blocker), a whole Loom `describe` | **Re-home** as `ProcessResourceMonitor.loom.test.ts` (rule 3); the function it tests is Loom's |
| `apps/server/src/orchestration-v2/V1ImportBoundary.test.ts` | +10 | Loom's exemption list (DL-179, DL-513, DL-1320's `threadSearchIndex.loom.ts`, 1054) on upstream's boundary test | **Keep as a Loom-only file** `V1ImportBoundary.loom.test.ts` with upstream's last body + Loom's list: it is the mechanism that stops new Loom code naming V1 tables, which pull 12 relied on twice. S2a moves it; DL row |
| `apps/web/src/components/chat/timelineMinimapItems.test.ts` | +18 | "skips agent-created messages and spans the human turn past them" | **Re-home** as `timelineMinimapItems.loom.test.ts` (rule 3) |
| `apps/server/src/mcp/toolkits/worktree/registration.test.ts` | +2 | `loomToolkitServiceStubs()` so upstream's layer built | Delete (rule 2) |
| `apps/web/src/components/ChatMarkdown.assets.browser.test.tsx` | +7/−1 | `__setMetadataFetcherForTests(null)` so the click-time chip verify opened | Delete (rule 2); `verifiedFileChips.browser.test.tsx` and `ChatMarkdown.browser.test.tsx`'s marked block still cover the chip verify |
| `apps/web/src/components/RightPanelTabs.keyboard.browser.test.tsx` | +4/−1 | reveal fields in a fixture | Delete (rule 2) |
| `apps/web/src/components/chat/ComposerPendingUserInputPanel.permissions.browser.test.tsx` | +13 | `vi.mock` of `pendingUserInputLoom` (question age timer) and a 3d-4 successor question | Delete (rule 2); the 3d-4 auto-advance rule is Loom's and is tested in `pendingUserInputLoom`'s own tests (S2b confirms; else re-home that one case) |
| `apps/web/src/components/pullRequest/PullRequestDetailPanel.browser.test.tsx` | +1 | `kind: "line"` on a review-comment fixture (DL-1272) | Delete (rule 2) |
| `apps/web/src/components/settings/ProviderInstanceCard.browser.test.tsx` | +5 | allow-list props on a fixture (DL-1216/DL-1272) | Delete (rule 2); `ProviderSettingsPanel.environment.browser.test.tsx` (conflicted, kept) still asserts the allow-list fields |
| `apps/web/src/components/settings/SettingsPanels.restore.browser.test.tsx` | +3/−2 | flipped `autoResumeLimitedThreads` so upstream's restore test matched Loom's default | Delete (rule 2); `contracts/settings.test.ts` keeps the default assertion |
| `apps/mobile/src/features/threads/QuestionAnswerHistory.test.tsx` | +6/−2 | fixture | Delete (rule 2) |
| `apps/server/src/orchestration-v2/ThreadSearch.test.ts` (DU) | Loom deleted it | upstream rewrote it for the trigram index | **Take upstream's** (§4.2); it tests upstream's `make`, which the recommended layer still constructs |

### 5.4 The `lost-ours` list and the two live consumers

`automerged.py` flags 24 silently merged files that lost an exported name from
Loom's side (32 names). Every one is an **upstream de-export** (#24058: the
name is still defined and used internally upstream, only `export` was removed)
or an upstream deletion, and every consumer on Loom's side was a test upstream
deleted in the same change, now gone from the merged tree: `isPreviewRefreshShortcut`,
`recordingFileExtension`, `make` (SessionStore), `prLookupFailureTtl`,
`layerEnvironmentToolkit`, `normalizeMcpHttpResponse`, `isNonRetryableProviderTurnControlFailure`,
`existingThreadIdsForCommand`, `shouldPublishAgentAwarenessEvent`, `LEGACY_SCAN_CACHE_FILE_NAME`,
`CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES`, `appendVersionMismatchHint`,
`shouldOpenDefaultBrowserProfileFromMenuClick`, `tabMuteMenuItem`, `resolveTimelineToolPresentation`,
`adjacentModelPickerProvider`, `shouldIncludeModelPickerOption`, `shouldOfferModelPickerSetup`,
`buildModelPickerSearchText`, `rankPullRequestsBlockedOnReviewer`, `providerEnvironmentWithoutNames`,
`readProviderEnvironmentVariable`, `groupModelsForDisplay`, `nextHiddenModelsForBulkToggle`,
`SidebarUtilityMenu`, `buildPatchCacheKey`, `MAX_KEYBINDING_VALUE_LENGTH`, `formatComposerContextProviderMarker`,
`getProviderOptionBooleanSelectionValue`, `getProviderOptionStringSelectionValue`, `resolveKnownWindowsCliDirs`,
`providersWithLimits`. **No Loom-only consumer exists for any of them** (checked
by name across `apps`, `packages`, `scripts` on `origin/main` and in the trial
tree). Two conflicted Loom-kept tests still reference one:
`ClaudeCapabilitiesProbe.test.ts` (`CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES`,
inside the Loom-side region of a dormant-driver test: Rule T rule 1 deletes
the region, so no re-export) and `versionSkew.test.ts` (`appendVersionMismatchHint`,
same: the region is upstream's test, deleted).

Beyond that list, an import check over every Loom-only file (1,116 files; relative, `~/` and
`@t3tools/*` specifiers resolved against the trial tree, named imports checked
against the target's exports) finds exactly three breaks:

| Loom file | Missing | Fix (S2a / S2b) |
| --- | --- | --- |
| `apps/server/src/persistence/LoomMigrations.test.ts`, `LoomMigrations.v1copy.test.ts` | `migrationEntries` from `Migrations.ts` | `Migrations.ts` stays verbatim. The tests use upstream's exported `migrationManifest` for names and `runMigrations({ toMigrationInclusive })` for the capped upstream lane; the synthetic historical ledger imports the migration modules it needs (`./Migrations/0NN_*.ts` default exports) directly |
| `apps/web/src/loom/ModelChangeDivider.tsx` | `getProviderInstanceEntry` from `~/providerInstances` | one marked `export` line restored in `providerInstances.ts`, or the divider reads the exported sibling that wraps it (S2b picks; DL row) |

### 5.5 Loom's browser tests under the new helper and lint rule

Loom has **one** Loom-only browser test, `apps/web/src/loom/verifiedFileChips.browser.test.tsx`,
plus marked blocks inside upstream browser tests that survive the prune
(`ChatMarkdown.browser.test.tsx` 216 Loom-side lines, `ChatMarkdown.permissions.browser.test.tsx`,
`PreviewView.browser.test.tsx` 82, `ProviderSettingsPanel.environment.browser.test.tsx` 98 + 92,
`ReopenClosedViewShortcut.browser.test.tsx`). Upstream rewrote every surviving
browser test onto `apps/web/test/render.tsx` (#22187: `await using screen = await render(...)`,
`using` for spies, no lifecycle hooks, no module-level screens) and
`t3code/require-disposable-render` is an error over all `apps/web` tests. S2b
ports the Loom blocks onto the helper as it re-applies them; the ported
upstream files around them show the idiom. Size: small (six files).
