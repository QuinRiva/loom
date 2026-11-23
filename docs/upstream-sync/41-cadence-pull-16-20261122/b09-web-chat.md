## Appendix B.9: web chat and the markdown renderer (23 files, 57 markers, 210 `loom:` lines) · lane 4 web chat

Read with §7 (the rules), §8 (the rulings) and the cross-lane table in §7.3. Written from a read of both sides of every hunk in the trial merge; "trial" line numbers are lines of the mid-merge file and move as hunks resolve. A row marked for Gate 1 is on the Gate 1 reviewer's list (§7.5).

**Decision labels used below.** "D1" is §8.1 "The composer context meter" (option (a) there = the meter kept as a Loom-owned component); "D2" (Reply) is carried in §8.2 with a follow-up in §8.3.

**Other zones are named by their research key:** `toolchain-config` = B.1 · `orchestration-delegation` = B.2 · `store-shell` = B.3 · `remote-auth-deploy` = B.4 · `mcp-tools` = B.5 · `pi-adapter` = B.6 · `textgen-usage` = B.7 · `multirepo-vcs` = B.8 · `markdown-chat` = B.9 · `web-panels-files-diff` = B.10 · `web-sidebar-shell` = B.11 · `labs-settings` = B.12 · `mobile-client` = B.13 · `i18n` = §5.1 · `migrations` = §5.5 · `overlap-audit` = Appendix C · `upstream-digest` = §6.13 and §0.

**Section numbers inside the text below** are this zone's research notes, not the runbook: "section 3" or "§3.x" is the per-hunk doctrine in this file, "section 4" the silently merged list, "section 5" the list for S2; "section 2" (decisions) is mapped to §8.1 above, "section 6" (deploy) is folded into For deploy, "section 7" into §0, "section 8" (follow-ups) into §8.3, and "section 9" (commands) into Appendix A.

### Paths in this zone

- `apps/web/src/components/ChatMarkdown.browser.test.tsx` · 2m · 6L · [3/7c] [19/13c]
- `apps/web/src/components/ChatMarkdown.tsx` · 11m · 28L · [4/18c] [5/1c] [22/8c] [3/3c] [19/3c] [10/4c] [25/1c] [3/2c] [9/7c] [31/6c] [12/12c]
- `apps/web/src/components/ChatView.tsx` · 7m · 40L · [13/6c] [19/8c] [3/4c] [10/11c] [4/2c] [3/2c] [6/5c]
- `apps/web/src/components/chat/ChatComposer.tsx` · 2m · 6L · [6/11c] [6/0o]
- `apps/web/src/components/chat/ComposerCommandMenu.tsx` · 1m · 1L · [5/4c]
- `apps/web/src/components/chat/ComposerFooterControls.tsx` · 3m · 4L · [7/1c] [4/0o] [16/0o]
- `apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx` · 1m · 7L · [2/2c]
- `apps/web/src/components/chat/MarkdownFileLink.tsx` · 1m · 3L · [65/3c]
- `apps/web/src/components/chat/MarkdownThreadLink.browser.test.tsx` · 4m · 4L · [5/5c] [1/5c] [10/8c] [6/81c]
- `apps/web/src/components/chat/MarkdownThreadLink.tsx` · 5m · 8L · [1/4c] [1/1c] [11/19c] [7/7c] [14/1c]
- `apps/web/src/components/chat/MessagesTimeline.logic.ts` · 1m · 7L · [3/2c]
- `apps/web/src/components/chat/MessagesTimeline.tsx` · 2m · 25L · [2/1c] [7/4c]
- `apps/web/src/components/chat/ThreadNow.tsx` · 1m · 5L · [20/10c]
- `apps/web/src/components/chat/TimelineAssistantRows.tsx` · 2m · 4L · [2/5c] [7/2c]
- `apps/web/src/components/chat/TimelineUserMessageRow.tsx` · 1m · 14L · [6/5c]
- `apps/web/src/components/chat/TimelineWorkEntryRow.tsx` · 1m · 2L · [18/10c]
- `apps/web/src/components/chat/UserMessageContextChips.tsx` · 2m · 14L · [1/3c] [8/2c]
- `apps/web/src/components/chat/useComposerMenuItems.ts` · 3m · 8L · [3/3c] [6/8c] [8/11c]
- `apps/web/src/components/chat/useComposerSend.ts` · 1m · 7L · [2/2c]
- `apps/web/src/components/composerContextPresentation.tsx` · 2m · 7L · [1/2c] [1/1c]
- `apps/web/src/session-logic.ts` · 1m · 2L · [2/5c]
- `packages/shared/src/composerContextReferences.test.ts` · 1m · 1L · [2/48c]
- `packages/shared/src/composerContextReferences.ts` · 2m · 7L · [4/2c] [16/9c]

### Per-hunk doctrine

Rows are one per hunk. Upstream PR numbers come from blaming each hunk's upstream side (§9). Rules are named as in doctrine §7.1. **Gate 1** = whether the Gate 1 reviewer must read the resolution.

#### 3.1 The renderer swap (#27866): what replaced remark, and the new extension points

- **Parser.** `@pierre/words` (`renderToHtml`) parses into HTML. `apps/web/src/markdown/wordsHast.ts` (1,296 lines, web app, not `packages/shared`) turns that into hast, applies the chat's transforms, then calls `sanitizeChatHast` from the new `packages/shared/src/markdownHast.ts`. After sanitising it adds heading ids, text direction and chip punctuation. `packages/shared/src/markdownPipeline.ts` still exports the remark plugin lists, but only `packages/shared`, `client-runtime` and mobile use them.
- **Rendering.** `createMarkdownRenderer({ markdown: WordsHastOptions, components, urlTransform })` in `apps/web/src/components/chat/markdownRenderer.ts` now returns `{ parse, element, remember }`, with a 500k-character parse cache keyed per options object. `MarkdownSource` calls `renderHastWithIslands(tree, markdownIslandOptions(state))` (`chat/markdownIslands.ts`). Elements for which `isIsland(node)` is true go through `CHAT_MARKDOWN_COMPONENTS`; every other element becomes `dangerouslySetInnerHTML`. Islands are `a`, `img`, `pre`, `details`, `table`, GitHub-alert `blockquote`, artefact-template `div`, task `input` (when editable), inline `code` that resolves to a file, and `p`/`li` holding skill or model chips. `ChatMarkdown` wraps the blocks in one `SharedTooltipProvider`.
- **Extension points.** Per element there is still a components override, typed as the local `MarkdownComponents` (`ChatMarkdown.tsx:417`), plus an `isIsland` case. Per message kind there is `MarkdownExtensions` (`userMessage`, `leadingWhitespace`, `inert`, `preview`, `changeRequest.autolinks`, `githubEmoji`). It is passed as the `extensions` prop, which replaces `extraRemarkPlugins`. Inline text linking runs through `linkText()` in `wordsHast.ts`: absolute file paths, then `changeRequest.autolinks`. **There is no remark or rehype plugin slot.** A hast transform can only be added as a hunk inside `wordsHast()`.
- **Math** renders as SVG in Words. `MarkdownMath`, `MathTypeset` and katex rendering left the chat.
- **Removed from `apps/web/package.json`:** `react-markdown`, `remark-gfm`, `remark-math`, `remark-parse`, `remark-rehype`, `unified`, `vfile`, `mdast-util-from-markdown`, `micromark-util-combine-extensions`, dev `@types/mdast` and `micromark-util-types`. **Added:** `@pierre/words` (`file:deps/…tgz`) and `property-information`. In the same range upstream also dropped `lucide`, `morphicons` and `unbash` from web (other researchers' areas). `react-markdown` is gone from upstream's lockfile entirely. `remark-gfm`, `remark-parse` and `unified` survive only under `packages/shared`, `packages/client-runtime` and `apps/mobile`. `remark-frontmatter` and `remark-mdx` survive only under `gt`'s toolchain. `@mdx-js/mdx` is absent.

#### 3.2 Loom imports that will not resolve (Q2)

pnpm here uses isolated `node_modules` (`publicHoistPattern` covers only `@cursor/sdk-*`). A package `apps/web` does not declare therefore does not resolve from `apps/web` source, even when another workspace package has it.

| Import | Loom files | Status after merge | Fix |
| --- | --- | --- | --- |
| `remark-gfm` | `files/mdx-plan/mdxCompileOptions.ts`, `proseDensity.ts`, `inlineMarkdown.tsx`, `loom/pendingUserInputLoom.tsx`, `loom/remarkReferenceLinks.test.ts` | Conflict hunk in `apps/web/package.json` (Loom side) | Keep `"remark-gfm": "catalog:"` as a Loom line |
| `remark-parse` | `mdxAttrs.ts`, `proseDensity.ts`, `inlineMarkdown.tsx`, `pendingUserInputLoom.tsx`, `remarkReferenceLinks.test.ts` | Conflict hunk | Keep `"remark-parse": "catalog:"` as a Loom line |
| `unified` | same five files | **Silently dropped in the trial (no marker)** | Re-add `"unified": "catalog:"` as a Loom line |
| `mdast` types (`@types/mdast`) | `inlineMarkdown.tsx`, `pendingUserInputLoom.tsx` | **Silently dropped from devDependencies** | Re-add `"@types/mdast": "^4.0.4"` (dev) as a Loom line |
| `remark-frontmatter`, `remark-mdx` | `mdxCompileOptions.ts`, `proseDensity.ts`, `mdxAttrs.ts` | Loom lines inside the conflict hunk | Keep |
| `@mdx-js/mdx` | `mdxCompileOptions.ts` | Loom line, merged clean | Keep |
| `react-markdown` (`defaultUrlTransform`) | `files/mdx-plan/blocks/code.tsx` | Gone from the tree | **Port**, do not keep: see the `code.tsx` row in §3.4 |
| `createMarkdownRenderer({ remarkPlugins, rehypePlugins, … })` (signature) | `files/mdx-plan/blocks/code.tsx` | API changed | **Port** (§3.4) |
| `react-markdown` types `ExtraProps` / `Components`; `unified` `Pluggable`/`PluggableList`; `remark-math` | Loom hunks in `ChatMarkdown.tsx` (h3, h7, h10) | Gone | Disappear under the Rule D re-home (§3.3) |

Drop from Loom's side of the `apps/web/package.json` hunk: `react-markdown`, `remark-math`, `remark-rehype`, `vfile` and `micromark-util-types`. No Loom file imports them. `apps/web/package.json` is in B.1; §5.4 holds the reconciled dependency list. `zod`, `jsdom` and `@tabler/icons-react` are Loom deps too but not markdown, so they are not listed here.

**Does upstream's removal take the MDX renderer's packages out of the tree?** Yes for `apps/web` resolution, no for the store. The lockfile must be regenerated (`vp i`) after the Loom lines go back in. There is no code change in the MDX renderer except `code.tsx`. The MDX compile (`@mdx-js/mdx` + remark) is untouched by #27866.

#### 3.3 Re-homing map for Loom's markdown extensions in `ChatMarkdown.tsx` (Q3)

| Loom extension (and where it is today) | Mechanism | New home in upstream's shape | Size |
| --- | --- | --- | --- |
| Project ticket/PR reference links (`useReferenceLinkRules` + `remarkReferenceLinks` appended to `extraPlugins`, h10) | **A remark plugin.** Cannot be re-applied as a hunk | Add a `loomReferenceLinks?: ReferenceLinker \| null` field to `WordsHastOptions` (not to `MarkdownExtensions`: any extensions object other than `NO_EXTENSIONS` turns off streaming block splitting, `ChatMarkdown.tsx` upstream line 2070). Add a 3-line Loom hunk in `linkText()` after the `changeRequest.autolinks` pass that splits text with `splitReferenceLinks` from `@t3tools/client-runtime/reference-links` and emits `link(url, text)` elements. That runs before `sanitizeChatHast`, as PR autolinks do. In `wordsOptions` add the linker to the cache key (a `WeakMap<ReferenceLinker, number>` id). Keep `remarkReferenceLinks.ts` for the MDX compile | About 40 lines plus a unit test; half a day |
| Loose prose path links (`rehypeChatFilePaths` appended to the rehype set once streaming ends; `ProseFilePath` mapped to `t3-file-path`; h3, h7, h10) | A hast transform (no unified dependency: `apps/web/src/loom/chatPathScan.ts:197`) | Add a `loomProsePaths: boolean` flag to `WordsHastOptions` and to the `wordsOptions` key string, set it to `!componentState.isStreaming`, and run `rehypeChatFilePaths()(hast)` after `groupChipPunctuation(hast)` in `wordsHast()`. It must stay after sanitising, or the custom tag is stripped. Add `case PROSE_FILE_PATH_TAG: return true` to `isIsland`. Add `[PROSE_FILE_PATH_TAG]: ProseFilePath` to `CHAT_MARKDOWN_COMPONENTS` (cast, as Loom did). Retype `ProseFilePath` props as `{ node?: HastElement; children?: ReactNode }` | About 25 lines; 1 to 2 hours |
| In-fence path links (`decorateCodeBlock` through `pre` into `SuspenseShikiCodeBlock`; h6 plus silent lines) | DOM decoration after paint | Unchanged: `pre` is always an island. Add `decorateCodeBlock` to upstream's `pre` destructure (h6). The `MarkdownCodeBlock.tsx` Loom lines merged clean and are intact | Hunk |
| Verified file chips and click-time re-verify (`makeVerifiedFileLinkChip`, `onVerifyBeforeOpen`; silent lines and h2) | Wraps `fileLinkChip` in component state | Unchanged: `a` and file-resolving inline `code` are islands. h2 is Rule U | Hunk |
| Unanchored inline-code chip (`unanchoredInlineCodeChip`; h5 plus silent body) | Inside the `code` override | Unchanged. The island predicate (`resolveInlineCodeFileLinkMeta(...) != null`) is the same condition Loom's branch sits under | Hunk |
| `t3-thread://` mentions via `MarkdownThreadLink` and `ThreadMention` (h4) | Inside the `a` override | Unchanged (`a` is an island). Pass both `threadRef={threadRef}` (upstream) and `fromThreadRef={threadRef}` (Loom) | Hunk |
| Document-follows-author open (`useOpenDocumentLink`; h1 plus silent) | `openFileInPanel` | Upstream rewrote `openAt` (#41073). Keep upstream's path resolution and swap its `useRightPanelStore.getState().openFile(ref, path, line)` call for `openDocumentLink(threadRef, path, { line: fileLinkMeta.line })` | Hunk |
| MDX `<Code>` "rendered markdown" view (`files/mdx-plan/blocks/code.tsx:75`) | Old `createMarkdownRenderer` with remark/rehype lists and `defaultUrlTransform` | `createMarkdownRenderer({ markdown: { math: false, breaks: false, escapeHtml: false, insights: false, extensions: {} }, components: { img: PlanMarkdownImage }, urlTransform })`, rendered with `r.element(r.parse(text))` (plus `r.remember(text, entry)` when the text is final). Copy upstream's private `safeUrl` (`ChatMarkdown.tsx:423`) into the Loom file as the URL transform, or export it from `ChatMarkdown.tsx` as a marked hunk | About 15 lines |

Loom has no other remark or `components={{…}}` hooks in `ChatMarkdown.tsx`. Loom's artefact chips are the document-follow open above. Upstream's `artifactTemplate` cards are Codex templates, unrelated to Loom.

#### 3.4 Doctrine table

| Path | Hunk | Upstream change | Loom's side | Rule | Resolution | Gate 1 |
| --- | --- | --- | --- | --- | --- | --- |
| `apps/web/src/components/ChatMarkdown.tsx` | h1 [4/18c] | #41073 PR-description links resolve in the PR's repo; #39130 user-action revision replaces `claimWorkspaceBasenameLookup` | Document links (`openDocumentLink`) | D | Take upstream's block (no `isLatestLookup`). In `openAt`, call `openDocumentLink(threadRef, <upstream's resolved path>, { line: fileLinkMeta.line })` | yes |
| same | h2 [5/1c] | #37893 / app bundles: `canOpenApp ? gt("Open app") : …` | `onVerifyBeforeOpen` prop (click-time re-verify) | U | Keep both props | no |
| same | h3 [22/8c] | #34181 quote-card regex constants | `ProseFilePath` component | U + D | Keep upstream's constants. Keep `ProseFilePath`, retyped to `{ node?: HastElement; children?: ReactNode }` (no `ReactMarkdownExtraProps`) | yes |
| same | h4 [3/3c] | #39406 `threadRef` prop on `MarkdownThreadLink` | `fromThreadRef` (favicon only for another project) | U | Pass both `threadRef={threadRef}` and `fromThreadRef={threadRef} // loom:`. Upstream's `threadRef` also drives the linked-thread panel, and Loom's other callers (`LoomTimelineRowView`, `LoomMdxAuthorLine`, `PromotedFromQuery`) pass a source thread that is not the viewing thread, so do not merge the two props now | no |
| same | h5 [19/3c] | #27866 math moved into Words | `unanchoredInlineCodeChip` destructure | D | Take upstream's 3-line destructure plus `unanchoredInlineCodeChip, // loom`. **Trap:** the `MarkdownMath` block on Loom's side is base text upstream deleted; drop it | yes |
| same | h6 [10/4c] | #27866 / #37893 `useGT`, slimmer destructure | `decorateCodeBlock` | U | Upstream's lines plus `decorateCodeBlock, // loom: in-fence path links`. Drop `inline` / `mathEnabled` (base) | no |
| same | h7 [25/1c] | #27866 `markdownOptions` WeakMap | `CHAT_MARKDOWN_COMPONENTS_WITH_PROSE_PATHS`, rehype plugin sets, `REMARK_MATH` | D (re-home) | Take upstream's line. Re-home per §3.3 (components entry plus `isIsland` case plus `wordsHast` flag). `REMARK_MATH` and the plugin sets are base and are dropped | yes |
| same | h8 [3/2c] | #27866 `createMarkdownRenderer({ markdown, components })` | prose-path components | D | Take upstream (the path component now lives in `CHAT_MARKDOWN_COMPONENTS`) | no |
| same | h9 [9/7c] | #27866 / #33794 `render.parse`, `remember` | prose-path components on the unshared renderer | theirs | Take upstream | no |
| same | h10 [31/6c] | #27866 `wordsOptions(extensions, flags)` | reference-link plugin, path rehype switch | D (re-home) | Take upstream. Add `loomProsePaths: !componentState.isStreaming` and `loomReferenceLinks: compileReferenceLinks(rules)` (via `useReferenceLinkRules()`) to the flags, keyed in `wordsOptions` (§3.3) | yes |
| same | h11 [12/12c] | #27866 `SharedTooltipProvider`, `markdown={markdown}` | `rehypePlugins` prop | theirs | Take upstream | no |
| same | silent lines | (imports, `verifyChipTarget`, `scannedPaths`, `componentState` fields, the `code` body) | Loom | check | Present in the trial. After resolving, drop the `remarkReferenceLinks` import from this file (it moves to the `wordsHast` path). All 28 `loom` lines are then either present or named as moved here | yes |
| `apps/web/src/components/ChatMarkdown.browser.test.tsx` | h1 [3/7c] | #39130 store imports; #27866 `MarkdownExtensions` type, `markdownTaskEdits` | `__setMetadataFetcherForTests` | U / E | Upstream's imports plus Loom's line. `setMarkdownTaskChecked` now comes from `@t3tools/shared/markdownTaskEdits` | no |
| same | h2 [19/13c] | #24637 host-video test | "loom scanned path links" describe | T | Keep both. These two tests are the proof that the prose-path re-home works | no |
| `apps/web/src/components/ChatView.tsx` | h1 [13/6c] | #39889 `useUsageLimitRecoveryBannerItem`; #37419 / #34431 logic imports | 11 Loom imports | U | Upstream's two imports plus every Loom import. Drop the base `usageLimitRecoveryBannerItem` import | no |
| same | h2 [19/8c] | #25445 `hasCompactableConversation`; #24619 `composerModelSelectionApplies` | Archived-root status line (`ArchivedThreadStatusLine`) | U | Loom's `archivedAt` / `loomThreadStatusLine` block, then upstream's two statements. Drop the base `serverVisibleTurnItems.some(...)` | no |
| same | h3 [3/4c] | #39889 banner hook takes `messages` | `useHubLoginBannerItems()` | U (i18n-only on upstream's side) | Upstream's closing `…, messages,\n  );` plus Loom's line | no |
| same | h4 [10/11c] | #37893 `branchMismatchBannerItem({…}, messages)` | `...hubLoginBannerItems` | U (i18n-only) | Loom's spread plus upstream's call | no |
| same | h5 [4/2c] | #37893 `gt("Preparing worktree")` | query-thread fork wait label | U (i18n-only) | Upstream's `gt(...)` arm plus Loom's `queryForkWaiting` arm. Whether Loom's string is wrapped follows rule I18N (§5.1) | no |
| same | h6 [3/2c] | #38282 `pullRequestsAvailable={linkedItemsSurfaceAvailable}`, `deviceAvailable={activeThreadRef !== null}` | `deviceAvailable={false}` (fork ships no Device surface), `loomSurfaceActions` | U | Upstream's `pullRequestsAvailable` plus Loom's `deviceAvailable={false}` and `loomSurfaceActions`. Cross-check with the mobile/device researcher in case pull 16 changes the Device ruling | yes |
| same | h7 [6/5c] | #35925 `checkpointScopes` | `ReferenceLinksProvider` wrapper | D | Keep Loom's outer `<ReferenceLinksProvider rules=…>`. Inner `FileMetadataThreadProvider` takes upstream's four props. **Trap:** the inner provider outside the marker lacks `checkpointScopes`; add it | yes |
| `apps/web/src/components/chat/ChatComposer.tsx` | h1 [6/11c] | #32324 `usePendingUserInputDraft` | `isServerThread` (Loom `/handoff`, `/retro`) plus base meter derivation | U, then D1 | Upstream's block plus `isServerThread`. Keep the `activeContextWindow` derivation only under D1 (a), re-importing `deriveLatestContextWindowSnapshot` from client-runtime | yes |
| same | h2 [6/0o] | #33131 deleted the meter props | meter props, `spendThreadRef` | A trap (upstream deletion) | Under D1 (a) keep and re-thread the props from ChatView. Under (b) drop all six lines | yes |
| `apps/web/src/components/chat/ComposerCommandMenu.tsx` | h1 [5/4c] | #37893 `msg(...)` labels (i18n-only) | `thread: "Threads"` (DL-750) | U | Upstream's four `msg()` lines plus Loom's `thread` entry (wrapping per the i18n rule). `ComposerTriggerKind` must keep `"thread"` in `composer-logic.ts` (web-sidebar-shell's file) | no |
| `apps/web/src/components/chat/ComposerFooterControls.tsx` | h1 [7/1c] | #33131 dropped `ProviderInteractionMode` (plan mode) | `ScopedThreadRef` | U, then D1 | Upstream's import line. Add `ScopedThreadRef` only under D1 (a). `ProviderInteractionMode` is base: drop it | no |
| same | h2 [4/0o] | #33131 meter props removed | `spendThreadRef` plus meter props | A trap | D1 (a): keep. D1 (b): drop | yes |
| same | h3 [16/0o] | #33131 meter mount removed | `ContextWindowMeter` with `loomSpend` | A trap | D1 (a): keep, and re-add the meter import upstream deleted silently. D1 (b): drop, and delete or re-home `LoomContextSpend` | yes |
| `apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx` | h1 [2/2c] | #33353 keeps line breaks; #34095 `pt-0.5` | `lineBreaks` (DT-36) | Superseded | Take upstream's two lines. Loom's other lines (`questionSummary`, `PendingQuestionAge`, last-question no-auto-advance) merged clean | no |
| `apps/web/src/components/chat/MarkdownFileLink.tsx` | h1 [65/3c] | #27866 chip hoisted into `const chip`, shared tooltip; #24603 | `onVerifyBeforeOpen` wrapping of the primary click | D | Take upstream. In `const chip`'s `hasPrimaryAction` arm `onClick`, re-apply Loom's `open()` closure plus `if (onVerifyBeforeOpen) { void onVerifyBeforeOpen(iconPath).then((ok) => ok && open()); return; }`. Prop and comparator lines merged clean | yes |
| `apps/web/src/components/chat/MarkdownThreadLink.tsx` | h1 [1/4c] | #39406 / #39515 / #37893 imports | `ScopedThreadRef` | theirs | Upstream's imports (they include `ScopedThreadRef`) | no |
| same | h2 [1/1c] | #39406 tooltip import | `ThreadMention` import | U | Both | no |
| same | h3 [11/19c] | #39406 / #34657 / #39515 reachability (`saved`, `connected`, `linked`, `reachable`) | DL-1818 decoded-ref shell (`held`) | D | Upstream's block, then Loom's `decodedRef` / `decoded` / `held`. Lookup condition: `held === null && reachable` | yes |
| same | h4 [7/7c] | #34657 `missing = … (settled \|\| !reachable)` | `held ??` target | U | Loom's `target = held ?? …`. Upstream's `missing` line | no |
| same | h5 [14/1c] | #37893 `gt("Thread")` | `ThreadMention` branch | U | Upstream's `title` line plus Loom's `shell !== null` → `ThreadMention` block. Upstream's linked-environment early return stays before it | no |
| `apps/web/src/components/chat/MarkdownThreadLink.browser.test.tsx` | h1 [5/5c] | #39406 `saved-vm` mock arm | `held-thread` mock arm | T | Union of both conditional arms | no |
| same | h2 [1/5c] | #38323 shell `lineage` | `source: {}` | T | Both fields | no |
| same | h3 [10/8c] | #34657 unconnected-machine test | DL-1818 decoded-shell test | T | Keep both tests. Loom's needs `environment` saved and connected or `reachable` is false; upstream's mocks list it as an identity and `setup()` sets `state.connected = ["environment", "remote"]`, so it should pass once the h1 mock arms are unioned | no |
| same | h4 [6/81c] | #39406 / #39515 linked-thread tests | rest of the DL-1818 test | T | Both | no |
| `apps/web/src/components/chat/MessagesTimeline.logic.ts` | h1 [3/2c] | #37893 `toolActivityCopy`; #39146 `isHostPath` | `LoomPromotionRow` / `LoomTimelineRow` type import | U | Upstream's two imports plus Loom's. Drop base `isWindowsAbsolutePath` (unused after merge) | no |
| `apps/web/src/components/chat/MessagesTimeline.tsx` | h1 [2/1c] | #30084 `minimapItems.entries()` | `publishVisibleRows(...)` (context-viz) | U | Loom's call, then upstream's loop header | no |
| same | h2 [7/4c] | #33038 `scheduleMinimapRefresh()` in the observer | observe the scroller too | U | `observeResize(scroller ? [viewportElement, scroller] : viewportElement, () => { measureTimelineGutter(viewportElement); scheduleMinimapRefresh(); })` | no |
| `apps/web/src/components/chat/ThreadNow.tsx` | h1 [20/10c] | #24583 `failed` phase (alert role, icon); #37893 `useMessages` | `threadRef` prop and sync-error diagnostic | D | Upstream's component shape (failed arm, `threadSyncLabel(phase, m)`) plus Loom's `threadRef` prop, `useThreadSyncError` and the diagnostic span. Still needed: upstream reports `failed` only once detail exists, so a failed first load still says "Loading messages…" | no |
| `apps/web/src/components/chat/TimelineAssistantRows.tsx` | h1 [2/5c] | #23167 VCS status atom | `DocumentQueryPromoteButton`, `ProseFigure` imports | U | Both | no |
| same | h2 [7/2c] | #33124 `AssistantReplyButton` | Promote on a query thread's answer | U | Keep both buttons (D2 decides whether Reply stays visible) | no |
| `apps/web/src/components/chat/TimelineUserMessageRow.tsx` | h1 [6/5c] | #37893 `gt("You", …)`, `gt("{name} (guest)")` (i18n-only) | `loomBubble?.label ??` (control channel names the speaker) | U | `loomBubble?.label ?? (folded ? senderLabel : …gt…)`. The other 13 `loom` lines merged clean | no |
| `apps/web/src/components/chat/TimelineWorkEntryRow.tsx` | h1 [18/10c] | #35549 / #40076 timestamp moved out of the row tail; chevron only when expandable | `RowFigure` (context-viz) | D | Take upstream's conditional chevron. Put `<RowFigure nativeId={…} />` (marked) immediately before it. Drop the base timestamp and always-rendered `invisible` chevron | no |
| `apps/web/src/components/chat/UserMessageContextChips.tsx` | h1 [1/3c] | #37768 drag file pills (`useNativeFileDrag`) | `useOpenDocumentLink()` | U | Both | no |
| same | h2 [8/2c] | #37893 `const m = useMessages()` (i18n-only) | `LineReviewCommentContext` plus `queryThreadId` signature | U | Loom's signature, then upstream's `m` line | no |
| `apps/web/src/components/chat/useComposerMenuItems.ts` | h1 [3/3c] | #31207 `matchComposerModelItems`, types | three Loom imports (DL-750 `!` menu, side-thread filter, `/handoff`) | U | Both | no |
| same | h2 [6/8c] | #37243 search linked machines | `!` trigger reads shells | D | `useVisibleThreadShells(isPathTrigger \|\| composerTriggerKind === "thread")` plus upstream's `useThreadSearch([environmentId, ...linkedEnvironments.keys()], …)` | no |
| same | h3 [8/11c] | #37893 `matchComposerThreadItems({...}, messages)` | `isListedThread` filter | U | Upstream's two-argument call with `shells: environmentThreadShells.filter((shell) => isListedThread(shell.source)), // loom:` | no |
| `apps/web/src/components/chat/useComposerSend.ts` | h1 [2/2c] | #33131 `DEFAULT_INTERACTION_MODE`; plan follow-up removed | **Loom deletion** of the `recordPromptSent` import (DL-1718 / DL-1725) | trap | Resolve to `import { type ChatMessage, DEFAULT_INTERACTION_MODE } from "../../types";` only. Drop `resolvePlanFollowUpSubmission` (upstream deleted plan mode). **Drop `recordPromptSent`**: the Star-on-GitHub toast stays unscheduled; the call site is already Loom's comment | yes |
| `apps/web/src/components/composerContextPresentation.tsx` | h1 [1/2c] | #40945 `queuedMessageEdit` import | `LineReviewCommentContext` import | U | Both | no |
| same | h2 [1/1c] | #37893 `useMessages()` (i18n-only) | `environmentId` from context (promoted link back) | U | Both lines | no |
| `apps/web/src/session-logic.ts` | h1 [2/5c] | #36384 `sentMessageFromToolItem` | `isConsultToolItem` import | U | Upstream's three-name import plus Loom's. Consult cards stay `kind: "event"` (trial line 734), which every visibility mode keeps: zen hides only `subagent` events, and `withoutSubagentDelegationRows` filters only `work` | no |
| `packages/shared/src/composerContextReferences.ts` | h1 [4/2c] | #32702 `expandAssistantCitationsForProvider` | `planCommentAnchorDetails`, `formatThreadLink` (DL-752) | U | All three imports | no |
| same | h2 [16/9c] | #32702 citation expansion around the projection | DL-752 inline `t3-thread://v1/` projection for thread records | D | `const body = expandAssistantCitationsForProvider(replaceComposerContextReferences(input.text, <Loom's callback>));` | yes |
| `packages/shared/src/composerContextReferences.test.ts` | h1 [2/48c] | #33124 reply-projection test | DL-752 test header | T | Keep upstream's new test and Loom's, as separate `it` blocks (the shared body after the marker is Loom's test, renamed from upstream's attached-thread test) | no |

### Silently merged files Gate 2 reads in this zone

| File | Why |
| --- | --- |
| `apps/web/package.json` (toolchain-config owns the conflict) | `unified` and `@types/mdast` were dropped outside any marker; the MDX renderer imports both (§3.2) |
| `apps/web/src/components/chat/ComposerFooterControls.tsx` | Upstream deleted the `ContextWindowMeter` import line without a conflict; under D1 (a) it must come back |
| `apps/web/src/components/chat/MarkdownCodeBlock.tsx` | Upstream rewrote 122 lines (#27866; icons now from `lucide-react`). All 11 Loom lines (`useCodePathDecoration`, `decoratedRef` on both arms) are present, but check that the decorated `div`s are still the ones Shiki writes into |
| `apps/web/src/components/chat/timelineMinimapItems.ts` | Upstream moved its parse from remark to Words. Loom's `isHumanPrompt` (3 lines) is present; check the rail still skips agent-authored user rows |
| `apps/web/src/components/chat/SkillInlineText.tsx` | Loom's `pre` literal check reads `child.props.node?.tagName`. Islands now decide chip paragraphs via `hastTextHasChip`, so confirm a `$skill` inside a fence still stays literal |
| `apps/web/src/components/chat/TimelineWorkGroupRows.tsx` | Upstream replaced `extraRemarkPlugins` with `extensions`. All 7 Loom lines (`GroupFigure`, `useSyncLayout`) are present |
| `apps/web/src/components/chat/ChatMarkdownMedia.tsx`, `FileTagChip.tsx` | Loom's `uncapWidth` / `maxWidthCap` (MDX images) and the `FileTagChipContent` / `ThreadTagChipContent` exports used by `verifiedFileChips.tsx` are present; upstream added an `icon` prop |
| `apps/web/src/components/chat/TimelineV2EventRow.tsx` | The `ConsultCardRow` dispatch (4 lines) is present |
| `apps/web/src/components/ChatMarkdown.permissions.browser.test.tsx` | 3 Loom lines are present; it renders through the new renderer |

No Loom line was found already lost in these files: the `loom` count in each trial file equals the `+…loom` count of Loom's delta. The losses are the two `package.json` lines and the meter import above.

### Left for the integration tracks (S2)

- **Typecheck.** The `ChatMarkdown.tsx` re-home (§3.3) and the `code.tsx` port are the only real code. Expect errors in `ChatMarkdown.tsx` until `ProseFilePath` is retyped and the plugin sets are gone. `rg -n 'react-markdown|PluggableList|Pluggable\b' apps/web/src` must return nothing outside `files/mdx-plan` and `loom/` remark code.
- **Tests to keep green.**
  - Loom tests that prove the re-home: `ChatMarkdown.browser.test.tsx` ("loom scanned path links", chip re-verify at lines 195 and 575), `loom/chatPathScan.test.ts`, `loom/verifiedFileChips.browser.test.tsx`, `MarkdownThreadLink.browser.test.tsx` (DL-1818, needs the mock union), `composerContextReferences.test.ts` (DL-752).
  - `loom/remarkReferenceLinks.test.ts` keeps using remark (MDX path).
  - `preview/fixtures.test.tsx` renders every harness fixture.
- **New test worth adding (risk medium).** One unit test for the chat reference-link split in `wordsHast`: no chat-level test covers reference links today (`rg -l referenceLink apps/web/src --glob '*.test.*'` finds only the remark test).
- **Lint.** The `// loom:` marks on the new `wordsHast.ts` hunks and the `isIsland` case (the ship gate's unmarked sweep).
