## Appendix B.10: web panels: files, diff, right panel, preview, PR detail (19 files, 70 markers, 275 `loom:` lines) · lane 5 web panels and sidebar

Read with §7 (the rules), §8 (the rulings) and the cross-lane table in §7.3. Written from a read of both sides of every hunk in the trial merge; "trial" line numbers are lines of the mid-merge file and move as hunks resolve. A row marked for Gate 1 is on the Gate 1 reviewer's list (§7.5).

**Decision labels used below.** "D1" is §8.1 "Diff changed-word highlight strength"; "D2" (files tree folder memory) is carried in §8.2.

**Other zones are named by their research key:** `toolchain-config` = B.1 · `orchestration-delegation` = B.2 · `store-shell` = B.3 · `remote-auth-deploy` = B.4 · `mcp-tools` = B.5 · `pi-adapter` = B.6 · `textgen-usage` = B.7 · `multirepo-vcs` = B.8 · `markdown-chat` = B.9 · `web-panels-files-diff` = B.10 · `web-sidebar-shell` = B.11 · `labs-settings` = B.12 · `mobile-client` = B.13 · `i18n` = §5.1 · `migrations` = §5.5 · `overlap-audit` = Appendix C · `upstream-digest` = §6.13 and §0.

**Section numbers inside the text below** are this zone's research notes, not the runbook: "section 3" or "§3.x" is the per-hunk doctrine in this file, "section 4" the silently merged list, "section 5" the list for S2; "section 2" (decisions) is mapped to §8.1 above, "section 6" (deploy) is folded into For deploy, "section 7" into §0, "section 8" (follow-ups) into §8.3, and "section 9" (commands) into Appendix A.

### Paths in this zone

- `apps/web/src/components/DiffPanel.tsx` · 13m · 37L · [8/3c] [3/0o] [1/1c] [1/1c] [13/17c] [13/12c] [4/2c] [4/5c] [7/15c] [45/42c] [12/8c] [2/1c] [9/1c]
- `apps/web/src/components/GitActionsControl.tsx` · 1m · 1L · [45/0o]
- `apps/web/src/components/RightPanelTabs.tsx` · 3m · 23L · [2/2c] [4/2c] [5/4c]
- `apps/web/src/components/diffs/AnnotatableCodeView.tsx` · 4m · 20L · [2/1c] [16/1c] [3/1c] [1/2c]
- `apps/web/src/components/diffs/useCodeViewFileReveal.ts` · 3m · 3L · [1/6c] [11/82c] [2/1c]
- `apps/web/src/components/files/FileBrowserPanel.tsx` · 8m · 21L · [2/3c] [9/2c] [5/1c] [3/1c] [2/2c] [2/4c] [1/1c] [11/15c]
- `apps/web/src/components/files/FilePreviewPanel.tsx` · 14m · 66L · [1/9c] [26/1c] [10/27c] [13/38c] [1/1c] [1/1c] [14/17c] [1/7c] [29/21c] [6/1c] [14/68c] [1/4c] [1/1c] [37/32c]
- `apps/web/src/components/files/filePreviewMode.ts` · 1m · 1L · [4/4c]
- `apps/web/src/components/preview/PreviewView.tsx` · 2m · 7L · [0/2B] [2/1c]
- `apps/web/src/components/pullRequest/pullRequestDetail.logic.test.ts` · 2m · 4L · [2/1c] [6/31c]
- `apps/web/src/components/pullRequest/pullRequestDetail.logic.ts` · 1m · 5L · [5/4c]
- `apps/web/src/index.css` · 1m · 28L · [136/0o]
- `apps/web/src/lib/composerContextRecords.ts` · 1m · 7L · [2/6c]
- `apps/web/src/lib/diffRendering.ts` · 3m · 1L · [17/25c] [0/6B] [0/4B]
- `apps/web/src/markdown-links.ts` · 2m · 7L · [4/18c] [8/12c]
- `apps/web/src/reviewCommentContext.test.ts` · 1m · 1L · [1/1c]
- `apps/web/src/rightPanelStore.ts` · 7m · 34L · [2/0o] [4/12c] [1/7c] [2/6c] [8/10c] [4/6c] [1/14c]
- `apps/web/src/terminal-links.ts` · 2m · 4L · [4/4c] [3/2c]
- `apps/web/vite.config.ts` · 1m · 5L · [7/0o]

### Per-hunk doctrine

Shapes are `[Loom lines / upstream lines kind]`. "G1" = Gate 1 reviewer must read.

#### `apps/web/src/components/files/FilePreviewPanel.tsx` (14 markers)

| # | Shape | Upstream PR | Loom side | Rule | Resolution | G1 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1/9c | #39736 `useEffectEvent`, #30738 `KeyboardEvent` | `type ReactNode` for BleedFrame (#178) | U | Upstream's multi-line react import plus `type ReactNode`, line marked `// loom: ReactNode (BleedFrame)` | no |
| 2 | 26/1c | #27866 moved `setMarkdownTaskChecked` to `@t3tools/shared/markdownTaskEdits` | Loom imports: long-line preview (#277), MDX annotation layer and author line (#575, #582), remembered scroll (#500, #590), change review (#427, #583) | U (Rule E shape) | Upstream's `markdownTaskEdits` import line, then Loom's 25 import lines unchanged | no |
| 3 | 10/27c | #39736 `HtmlPreviewFrame`, grant renewal constants | `RevisionImage` (#508, image half) | U | Keep both: Loom's `RevisionImage` (images still reload per command upstream) then upstream's frame block | no |
| 4 | 13/38c | #39736 HTML preview keeps its URL until the file's revision changes, renews the grant before expiry | Loom #508's HTML half: `useWorkspaceMutationRefresh` + `refreshAssetUrl`, revision from `fileRevision ?? workspaceMutationId` | **Superseded** | Take upstream's side whole; Loom's two `loom:` comment lines dropped (DL row: superseded by #39736). Loom's image preview above keeps its own copy of the pattern | **yes** |
| 5 | 1/1c | #34360/#35122 `onEditorChange` | `rememberScroll` prop (#500) | U | Both props in `EditableFileSurfaceProps` | no |
| 6 | 1/1c | same | `rememberScroll` destructure | U | Both | no |
| 7 | 14/17c | #30738 `selectRenderedContentOnSelectAll` | `BleedFrame` (#178) | U | Both functions | no |
| 8 | 1/7c | #34360 adds `composerDraftTarget`, `onEditorChange` to the `Omit` | Base's line (Loom did not change it) | B | Upstream's list | no |
| 9 | 29/21c | #30738 `onKeyDown` on the markdown `ScrollArea`; one-line `setMarkdownTaskChecked` call | remembered scroll `ref` on the `ScrollArea` and `<BleedFrame>` wrapper | D (re-indent) | `<ScrollArea className="min-h-0 flex-1" ref={(root) => rememberScroll(scrollAreaViewport(root))} onKeyDown={selectRenderedContentOnSelectAll}>` then `<BleedFrame>` around upstream's `<FileMarkdownPreview .../>`; keep both `loom:` comments | no |
| 10 | 6/1c | #37893 `useFilesystemReadAccess(environmentId, m)` | `isMdx` and the 8 MB `.mdx` read budget (#109) | U | Loom's five lines, then upstream's call with `m` | no |
| 11 | 14/68c | #34769 copy button (`copyableContents`), #34360/#35122 editor focus helpers, `mayOpenEditor` | read-cap and long-line notices `previewNotices` (#277) | U | Loom's block, then upstream's block | no |
| 12 | 1/4c | #37893 wraps the 1 MB notice in `gt()` plural | `previewNotices.join(" ")` (8 MB / long-line notices) | i18n wrap only on upstream's side | Keep Loom's line: it covers upstream's 1 MB case and Loom's 8 MB and long-line cases. The 1 MB notice stays English (i18n owner's rule decides whether Loom's strings get wrapped) | no |
| 13 | 1/1c | #34360 `onEditorChange={handleEditorChangeStable}` | `rememberScroll={scrollRefFor("source")}` | U | Both props | no |
| 14 | 37/32c | #34360 `<div className="contents" onClick onKeyDown>` wrapper that focuses the editor from the tree; #34346 `answersPanelFind={!previewPath}` | `loomExpansionKey` (#432), `revealPath`/`revealRequestId` directory reveal (#91), `loomMarks`/`loomReviewBar` (#427) | D (re-indent) | Upstream's wrapper and props; inside `<FileBrowserPanel>` add Loom's `loomExpansionKey`, `revealPath`, `revealRequestId` and the `loomMarks` spread with their `loom:` comments | yes |

Trap: hunk 4 is an upstream re-implementation of a Loom fix, not a union. Its server half lives in `apps/server/src/assets/AssetAccess.ts` (owner `multirepo-vcs`): upstream returns `fileRevision: undefined` for every non-HTML workspace file, while Loom #508 returned one for all of them. If that file takes upstream's branch as written, **Loom's image and PDF previews go back to reloading after every agent command**. Tell the AssetAccess owner to keep Loom's `openMediaFile` revision on the non-HTML branch (marked).

#### `apps/web/src/components/DiffPanel.tsx` (13 markers)

| # | Shape | Upstream PR | Loom side | Rule | Resolution | G1 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 8/3c | #32697 `diffPathRepositoryRoot` | change review `useLoomReviewSelection` (#427) | U | Loom's block then upstream's line | no |
| 2 | 3/0o | #35925 moved `const latestTurn` up to line ~365 | `latestTurn` (base line) + `loomTurnsWithFiles` (#427) | A caveat | Drop Loom's `latestTurn` line (now declared above; a duplicate fails to compile); keep `loomTurnsWithFiles`, rewritten as `summary.files.length > 0 \|\| (summary.repositories?.length ?? 0) > 0` so a turn that changed only a tracked repository still shows (upstream's `ThreadCheckpointSummary.files` is the thread folder's own files only) | yes |
| 3 | 1/1c | #35925 `gitCwd` | `!loomReview` | U | `canReadFiles && isGitSelection && !loomReview && activeThread && gitCwd`, marked | no |
| 4 | 1/1c | #40215 splits the query into `branchDiffPreviewAtom` + `useEnvironmentQuery(atom, messages)` | `upstreamBranchDiffPreview` rename so Loom's interval query can stand in | D | Take upstream's atom line; rename upstream's line ~516 to `const upstreamBranchDiffPreview = useEnvironmentQuery(branchDiffPreviewAtom, messages); // loom: change review`; keep Loom's auto-merged `const branchDiffPreview = loomReview?.query ?? upstreamBranchDiffPreview;` (trial line 530). Without the rename the trial has two `const branchDiffPreview` | yes |
| 5 | 13/17c | #35925 `comparisonHeadRef` per repository, #37893 `gt("Automatic")` | `loomReview ? loomReview.source :` | U | Loom's ternary head on upstream's `find`; upstream's two `comparison*Ref` blocks | no |
| 6 | 13/12c | #37893 `gt()` labels, `selectedTurnLabel` | `loomReview ? loomReview.label :` | U (i18n wrap) | Upstream's lines with Loom's `loomReview` arm prefixed, marked | no |
| 7 | 4/2c | #35925 `commitLinkIdentity` | `useOpenLink(routedThreadRef)` (review follow, #583) | U | Upstream's `selectedCommitUrl`; Loom's `openLink` line | no |
| 8 | 4/5c | #32684/#35925 repository-aware `openDiffFilePrimaryAction` args | `threadRef: routedThreadRef` (#583) | D | Upstream's four lines with `routeThreadRef` replaced by `routedThreadRef` in the `threadRef` ternary, marked `// loom: the main window's thread` | yes |
| 9 | 7/15c | #35925 `selectRepository` | `selectedScopeValue` with Loom's `loomReview` arm (diff3 misalignment) | U | Loom's whole `selectedScopeValue` ternary, then upstream's `selectRepository` | no |
| 10 | 45/42c | #35925 `turnDiffsOnly ? null : (...)` around Commits; #37893 `<T>`; `formatRelativeTimeLabel(..., messages)` | `LoomScopeMenuEntries` (#427) above base's Commits submenu | U | Loom's three lines, then upstream's block. Suggest `routeThreadRef && !turnDiffsOnly` on Loom's entries: in a plain-folder project the interval query is disabled anyway | yes |
| 11 | 12/8c | #32684 `workspaceRoot={activeCwd}` | fragment with `LoomOpenWholeFileButton` (#427) and `AuthorshipFileChips` (#582) | U | Loom's fragment; add upstream's `workspaceRoot` prop to `DiffFileHeaderSuffix` | no |
| 12 | 2/1c | #33627/#36974: 1.7 built-in find; `onRevealSearchMatch` deleted, `onFileCollapsedChange` added | `onRevealSearchMatch={unfoldDiffFile}` (base) + `authorCard` (#582) | A caveat | Drop `onRevealSearchMatch` (its prop and `unfoldDiffFile` are gone upstream; the trial already lost `unfoldDiffFile`); keep `authorCard` and upstream's `onFileCollapsedChange` | no |
| 13 | 9/1c | #35090 `onPostRender: flushCodeView` (scroll restore + reveal) | author stamping on rendered rows (#582) calling `codeViewReveal.flush()` | D | `onPostRender: (node, _instance, phase, context) => { flushCodeView(); loomAuthors.onPostRender(node, phase, context.type === "diff" ? context.item.fileDiff : undefined); }` (the 4-argument context form exists in 1.7, `CodeView.d.ts:130-131`) | yes |

#### `apps/web/src/components/files/FileBrowserPanel.tsx` (8 markers)

| # | Shape | Upstream PR | Loom side | Rule | Resolution | G1 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 2/3c | #33985 icons from `lucide-react`, #37893 `gt-react`, #39470 `useEffectEvent`, `Ref` | `ReactNode` for the review bar | U | Upstream's three lines; `type ReactNode` added to the react import, marked. Loom's `lucide` line is base's and goes | no |
| 2 | 9/2c | #34346 `isMacPlatform`, `previewActionBus` | change marks tree imports (#427), `useLoomTreeExpansion` (#432) | U | Both | no |
| 3 | 5/1c | #34346 `answersPanelFind?` | `loomMarks`, `loomReviewBar`, `loomExpansionKey` props | U | Both | no |
| 4 | 3/1c | same | defaults | U | Both | no |
| 5 | 2/2c | #37893 `gt("Loading…")` | `loomFolderChangeDecoration` (#427) | U (i18n wrap) | Upstream's loading arm, Loom's `: loomFolderChangeDecoration(...)` | no |
| 6 | 2/4c | #39470 `loadExpanded = coalesceReentrantCalls(() => {`, `let changed` | `\|\| loomChangedOnly` early return | D | Upstream's lines; `if (model.isSearchOpen() \|\| loomChangedOnly) return; // loom: no listing under Changed only` | no |
| 7 | 1/1c | #35067/#39470 deps `expansionRoot`, `pendingExpandedPaths` | dep `loomChangedOnly` | U | `[directoryPaths, expansionRoot, load, loomChangedOnly, model, pendingExpandedPaths]` | no |
| 8 | 11/15c | #29996 `shouldRebuildFileTree` / `resetPaths`, #39470 `followedRevealRef` | dep `loomChangedOnly`, then `useLoomTreeExpansion(...)` | D | Upstream's body; deps `[ready, entryKinds, loomChangedOnly, model, treePaths]`; Loom's `useLoomTreeExpansion` call after the effect. Note `resetPaths` re-creates items, so Loom's per-thread choices are re-applied by its own effect (its deps include `directoryPaths`); S4 check under D2 | yes |

#### `apps/web/src/rightPanelStore.ts` (7 markers): Rule D on the kind types and the decoder

| # | Shape | Upstream PR | Loom side | Rule | Resolution | G1 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 2/0o | #19260 (v15, issues) and #39515 (v16, `side-chat` becomes `thread`, `linked-thread`) | comment: Loom took v15 (graph to workstream, DL-800) and v16 (artefact tab retired) | D | **Set `RIGHT_PANEL_STORAGE_VERSION = 17`** and rewrite Loom's comment: "loom: Loom's v15/v16 (graph to workstream, retired artifact) and upstream's v15/v16 (issue, thread) share the key; 17 runs the merged normaliser once over state saved by either". Section 6 says why | **yes** |
| 2 | 4/12c | #39515 `open` kind = `Exclude<RightPanelKind, "file" \| "terminal" \| "pull-request" \| "issue" \| "thread" \| "linked-thread">`; `openSideChat` replaced by `openThread`, `openLinkedThread`, `setLinkedThreadTitle` | `open: (ref, kind: SingletonSurfaceKind \| "preview")` (3d-2), base's `openSideChat`, Loom's `seedWorkstream` | D | Upstream's block with `open` typed `SingletonSurfaceKind \| "preview"` (marked); drop `openSideChat` (host deleted upstream; all callers are upstream files that #39515 moved to `openThread`); keep `seedWorkstream` and its doc line | yes |
| 3 | 1/7c | same for `toggle` | `SingletonSurfaceKind \| "preview"` | D | `toggle: (ref, kind: SingletonSurfaceKind \| "preview") => void; // loom` | no |
| 4 | 2/6c | same exclusion list on `singletonSurface` | `singletonSurface(kind: SingletonSurfaceKind)` | D | Keep Loom's signature, and **edit the auto-merged `SingletonSurfaceKind`** (trial line ~392) to `Exclude<RightPanelKind, "file" \| "dir" \| "preview" \| "terminal" \| "pull-request" \| "issue" \| "thread" \| "linked-thread">` (drop `"side-chat"`, which no longer exists). Upstream added no singleton kind, so the `switch` needs no new case | yes |
| 5 | 8/10c | #39515/#39406 decoder: `thread`/`side-chat` through `decodeThreadSurface`, unknown kinds dropped, `linked-thread` decoded | `artifact` dropped, `graph` becomes `workstream`, unknown kinds dropped | D | Upstream's block; insert Loom's `graph` to `workstream` conversion (3 lines, marked) before upstream's unknown-kind check. Loom's `artifact` line and its own unknown-kind line are superseded by upstream's check (DL row). Base's `plan \|\| agents` line goes (upstream deleted it; its check covers them) | **yes** |
| 6 | 4/6c | #39515 `side-chat:` active id becomes `thread:` | `graph` active id becomes `workstream` | U | `const savedActiveSurfaceId = validThreadState?.activeSurfaceId === "graph" ? "workstream" : validThreadState?.activeSurfaceId; // loom` then upstream's `rawActiveSurfaceId` | yes |
| 7 | 1/14c | #33989 `settlePullRequestReveal` | comment above Loom's openers | U | Upstream's function, then Loom's comment line | no |

Re-homing map: none of Loom's openers lost a host. `openFileAbsolute`, `openDirectory`, `followDocumentToAuthor`, `snapshotRightPanel`, `restoreRightPanel`, `upsertFileSurface`, `seedWorkstream` are all present in the trial file (counted). Seed-not-override holds: `seedWorkstream` still goes through `automaticUpdate`, which upstream kept unchanged (`automaticUpdate` at a09738fb43 line 502 does not touch `userActionRevisionByThreadKey`).

#### `apps/web/src/components/diffs/AnnotatableCodeView.tsx` (4 markers)

| # | Shape | Upstream PR | Loom side | Rule | Resolution | G1 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 2/1c | #35090 `CodeViewProps` type | `EditProvider`, `Editor`, `EditorFocusOptions` (#590) | U | `import { EditProvider, type CodeViewHandle, type CodeViewProps } from "@pierre/diffs/react"; // loom: inline diff editing` and Loom's `@pierre/diffs/edit` line | no |
| 2 | 16/1c | #33627 `onRevealSearchMatch` replaced by `onFileCollapsedChange` | base's `onRevealSearchMatch`, `authorCard` (#582), `loomEdit` (#590) | A caveat + U | Upstream's `onFileCollapsedChange`; Loom's `authorCard` and `loomEdit` props; drop `onRevealSearchMatch` | yes |
| 3 | 3/1c | same | destructure | same | Same as 2 | no |
| 4 | 1/2c | #33627 `onItemCollapsedChange` option | `onLineSelectionEnd: beginComment` (#582) | U | Both | no |

The trial already dropped base's `onRevealSearchMatch={(item) => ...}` prop on `StyledDiffCodeView` (upstream deleted it). **Host deleted**: the Loom-only `apps/web/src/loom/review/FileChangeView.tsx:682` still passes `onRevealSearchMatch={() => undefined}`; change it to `onFileCollapsedChange={() => undefined}` (outside any marker, typecheck catches it).

#### `apps/web/src/components/diffs/useCodeViewFileReveal.ts` (3 markers): Superseded

| # | Shape | Upstream PR | Loom side | Rule | Resolution | G1 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1/6c | #33989 | `SelectedLineRange` import (#581) | Superseded | Upstream's | no |
| 2 | 11/82c | #33989 `pending` carries an optional `range`, centres it, expands partial diffs, settles once | `pendingRange` and a centred `range` scroll (#581/#582) | Superseded | Upstream's | yes (light) |
| 3 | 2/1c | #33989 `request(fileKey, range?)` | same signature | Superseded | Upstream's | no |

Take upstream's file whole; Loom's three `loom:` lines are dropped with a DL row ("diff author query reveal superseded by #33989"). Loom's callers (`useAuthorCardSlot({ revealLines: codeViewReveal.request })` in `DiffPanel.tsx`) are signature-compatible.

#### `apps/web/src/lib/diffRendering.ts` (3 markers)

| # | Shape | Upstream PR | Loom side | Rule | Resolution | G1 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 17/25c | #35304 `buildFileDiffEntries` | `WORD_DIFF_EMPHASIS_UNSAFE_CSS` on `:host` (#307) and its prefix on `DIFF_SURFACE_THEME_UNSAFE_CSS` | U + D1 | Keep upstream's `buildFileDiffEntries`. Under D1 (a): delete Loom's constant and prefix | yes |
| 2 | 0/6B | #28947 `--diffs-bg-addition-emphasis` declared directly on the diff elements | (none) | B, but it silently overrides Loom's `:host` value | Under D1 (a): upstream's declaration with Loom's value `light-dark(color-mix(in srgb, var(--code-background) 55%, var(--diff-addition)), color-mix(in srgb, var(--code-background) 45%, var(--diff-addition)))`, marked `loom:`. Under (b): upstream's | yes |
| 3 | 0/4B | same for deletion | (none) | same | Same with `--diff-deletion` | yes |

#### Smaller files

| Path | Shapes | Upstream PR | Loom side | Rule | Resolution | G1 |
| --- | --- | --- | --- | --- | --- | --- |
| `apps/web/src/components/RightPanelTabs.tsx` | [2/2c] [4/2c] [5/4c] | #37893 `terminalLabelsCopy`, #39515 `formatSubagentDisplayTitle`, `Bot`/`CircleDotIcon`, #38282 "Linked items", #19260 `issue` case | `LoomSurfaceAction` import; `FolderOpen`/`ListTodo`/`Network`/`Layers` icons; `workstream`/`context` titles (3d-2, context-viz) | U | Union all three: upstream's import lines plus Loom's type import; both icon sets; upstream's `return resolve(msg("Linked items"))` and `issue` case plus Loom's two cases | no |
| `apps/web/src/components/GitActionsControl.tsx` | [45/0o] | #35925/#39305 moved the branch-sync effect into the new `ThreadGitActionsControl` (a09738fb43 line ~2141) with `isProjectCloning` | worktree-bound branch sync for server threads (pull-15 clean-overlap row 35; origin `7005bb89ce`) | **A caveat, D** | Delete the 45 lines at the old site. In `ThreadGitActionsControl`'s effect: drop `activeServerThread` from the early return, add Loom's guard block (`if (activeServerThread) { if (activeServerThread.worktreePath === null \|\| activeServerThread.worktreePath !== gitCwd) return; } else if (activeDraftThread?.worktreePath != null && activeDraftThread.worktreePath !== gitCwd) return;`) with its `loom:` comment, keep `isProjectCloning`, add `activeDraftThread?.worktreePath` and `gitCwd` to the deps. `gitStatus` is upstream's name for `gitStatusForActions` there | **yes** |
| `apps/web/src/components/files/filePreviewMode.ts` | [4/4c] | #37893 `resolve` param | `isMdxPreviewFile` (#3) | U (i18n wrap) | Loom's export, then upstream's signature | no |
| `apps/web/src/components/preview/PreviewView.tsx` | [0/2B] [2/1c] | #22960/#34796 in-page find state | per-tab pick (DL-1214, DL-1817) | B (DL-1203 form) + U | Hunk 1: take only `const [find, setFind] = ...`; **not** `const [pickActive, setPickActive]` (a base line Loom deleted; taking it redeclares `pickActive`). Hunk 2: Loom's two lines plus upstream's `if (find !== null && find.tabId !== runtimeTabId) setFind(null);` | yes (standing) |
| `apps/web/src/components/pullRequest/pullRequestDetail.logic.ts` | [5/4c] | #37893 `msg`, `m`, `MessageResolver` | `LineReviewCommentContext` type (kind union) | U | Upstream's three import lines; Loom's multi-line import with `type LineReviewCommentContext` | no |
| `apps/web/src/components/pullRequest/pullRequestDetail.logic.test.ts` | [2/1c] [6/31c] | #38276/#35300 new cases | `kind: "line" as const` | T | Hunk 1: `const selection = (id: string, line = 12) => ({ kind: "line" as const, // loom ...`. Hunk 2: upstream's test, with Loom's guard in both maps: `comment.kind === "line" ? comment.pullRequest?.url : undefined` and `.filter((comment) => comment.kind === "line" && comment.diff !== "")` | no |
| `apps/web/src/lib/composerContextRecords.ts` | [2/6c] | #37893 `resolve?` param | `commentPullRequest(comment)?.url` (kind union) | U | Upstream's signature, Loom's body line | no |
| `apps/web/src/markdown-links.ts` | [4/18c] [8/12c] | #27866 memoised `resolveInlineCodeFileLinkMeta` over `...Uncached` | `isLinkablePathText` gate, Windows normalising, `?? text` fallback (Loom path chips) | **D** | Take upstream's `memoized` cache and wrapper. Move Loom's body (trim, normalise, `isLinkablePathText`, extensionless arm, `inlineCodeFilePathCandidate(text) ?? text`) into `resolveInlineCodeFileLinkMetaUncached(rawText, cwd, baseDir)`, ending in upstream's `resolveMarkdownFileLinkMeta(...)` return. Loom's doc comment goes on the uncached function. The result is pure, so memoising it is safe | yes |
| `apps/web/src/terminal-links.ts` | [4/4c] [3/2c] | #37071/#36174 new `FILE_PATH_PATTERN` (bare `name.ext` with a position or TS location); #34397 `const output` | `export` for `loom/chatPathScan.ts` | D (export on upstream's text) | Upstream's comments and regex with `export const FILE_PATH_PATTERN = // loom: exported for chatPathScan.ts`; upstream's `trimClosingDelimiters` body with `export` and Loom's comment | no |
| `apps/web/src/reviewCommentContext.test.ts` | [1/1c] | #35300 `diffReviewSelectionId` | `formatReviewCommentContext` (Loom export, present in the trial) | T | Import both | no |
| `apps/web/src/index.css` | [136/0o] | #27866 deleted `.chat-markdown-math-display .katex-display { margin: 0; }` | wide-block bleed rules (#68, #178, user-bubble bleed) | **A caveat** | Keep Loom's 133 lines; drop the last three (the KaTeX rule upstream deleted; Words renders math without `.katex-display`) | no |
| `apps/web/vite.config.ts` | [7/0o] | #29051 deleted the `@betteroffice/fonts-cjk` alias (the file `fonts-cjk.ts` is gone upstream) | `decode-named-character-reference` alias for the `.mdx` worker | **A caveat** | `alias: { "decode-named-character-reference": decodeNamedCharacterReferenceNode, // loom: .mdx worker }` only; drop the fonts-cjk alias | no |

`index.css` selector check: every class Loom's index.css delta names is still emitted by a component in the trial tree, except `wf-*`, `plan-badge--*`, `pele-*`, which are built from template strings and equally absent from a literal grep at HEAD (no change). `.chat-markdown-table-container` is still emitted by upstream's Words renderer (`apps/web/src/markdown/wordsHast.ts:823`, `MarkdownTable.tsx`), `.chat-user-bubble` by `TimelineUserMessageRow.tsx`, and `--timeline-available-width` is still published by `MessagesTimeline.tsx` (trial line 1116) and Loom's `BleedFrame`.

### Silently merged files Gate 2 reads in this zone

| File | Why |
| --- | --- |
| `apps/web/src/components/files/AttachmentFilePreview.browser.test.tsx` | Line 1664 is a Loom-marked assertion of Loom's HTML re-mint (#508), which hunk 4 above replaces with #39736. Rule T: take upstream's version of that case (#39736 rewrote it) and drop Loom's line |
| `apps/web/src/components/files/projectFilesQueryState.ts` | Loom's `maxBytes` parameter sits before upstream's new `resolve` parameter. Checked: all trial callers pass it in Loom's order (`useT3ProjectFileScripts.ts:27`, `FilePreviewPanel.tsx:1587`); upstream's new tests call with three arguments. Fine, but read |
| `apps/web/src/reviewCommentContext.ts` | Loom's `kind: "line"` union beside upstream's new `diffReviewSelectionId` builders (#33989, #38276); every upstream builder must emit `kind: "line"` (typecheck finds misses) |
| `apps/web/src/components/pullRequest/PullRequestDetailPanel.tsx` | Loom kind guard at line 1308 next to upstream's #38113 rework |
| `apps/web/src/components/pullRequest/PullRequestCodeTab.tsx` | Loom's word-highlight fallback comment (line 1200) in a file #36974 changed for 1.7; trial has no stale `onRevealSearchMatch` |
| `apps/web/src/rightPanelStore.test.ts` | Loom's graph and artefact migration cases (lines 808, 907) beside upstream's `side-chat` cases (615); the version-minus-one test at 445 works with 17 |
| `apps/web/src/components/preview/PreviewView.browser.test.tsx` | Loom's DL-1214 test at 351; keep |
| `apps/web/src/markdown-links.test.ts` | Five Loom lines; re-run after the Rule D move |
| `apps/web/src/components/pullRequest/pullRequestList.logic.ts` | Loom `Set` lookup (one line), low risk |

Already lost or wrong in the trial tree (not a missing `loom` line, but broken): `DiffPanel.tsx` declares `latestTurn` twice (lines 365, 443) and `branchDiffPreview` twice (516, 530); `rightPanelStore.ts` keeps `SingletonSurfaceKind` excluding the deleted `"side-chat"` and lacking `issue`/`thread`/`linked-thread`; `FileChangeView.tsx:682` passes a deleted prop. All are covered by the rows above.

### Left for the integration tracks (S2)

- **Typecheck** (expected hits in this area): `FileChangeView.tsx:682` prop; `SingletonSurfaceKind`; duplicate consts in `DiffPanel.tsx`; any upstream `ReviewCommentContext` literal without `kind`; Loom's plain-string `label`/`disabledReason` entries (`"Goal tasks"`, `LoomSurfaceAction`) beside upstream's `msg(...)` entries in the RightPanelTabs add-menu arrays, if `msg` returns a non-`string` type.
- **Lint**: two rules added at `error` in root `vite.config.ts` in range: `t3code/no-sparkles-icon` (`apps/web/src/**`, mobile, desktop; no Loom-only file uses Sparkles, the four hits at HEAD are upstream files upstream already fixed) and `t3code/no-untranslated-copy` (`apps/web/src/**`, mobile, client-runtime, tests excluded). The second will flag Loom's English strings in this area: `previewNotices` (FilePreviewPanel), `loomReview.label` inputs, "Goal tasks" / "This thread has no Loom goal." / "Workstream" / "Context" (RightPanelTabs), "Loading…" decorations. §5.1 and §8.1 decide (Loom-only files are excluded from the rule; Loom strings inside upstream components are wrapped). Loom's `DOM_TEST_ENVIRONMENT_ALLOWLIST` (12 jsdom tests) survived in the trial root `vite.config.ts` (lines 7, 368, 377).
- **Tests**: `AttachmentFilePreview.browser.test.tsx` case (section 4); `pullRequestDetail.logic.test.ts` (section 3); `loom/chatPathScan.test.ts` may need re-pointing because `FILE_PATH_PATTERN` now also matches bare `name.ext:line:col` and `$+@` in a first segment.
- **Dependencies (cross-area, owner `toolchain-config`)**: #27866 removed remark, `react-markdown`, `unified`, `@mdx-js/mdx`, `vfile`, `mdast-util-from-markdown`, `micromark-util-combine-extensions` from `apps/web/package.json`. Loom's MDX plan renderer still imports `unified` (5 files), `remark-parse` (5), `remark-gfm` (5), `remark-mdx` (2), `remark-frontmatter` (2), `react-markdown` (1), `@mdx-js/mdx` (1) from `apps/web/src/components/files/mdx-plan/**` and `apps/web/src/loom/**`. The trial `apps/web/package.json` still lists most of them but **not `unified`**: re-add `"unified": "catalog:"` (marked). Without it the MDX plan, recap and explainer viewer fails to build.
- **S2b checks**: inline editing (below), right-panel migration (load a saved v16 state with a `side-chat` tab and a `graph` tab, confirm the result).
- **S4 journey, inline diff editing (#590)**: in a thread whose agent changed a long file with wrapped lines, open Files, open the file, press "Show changes" (whole-file comparison), turn word wrap on, scroll about 200 lines down. (1) Click in the right-hand text mid-line: the caret lands at the clicked character, the view does not move. (2) Type three characters: no jump; the change counter and ruler update after a short pause. (3) Press Enter: no jump. (4) With a review comment on a line below, the comment stays on its text after the Enter. (5) Press Escape: typing ends, no jump, the comparison shows the typed text, the save settles. (6) Press Edit: the editor opens at the same line. (7) Cmd+F while typing: 1.7's built-in find opens over the focused editor and Escape returns to typing. Repeat (1) to (3) in unified layout. If (2) or (3) jumps, add Loom's one line (`this.getAdvancedVirtualizer()?.capturePendingLayoutAnchor();` at the top of `invalidateEditSessionLayout` in `dist/components/VirtualizedFileDiff.js`) to upstream's `patches/@pierre__diffs@1.7.0-beta.4.patch`; both methods exist in 1.7 (`VirtualizedFileDiff.js:563`, `:798`; `CodeView.js:1350`). The patch file itself is `labs-settings`' call.

Inline editing evidence (Q3): Loom calls `EditProvider` (`@pierre/diffs/react`), `Editor` and `EditorFocusOptions` (`@pierre/diffs/edit`, with `lineNumber`, `character`, `preventScroll`), the CodeView item `edit` flag, `onItemEditChange`, `onItemEditComplete` returning `"accept" \| "reject"`, `FileDiffEditCompleteEvent` fields `fileDiff`, `newFile`, `lineAnnotations`, `originalLineAnnotations`, and the editor option `onAttach(editor, instance)`. Each is declared identically in 1.7.0-beta.4 (`editor/types.d.ts:195-203`, `editor/editor.d.ts:120,145-152`, `react/types.d.ts:15,55`, `components/CodeView.d.ts:187-213`), and 1.7's React `CodeView` still reads `createEditor` from `EditContext` (`react/CodeView.js:6,43,76`), the same path upstream's own file editor uses at the target (`FilePreviewPanel.tsx:1108`). The patched behaviour: Loom's only edit to the 1.6.1 patch was the anchor capture. 1.7 rewrote that path: a line-moving change now captures the anchor in `applyChange` (`VirtualizedFileDiff.js:258`) and a typing change drops only measurements past the end (`:572-575`), so the original cause may be gone, but Escape (`cause === "exit"`) resets all measurements with no anchor. Sizing: no port expected; a one-line patch hunk if S4 shows the jump.
