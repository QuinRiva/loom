## Appendix B.13: mobile and the client permission tables (11 files, 21 markers, 53 `loom:` lines) · lane 6 client

Read with §7 (the rules), §8 (the rulings) and the cross-lane table in §7.3. Written from a read of both sides of every hunk in the trial merge; "trial" line numbers are lines of the mid-merge file and move as hunks resolve. A row marked for Gate 1 is on the Gate 1 reviewer's list (§7.5).

**Decision labels used below.** "D-MOB-1" is §8.1 "Phone: tapping a relative file path". "D-I18N-1" is §8.1 "Translation lint on Loom's own surfaces".

**Other zones are named by their research key:** `toolchain-config` = B.1 · `orchestration-delegation` = B.2 · `store-shell` = B.3 · `remote-auth-deploy` = B.4 · `mcp-tools` = B.5 · `pi-adapter` = B.6 · `textgen-usage` = B.7 · `multirepo-vcs` = B.8 · `markdown-chat` = B.9 · `web-panels-files-diff` = B.10 · `web-sidebar-shell` = B.11 · `labs-settings` = B.12 · `mobile-client` = B.13 · `i18n` = §5.1 · `migrations` = §5.5 · `overlap-audit` = Appendix C · `upstream-digest` = §6.13 and §0.

**Section numbers inside the text below** are this zone's research notes, not the runbook: "section 3" or "§3.x" is the per-hunk doctrine in this file, "section 4" the silently merged list, "section 5" the list for S2; "section 2" (decisions) is mapped to §8.1 above, "section 6" (deploy) is folded into For deploy, "section 7" into §0, "section 8" (follow-ups) into §8.3, and "section 9" (commands) into Appendix A.

### Paths in this zone

- `apps/mobile/src/features/files/ThreadFilesRouteScreen.tsx` · 1m · 8L · [3/2c]
- `apps/mobile/src/features/files/WorkspaceFilePreviewError.tsx` · 1m · 3L · [9/3c]
- `apps/mobile/src/features/home/HomeRouteScreen.tsx` · 1m · 1L · [7/6c]
- `apps/mobile/src/features/keyboard/CommandPalette.tsx` · 1m · 3L · [2/2c]
- `apps/mobile/src/features/threads/PendingUserInputCard.tsx` · 3m · 4L · [1/1c] [25/26c] [29/18c]
- `apps/mobile/src/features/threads/ThreadFeed.tsx` · 7m · 13L · [5/8c] [1/1c] [1/4c] [2/1c] [1/116c] [2/1c] [1/1c]
- `apps/mobile/src/features/threads/ThreadNavigationSidebar.tsx` · 1m · 5L · [19/34c]
- `apps/mobile/src/features/threads/thread-list-v2-items.tsx` · 1m · 9L · [3/2c]
- `apps/mobile/src/features/threads/thread-search-match.tsx` · 2m · 3L · [3/1c] [2/28c]
- `packages/client-runtime/src/state/commandPermissions.test.ts` · 1m · 2L · [55/3c]
- `packages/contracts/src/clientRpcPermissions.ts` · 2m · 2L · [1/1c] [6/4c]

### Per-hunk doctrine

Every hunk follows the `i18n` findings' rules I18N-1/2/3 (`.artifacts/pull16-measure/findings/i18n.md` §3.2). A Loom string in an upstream mobile component is written inside `gt("…")` / `<T>`. A plain literal now fails `t3code/no-untranslated-copy`.

#### `apps/mobile/src/features/threads/ThreadFeed.tsx` (7 markers, 13 `loom` lines). All 21 `loom` lines of Loom's version are in the trial file.

| # | Line | Shape | Upstream PR | Loom side | Rule | Resolution | Gate 1 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 286 | [5/8c] | #33943, #35036, #36364 (link lookup imports) | Imports of `messageFileLookup.loom` and `messageFileLinks.loom` (D-MOB-1) | U | Keep both import blocks. Under D-MOB-1 B, take upstream's only | no |
| 2 | 1229 | [1/1c] | #36364 adds `reply?: MarkdownLinkReply` | `onLinkPress(href, messageMarkdown?)` | U | `readonly onLinkPress: (href: string, reply?: MarkdownLinkReply, messageMarkdown?: string) => void; // loom: messageMarkdown` | yes |
| 3 | 1355 | [1/4c] | #37117 `onImagePress` with gallery; #36364 `reply` on link and context-menu actions | Passes `props.markdown` so the lookup can read the message's folders | U | Take upstream's 4 lines, then change the `onLinkPress` line to `(href) => props.linkHandlers.onLinkPress(href, props.reply, props.markdown), // loom: its folders` | yes |
| 4 | 2282 | [2/1c] | #35306 drops `renderAssistantCitationsAsText` (citations become selectable) | `loomBubble` line (3d-3 control bubbles), above the base line | U | Keep `const loomBubble = …; // loom: 3d-3`, then upstream's `const renderedText = presentation.text;`. **Trap:** Loom's side still has the base `renderAssistantCitationsAsText(...)`, whose import upstream deleted | no |
| 5 | 3366 | [1/116c] | #35036 `findFileLinkTarget` (+ #36364, #39142, #40986 refinements); #37117 `withGallery` param | Loom's 3-argument `onMarkdownLinkPress` header; Loom's lookup body (silently merged below the marker) calls `openMarkdownLink` | D | Under D-MOB-1 A: keep upstream's `findFileLinkTarget` whole. The header becomes `(href, imageEmbed = false, reply?: MarkdownLinkReply, withGallery?: …, messageMarkdown?: string)`. Keep Loom's merged body (abort controller, `unanchoredFileLink`, `lookUpMessageFile`, feedback). `openMarkdownLink` must take `reply` and `withGallery` (upstream's body below uses both) plus a `verified` flag that skips `findFileLinkTarget` when Loom's result is `Found` | yes |
| 6 | 3610 | [2/1c] | #35036: the file branch now awaits `findFileLinkTarget(...).then(...)` | Base `openAt` closure tail | D | Take upstream's `});`. Loom's `openAt` is gone; its one Loom line (`fromRelativeLink`) already sits inside upstream's `navigate` call in the trial file | no |
| 7 | 3645 | [1/1c] | #36364 | `onLinkPress: (href, messageMarkdown) => …` | U | `onLinkPress: (href, reply, messageMarkdown) => onMarkdownLinkPress(href, false, reply, undefined, messageMarkdown),` | no |

#### `apps/mobile/src/features/threads/PendingUserInputCard.tsx` (3 markers, 4 `loom` lines)

| # | Line | Shape | Upstream PR | Loom side | Rule | Resolution | Gate 1 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 25 | [1/1c] | #29151 file links in question cards | `relativeTime` import for "Asked N ago" (pull 15 §6.10) | U | Keep both imports | no |
| 2 | 253 | [25/26c] | #37398 Stop beside the expanded card; #37893 `gt`/`<T>` | `askedAgo` line under "Fill in the pending answers" | D | Take upstream's block. Insert Loom's comment and `<Text className="font-sans text-xs text-foreground-muted">{askedAgo(…)}</Text>` after upstream's `<T>Fill in the pending answers</T>` Text, inside the inner `View`. I18N-3: the module-level `askedAgo` (line 77) returns capitalised copy, so move it into the component as `age === "<1m" ? gt("Asked just now") : gt("Asked {age} ago", { age })` | no |
| 3 | 349 | [29/18c] | #34784 option previews: each option is wrapped in `<View key>` | Base option `Pressable`; the one Loom line is the comment "Recommended badge detached … DT-84" | D | Take upstream's. Re-add the Loom comment above the label `Text`, or drop it (a comment only). Upstream did not restore a Recommended badge | no |

#### `apps/mobile/src/features/threads/thread-search-match.tsx` (2 markers, 3 `loom` lines)

| # | Line | Shape | Upstream PR | Loom side | Rule | Resolution | Gate 1 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 21 | [3/1c] | #37893 `const gt = useGT()` | `threadSearchExcerptLabel` with early return (DL-1709 family: every indexed source labelled) | ours + I18N | Keep Loom's 3 lines. Put `const gt = useGT();` **before** the early return (rules of hooks), or omit it and delete the silently merged `import { useGT }` line 9 (otherwise it is an unused import) | no |
| 2 | 41 | [2/28c] | #37893 wraps "You:" / "Agent:" | Fragment plus the `label` from client-runtime, plus the "Sub-thread:" line | ours + I18N-3 | Keep Loom's version. The `label` comes from `client-runtime/src/state/loom/threadSearch.ts`, which the i18n exclusion covers. Write the sub-thread line as `<T>Sub-thread: <Var>{subThreadTitle}</Var></T>` | no |

#### Single-hunk files

| File | Line, shape | Upstream PR | Loom side | Rule | Resolution | Gate 1 |
| --- | --- | --- | --- | --- | --- | --- |
| `apps/mobile/src/features/files/ThreadFilesRouteScreen.tsx` (8 `loom` lines, 1 in the hunk) | 360 [3/2c] | #37893 | `.mdx` previews read up to 8 MB | U + I18N-2 | `{isMdxDocumentFile(props.relativePath) ? gt("Preview limited to the first 8 MB of a truncated file.") : gt("Preview limited to the first 1 MB of a truncated file.")} {/* loom: an .mdx reads up to 8 MB */}`. This keeps upstream's translated key for the common case. The other 7 `loom` lines (`onViewSource`, `path`, `fromRelativeLink`, the MDX mode override) merged silently and are present | no |
| `apps/mobile/src/features/files/WorkspaceFilePreviewError.tsx` | 54 [9/3c] | #37893 | Not-found message naming the checked path, with the relative-link hint (Loom `5413446cf2`, `4121acce5a`) | ours + I18N-2 | Keep Loom's branching with every string wrapped: `gt("File not found")` / `gt("Preview unavailable")`; `gt("There is no file at {path}.", { path: props.path })`, then `gt("The message may have given it relative to a different folder.")` joined with a space when `fromRelativeLink`; `MISSING_FILE_ACCESS_MESSAGE` unchanged; `gt("The server could not prepare a preview of this file.")`; `actionLabel={gt("Try again")}`. Upstream's "This file may be missing…" key goes unused, which only `i18n:check` (not run by Loom) would report | no |
| `apps/mobile/src/features/home/HomeRouteScreen.tsx` | 73 [7/6c] | #28324 search clears on open (iPhone) | `handleSelectThread` widened to `Pick<…, "environmentId" \| "id">` so an archived hit opens (pull 15 §6.10) | D | Take upstream's 6 lines. Then widen upstream's own `handleSelectThread`, now **below** the marker (`(thread: EnvironmentThreadShell) => selectThreadRoute(...)`), to `Pick<EnvironmentThreadShell, "environmentId" \| "id">` with the `// loom:` comment. **Trap:** keeping Loom's definition as well declares `handleSelectThread` twice. Dropping the widening is a type error: `HomeScreen.tsx:134` (silently merged) types `onSelectThread` with the `Pick` | yes |
| `apps/mobile/src/features/keyboard/CommandPalette.tsx` | 12 [2/2c] | #37315 `isShownUnderParent` replaces `isListedThreadLineage` | `threadSearchExcerptLabel` import | U | Keep Loom's import line and upstream's 2 lines; drop `isListedThreadLineage` (no remaining use in the trial file). The i18n findings count 2 flagged Loom strings in this file, in lines that merged silently (the archived row's "Archived" badge and `"Untitled thread"` title): write them as `<T>Archived</T>` and `gt("Untitled thread")` | no |
| `apps/mobile/src/features/threads/ThreadNavigationSidebar.tsx` | 609 [19/34c] | #33188 Add environment button, #38155 failed search state, #37893 | "Searching threads…" (Loom indexes more than messages) | D + I18N-2 | Take upstream's block and change only the pending string to `gt("Searching threads…") // loom: more than messages` | no |
| `apps/mobile/src/features/threads/thread-list-v2-items.tsx` (9 `loom` lines) | 898 [3/2c] | #28616 `resolveThreadListV2RowStatus` (failed badge clears once seen) | `pendingQuestion` (S4) and `workstreamBadge` (3d-3) lines | U | Take upstream's `rawStatus` / `status` lines, then Loom's 2. Loom attention reasons pass through `resolveThreadListV2RowStatus` unchanged: it only rewrites `"failed"` (`threadListV2.ts:365` in the trial) | no |
| `packages/contracts/src/clientRpcPermissions.ts` | 5 [1/1c] | #32941 imports `AuthEnvironmentMaintainScope` itself | Same import, marked | Superseded | Take upstream's unmarked line | no |
| same | 98 [6/4c] | #40036 `peerLinksPairClient`/`PairLink`, #35871 `agentFeedbackAnswerRequest` | 4 Loom methods (below) | U | Upstream's 4 lines, then Loom's 6 | no |
| `packages/client-runtime/src/state/commandPermissions.test.ts` | 183 [55/3c] | #31723 OTLP test becomes `it.effect.each([serverCheckOtlpEndpoint, serverCheckSecretSource])`; #35993 drops `Effect.scoped` | Two `it.effect.each` blocks (hub login, deploy) plus the base OTLP header | T | Keep Loom's two blocks, then upstream's 3-line `each` header. Drop Loom's trailing `it.effect("…OTLP…", () => Effect.scoped(` (base text upstream replaced). Write Loom's blocks without the `Effect.scoped(` wrapper, as #35993 did, so the closing parentheses match | no |

**Loom's guarded methods** (`CLIENT_GUARDED_RPC_SCOPES`): `usageLimitSourceLoginStart`, `usageLimitSourceLoginFinish` → `AuthProvidersManageScope`; `startDeploy`, `cancelDeploy` → `AuthEnvironmentMaintainScope`. **Upstream's additions in range** (16): `providerMcpSignInStart/Complete` (providers manage; #39921); `serverReclaimDatabaseSpace` (environment maintain; #32941); `serverCheckSecretSource`, `serverListTextGeneratorModels` (settings write; #31723, #33147); `issuesCreate/Comment/Update/SetState/React` (source-control write; #19259); `issueTrackersConnect/BindProject` (settings write; #19274); `workspaceAddTaskFolderRepository` (source-control write; #35925 multi-repo projects); `peerLinksPairClient/PairLink` (access write; #40036); `agentFeedbackAnswerRequest` (orchestration operate; #35871). Device approval (#36419) adds no guarded RPC here. No scope was renamed or removed; upstream only added `AuthAdministrativeClientScope` and `AuthRelayConfigureScope`. No Loom method is left with a stranded scope.

### Silently merged files Gate 2 reads in this zone

Every Loom-added line in the 25 both-modified mobile and client-runtime files is still in the trial tree. A text search found none missing. What changed is the meaning of a few of them:

| File | Why |
| --- | --- |
| `apps/mobile/src/features/files/MdxDocumentView.loom.tsx` (Loom-only, did not conflict) | Lines 23 and 29 import `../../components/FilePreviewModal` and `../../components/VideoPreviewModal`, which #33173 (`415f68d2fe`) moved. They become `../../components/ui/FilePreviewModal` and `../../components/ui/VideoPreviewModal`, with platform files `.android.tsx` beside them. Exports and props are unchanged: `FilePreviewModal({ source: FilePreviewSource \| null, onRequestClose })`, with `FilePreviewSource` re-exported from `FilePreviewModal.types.ts`; `VideoPreviewModal({ source: VideoPreviewSource \| null, onRequestClose })`. **Line 213** `await refreshAssetUrl(...)` needs `.catch(() => null)`: after #32994 (`5a9866d501`) it throws on a server refusal, and `void signImage(...)` (line 236) would leave that image loading forever. Every upstream caller added the catch (`attachmentDocument.ts:50`, `assets.ts:174`, `VideoPreviewModal.tsx:56`) |
| `apps/mobile/src/features/files/MdxDocumentView.loom.test.tsx` | `vi.mock` paths at lines 71-72 need the same `components/ui/` rewrite. Without it the mocks miss and the real native modal is imported |
| `apps/mobile/src/features/threads/messageFileLinks.loom.ts` | Line 6 imports `stripRepeatedWorkspacePrefix` from `@t3tools/client-runtime/workspace-basename-lookup`. #33943 (`3051b32502`) un-exported it (`workspaceBasenameLookup.ts:48` at `a09738fb43`). Web `apps/web/src/loom/verifiedFileChips.tsx:4` imports it too. Fix: re-add `export` with `// loom: used by verified chips and the phone's link lookup` in `packages/client-runtime/src/workspaceBasenameLookup.ts`. That file is not in the both-modified list, because Loom never edited it |
| `apps/mobile/src/features/home/HomeScreen.tsx` (39 added lines, 9 `loom`) | Upstream reworked it for Legend List 3.7 (#28125) and the search-open change (#28324). Loom's archived search rows (`threadListV2SearchArchivedItems`, `ArchivedSearchResultRow`) are appended to the list items, and `onSelectThread` is typed with `Pick` (see `HomeRouteScreen` above). Check the appended rows still render through upstream's new item renderer |
| `apps/mobile/src/components/ComposerContextSheet.tsx` | Loom's `mdxAnchor` labels (lines 283-295) now fail the i18n rule; the `i18n` findings give the fix |
| `apps/mobile/src/features/threads/threadListV2.ts` | `lostdecls` reports `sortThreadsForListV2`. It is **upstream's** function: #34170 (`49013438a9`) removed its test and dropped `export`. No Loom file uses it (no hits in the trial tree), so nothing to do |
| `packages/client-runtime/src/state/threadRequests.ts` | `lostdecls` reports `pendingRuntimeRequestIds`. Upstream deleted it in #23617; nothing in the trial tree uses it. Loom's `blocking` field (open questions) is intact |
| `packages/client-runtime/src/state/assets.ts` | Loom's `not-found` failure reason is intact and still reaches `WorkspaceFilePreviewError` through mobile `asset-url-state.ts:4` |

`apps/mobile/src/features/layout/workspace/workspace-tabs-state.test.ts` mocks `../../pull-requests/PullRequestFilterMenuContext`, which does not exist. That is **upstream's own** stale mock: the module was deleted on 26 October (#25614, before the base) and the mock is unchanged since `faf9d7354c` (5 Nov). Loom never touched the file. A `vi.mock` with a factory for an unresolved path is never imported, so leave it.

**Other cross-area hits from the same import sweep (for the parent to route):** `apps/web/src/loom/LoomDeployRow.tsx:15` imports `searchableSetting` from `settingsSearch.ts`, which #37893 un-exported. Use `const searchableSetting = useSearchableSetting();` inside the component (`settingsSearch.ts` is owned by `labs-settings`, whose findings do not mention this).

**`packages/client-runtime/package.json` export map:** all 16 export keys Loom added (`./unanchored-file-references`, `./reference-links`, and the 14 `./state/loom/*`) are in the trial file. The one conflict is Loom's `./unanchored-file-references` beside upstream's new `./saved-views`; keep both (Rule U). `state/loom/loomTestFixtures.ts` has no export entry and never had one (test-only).

### Left for the integration tracks (S2)

- **Typecheck will catch:** the two moved modal imports, `stripRepeatedWorkspacePrefix` (2 importers), `searchableSetting` (1), and the `handleSelectThread` widening. It will **not** catch the `refreshAssetUrl` throw (runtime only).
- **Lint:** an unused `useGT` import in `thread-search-match.tsx` if the resolution does not use it. Loom strings inside the upstream files above go inside `gt()`/`<T>` (the i18n rule). Mobile Loom-only files: 6 files, 25 errors, all covered by the `i18n` exclusion hunk.
- **`vp run lint:mobile`** (`scripts/mobile-native-static-check.ts`) runs in S2b as before.
- **Tests to re-point:** `MdxDocumentView.loom.test.tsx` (2 mock paths); `commandPermissions.test.ts` (Loom's 2 blocks without `Effect.scoped`); `messageFileLinks.loom.test.ts` compiles once the export is back. Under D-MOB-1 B, delete it.
- **#38912 needs no rewrite in Loom.** Count of Loom call sites by helper, all in Loom-only files (0 in `loom`-marked lines of upstream files):

| Helper | Calls | Files | Still Promise after #38912 |
| --- | --- | --- | --- |
| `useAtomCommand` | 18 | 13, all web | yes, new optional 2nd arg `{ signal }` |
| `useAtomQueryRunner` | 1 | 1 (web `openDocumentLink.ts`) | yes |
| `runAtomCommand` | 3 | 3 (mobile `useLoomAppBuild.loom.ts`, web `usePathExistence.ts`, `LoomDeployRow.tsx`) | yes |
| `executeAtomQuery` | 8 | 7 (mobile 2, web 5) | yes (`signal` now in `AtomCommandOptions`) |
| direct `command.run(...)` | 0 | 0 | n/a |
| `createEnvironmentRpcCommand` definitions | 3 | `client-runtime/src/state/loom/goalCommands.ts` (2: the `command()` helper and `hubLoginFinish`), web `loom/review/reviewQueries.ts` (1) | options shape unchanged for the fields Loom uses (`label`, `tag`, `concurrency`) |

**What #38912 changed, for reference.** `AtomCommand.run: (registry, input) => Promise<AtomCommandResult>` became `=> Effect.Effect<A, E>`, running on the caller's fiber. `runAtomCommand(registry, command, input, options)` is now the only Promise entry point. `scheduleAtomCommandEffect` and `settleAtomCommandResult` were deleted. New `awaitAtomResult` and `provideAtomRuntime`. A call site written for the old shape fails in one of three ways:
- `const r = await cmd.run(reg, x); r._tag` is a type error.
- `Effect.promise(() => cmd.run(...))` is a type error.
- `void cmd.run(reg, x)` and a bare `await cmd.run(reg, x)` with the result ignored **compile and do nothing** (the Effect is built and never run).

Upstream's own rewrite (`apps/mobile/src/state/peerPairingCode.ts`):

```ts
// before
const result = await mintPairingCode.run(appAtomRegistry, { environmentId, input: access });
// after
const result = await runAtomCommand(appAtomRegistry, mintPairingCode, { environmentId, input: access }, { reportFailure: false });
```

Inside Effect code, `yield* cmd.run(registry, input)` or `.pipe(...)` (upstream `updateEverythingRun.tsx`).
