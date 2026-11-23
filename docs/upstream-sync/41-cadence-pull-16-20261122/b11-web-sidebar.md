## Appendix B.11: web sidebar, thread row, palette, routes (15 files, 27 markers, 113 `loom:` lines) · lane 5 web panels and sidebar

Read with §7 (the rules), §8 (the rulings) and the cross-lane table in §7.3. Written from a read of both sides of every hunk in the trial merge; "trial" line numbers are lines of the mid-merge file and move as hunks resolve. A row marked for Gate 1 is on the Gate 1 reviewer's list (§7.5).

**Decision labels used below.** No decision labels.

**Other zones are named by their research key:** `toolchain-config` = B.1 · `orchestration-delegation` = B.2 · `store-shell` = B.3 · `remote-auth-deploy` = B.4 · `mcp-tools` = B.5 · `pi-adapter` = B.6 · `textgen-usage` = B.7 · `multirepo-vcs` = B.8 · `markdown-chat` = B.9 · `web-panels-files-diff` = B.10 · `web-sidebar-shell` = B.11 · `labs-settings` = B.12 · `mobile-client` = B.13 · `i18n` = §5.1 · `migrations` = §5.5 · `overlap-audit` = Appendix C · `upstream-digest` = §6.13 and §0.

**Section numbers inside the text below** are this zone's research notes, not the runbook: "section 3" or "§3.x" is the per-hunk doctrine in this file, "section 4" the silently merged list, "section 5" the list for S2; "section 2" (decisions) is mapped to §8.1 above, "section 6" (deploy) is folded into For deploy, "section 7" into §0, "section 8" (follow-ups) into §8.3, and "section 9" (commands) into Appendix A.

### Paths in this zone

- `apps/web/src/components/CommandPalette.logic.ts` · 2m · 4L · [2/0o] [1/6c]
- `apps/web/src/components/CommandPalette.tsx` · 2m · 7L · [1/1c] [1/2c]
- `apps/web/src/components/CommandPaletteThreadItems.tsx` · 1m · 6L · [70/19c]
- `apps/web/src/components/NoProjectsHero.tsx` · 1m · 2L · [4/3c]
- `apps/web/src/components/Sidebar.tsx` · 2m · 21L · [15/1c] [3/1c]
- `apps/web/src/components/ThreadNotificationCoordinator.tsx` · 1m · 5L · [5/2c]
- `apps/web/src/components/ThreadRouteView.tsx` · 1m · 5L · [3/3c]
- `apps/web/src/components/ThreadSearchMatch.tsx` · 1m · 4L · [14/9c]
- `apps/web/src/components/ThreadStatusIndicators.tsx` · 1m · 1L · [36/1c]
- `apps/web/src/components/sidebar/SidebarThreadRow.tsx` · 8m · 39L · [13/2c] [3/3c] [3/1c] [14/1c] [1/1c] [11/6c] [3/1c] [2/0o]
- `apps/web/src/composer-logic.ts` · 2m · 5L · [12/2c] [13/0o]
- `apps/web/src/hooks/useThreadActionMenu.ts` · 2m · 5L · [2/1c] [2/8c]
- `apps/web/src/routes/__root.tsx` · 1m · 6L · [33/19c]
- `apps/web/src/routes/_chat.tsx` · 1m · 2L · [25/5c]
- `apps/web/src/state/entities.ts` · 1m · 1L · [16/4c]

### Per-hunk doctrine

Gate 1 column: "reads" means the Gate 1 reviewer must read the resolved hunk.

#### `apps/web/src/components/sidebar/SidebarThreadRow.tsx` (8 markers, 39 `loom` lines on Loom's side)

Upstream restructured the meta line (#40736): `remoteMachineIcon`, `showsScratchMachine`, `isRemote`, the `currentEnvironmentId` and `scratchMachineLabel` props, the branch line and the `ThreadWorktreeIndicator` import are gone; the line now starts with `props.environmentLabel`. #38282 adds `issueBadge` in the same three places Loom's `LoomRollupBadge` lives. #25269 deleted the sr-only `accessibleTitle` span (the visible title is no longer `aria-hidden`).

| Hunk | Shape | Upstream PR | Loom side | Rule | Resolution | Gate 1 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 @134 | 13/2c | #38282 issue imports | 3d-3 attention, rollup badge, side-thread rows, cache ring, S4 question, agent-started cue imports | U | Keep both import blocks: upstream's `ThreadDetailsIssueRows`, `IssueGlyph`/`issueStatePresentation`, then Loom's 13 lines verbatim. | no |
| 2 @880 | 3/3c | #37893 translation | Loom's "Waiting, never Done" arm for a root with unsettled sub-threads (badge Q5) | U (string wrap) | Keep Loom's arm, wrap the label as upstream wraps its own Waiting: `label: gt("Waiting", { $context: "thread status" })`, `icon: "waiting"`, `className: "text-muted-foreground"`. Same msgid and context as upstream's existing `status === "waiting"` arm, so no new catalog entry. Upstream's side here is the base `isUnread` Done arm that follows in the chain (already present below the marker); do not duplicate it. | reads |
| 3 @1319 | 3/1c | #40736 | S4: a waiting question's header keeps the meta line | D | `!pendingQuestion?.header && // loom: S4` then upstream's `props.environmentLabel === null &&`. Drop `!thread.branch && !showsScratchMachine &&` (base lines upstream deleted). | reads |
| 4 @1332 | 14/1c | #40736 | S4: the question header replaces the line's leading slot | D | `{pendingQuestion?.header ? (<span …>{pendingQuestion.header}</span>) : props.environmentLabel !== null ? (` and upstream's environment arm. Drop Loom's `thread.branch` arm (`ThreadWorktreeIndicator` + `MiddleTruncate`) and the `showsScratchMachine` arm: upstream deleted both, and `ThreadWorktreeIndicator` no longer exists (see `ThreadStatusIndicators.tsx`). Keep both `// loom: S4` comment lines. | reads |
| 5 @1363 | 1/1c | #38282 | 3d-3 rollup badge in the meta line | U | `{prBadge}`, `{issueBadge}`, then `<LoomRollupBadge threadKey={threadKey} /> {/* loom: 3d-3 sub-thread rollup */}` (upstream's indicators first, Loom's last). | no |
| 6 @1388 | 11/6c | #40736 | DL-1721: a row with no meta line carries the badge on its title line | D | Loom's fragment: `<>` + the DL-1721 comment + `<LoomRollupBadge threadKey={threadKey} />` + upstream's `<span aria-hidden …><SidebarProviderStack …/></span>` + `</>`. Drop `{remoteMachineIcon}` (upstream deleted it). | reads |
| 7 @1474 | 3/1c | #38282 | 3d-3 badge on one-line (slim/folder) rows | U | `{multiline ? null : issueBadge}` then Loom's `{multiline ? null : (<LoomRollupBadge …/> /* loom: … */)}`. | no |
| 8 @1665 | 2/0o | #25269 | agent-started cue rail on card rows | A (trap) | Upstream deleted `{accessibleTitle}` (the sr-only span no longer exists anywhere in the file). Keep only `<ThreadStartRail start={threadStart} /> {/* loom: agent-started cue */}`. | reads |

Silently merged Loom lines in this file all survived (44 `loom` lines in the trial working file = 44 in Loom's stage): `RelativeTimeLabel` export (line 175), hover-card pointer handling, `TopStatusIcon` null icon, `loomAttention`/`shouldRecede`/`upstreamTopStatus`/`loomTopStatus` chain (813-901), `startLabel`, the slim-row `ThreadStartRail` (1452), `CacheFuelRing`, `PendingQuestionWaitAge`, both `LoomSideThreadRows`, the search-row rail and `match={{ ...props.searchMatch, … }}`. After resolution no reference to `remoteMachineIcon`, `showsScratchMachine`, `ThreadWorktreeIndicator` or `accessibleTitle` may remain (`rg` them).

#### `apps/web/src/components/Sidebar.tsx` (2 markers, 21 `loom` lines)

| Hunk | Shape | Upstream PR | Loom side | Rule | Resolution | Gate 1 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 @1147 | 15/1c | #37500 (`resolveSidebarRowThreadId` deleted; `resolveListedAncestorThreadRef` in client-runtime) | side-thread sub-rows: a routed side thread selects its host's row | D | `: scopedThreadKey(resolveListedAncestorThreadRef(scopeThreadRef(routeThreadRef.environmentId, sidebarHostRowThreadId(routeThreadRef.threadId, routeThreadRef.environmentId, threads)), threads));` with Loom's `// loom: a side thread's sub-row lives in its host's row, which the shelves retain` comment above the inner call. `resolveListedAncestorThreadRef` is already imported (trial line 70). | reads |
| 2 @3112 | 3/1c | #35202 `SidebarFolderDrop` wraps the sidebar; #33990 moved `<ThreadContextDragGhost />` into `CommandPalette.tsx` | 3d-3 goal rename dialog host | A (trap) + D | Take `<SidebarFolderDrop>` and put `<GoalFormDialogHost /> {/* loom: 3d-3 — the goal rename dialog */}` as its first child. Drop `<>` and `<ThreadContextDragGhost />`: upstream moved the ghost to `CommandPalette.tsx:339` and the closing tag is already `</SidebarFolderDrop>` (trial line 3884). | reads |

Rest of the file merged silently with all 29 `loom` lines intact (archived-root search block 1424-1491, Enter/arrow handling 1584-1614, rendered archived rows 3444-3470, `rowAttentionOf` inbox predicate 661, goal menu 2748-2792). See §4 for the compile break at 2750.

#### `apps/web/src/components/CommandPalette.logic.ts` (2 markers)

| Hunk | Shape | Upstream PR | Loom side | Rule | Resolution | Gate 1 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 @41 | 2/0o | #37315 / #37500 (`isSidebarHiddenThread` deleted, palette uses `isShownUnderParent`) | `isListedThread` import (hide unattended side threads, `/handoff` drafters) | A (trap) | Drop `import { isSidebarHiddenThread } from "./Sidebar.logic";` (base line, export gone). Keep `import { isListedThread } … // loom: hide unattended side threads`. Upstream's `isShownUnderParent` import is already at line 35. | reads |
| 2 @467 | 1/6c | #37315 | `&& isListedThread(thread.source)` on the visible-thread filter | D | `thread.archivedAt === null && !isShownUnderParent({ environmentId: thread.environmentId, threadId: thread.id }, thread.lineage, delegatedUnderParent) && isListedThread(thread.source), // loom: unattended side threads (/handoff drafters) stay hidden unless flagged`. | reads |

#### `apps/web/src/components/CommandPalette.tsx` (2 markers)

| Hunk | Shape | Upstream PR | Loom side | Rule | Resolution | Gate 1 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 @83 | 1/1c | #39393 port forwards (`PlugIcon`) | `RocketIcon` (Deploy Loom action) | U | Both icons, alphabetical: `PlugIcon,` then `RocketIcon, // loom:`. | no |
| 2 @93 | 1/2c | preview actions | `deployableEnvironmentIdsAtom, startDeploy` import | U | Keep both. | no |

Silently merged: Loom's dismiss-all and Deploy Loom action items (1774-1795), `BellOffIcon`, `dismissAllToasts`. Their titles ("Dismiss all notifications", "Deploy Loom") are untranslated literals in an upstream file; see §5.

#### `apps/web/src/components/CommandPaletteThreadItems.tsx` (1 marker, 70/19c)

Upstream re-indented the whole `buildThreadActionItems` call into `buildThreadActionItems({ …, delegatedUnderParent, … }, messages)` (#37315 skip tasks under their parent; #37893 `messages`, `gt("Remote", …)`). Loom's 70 lines are the base call plus one change. Rule D: take upstream's side whole, then change `renderLeadingContent` to Loom's fragment `<><CacheFuelRing thread={thread} /> {/* loom: prompt-cache fuel ring */}<ThreadRowLeadingStatus thread={thread} /></>`. Everything else Loom adds here (archived-root items, `matchedThreadId`/`matchedThreadTitle`, the `messageId === undefined` find skip, `threadItems: [...threadItems, ...archivedThreadItems]`) merged silently and is present (lines 282-371). Gate 1 reads.

#### `apps/web/src/composer-logic.ts` (2 markers)

| Hunk | Shape | Upstream PR | Loom side | Rule | Resolution | Gate 1 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 @28 | 12/2c | #33131 removed plan mode (`"plan" \| "default"` gone) | `!` thread trigger kind (DL-750); `/handoff`, `/retro` intercepts | D | `export type ComposerTriggerKind = "path" \| "pull-request" \| "slash-command" \| "skill" \| "thread";` and `export type ComposerSlashCommand = "model" \| "side" \| "btw" \| "clear" \| "handoff" \| "retro";` with both `// loom:` comments. | reads |
| 2 @364 | 13/0o | #33131 deleted `parseStandaloneComposerSlashCommand` | Loom's narrowed `Exclude<…>` signature | A (trap) | Drop the whole function and its Loom comment: upstream deleted it with plan mode, and the merged `useComposerSend.ts` no longer imports it (no reference in the trial tree outside this hunk). | reads |

Silently merged and intact: `threadTriggerStart` and the `!` scan-back in `detectComposerTrigger` (trial 139-327).

#### `apps/web/src/hooks/useThreadActionMenu.ts` (2 markers)

| Hunk | Shape | Upstream PR | Loom side | Rule | Resolution | Gate 1 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 @103 | 2/1c | #31418 (`updateThreadMetadata` replaced by `regenerateThreadTitle`) | goal submenu hook | U | `const { runGoalMenuAction } = useLoomGoalActions(); // loom: …` then upstream's `regenerateThreadTitle` declaration. Drop Loom's `updateThreadMetadata` line (base line; unused after merge). | no |
| 2 @135 | 2/8c | #32507 "the thread menu works for an older settled thread the sidebar hasn't loaded" (toast when not loaded; `useOpenThreadFamily` in `ThreadRouteView`) | `readRouteThread` fallback for a thread the shell has not joined (Loom commit 1d010d2041) | U | `const thread = readThreadShell(threadRef) ?? readRouteThread?.() ?? null; // loom` then upstream's `if (!thread) { failureToast(…); return; }`. Upstream's #32507 fixes the same symptom by mounting the open thread's family; Loom's fallback also covers an archived root opened shell-less, so keep both (follow-up §8 to check whether Loom's becomes dead). | reads |

#### `apps/web/src/components/ThreadStatusIndicators.tsx` (1 marker, 36/1c)

Trap. Loom's 36 lines are upstream's base `ThreadWorktreeIndicator` (deleted by #40736) plus Loom's `export` on `ThreadStatusLabel`. Resolution: drop `ThreadWorktreeIndicator` entirely; write `// loom: exported for ThreadTabsStrip.` + `export function ThreadStatusLabel({`. `ThreadTabsStrip.tsx` is the only importer and calls `<ThreadStatusLabel status={…} compact />`, which still type-checks (upstream's `ThreadStatusPill` from `resolveThreadStatusPill`). Gate 1 reads.

#### `apps/web/src/components/ThreadSearchMatch.tsx` (1 marker, 14/9c)

Upstream #37893 only wrapped `"You:"`/`"Agent:"` in `<T>` (and the hint label in `SearchMatchHintLine`, merged silently). Loom's side replaces those labels with `threadSearchExcerptLabel(match)` (every indexed source: title, report, brief…) and adds a "Sub-thread:" line. Rule D: take Loom's shape; translate its two literals in place so the `no-untranslated-copy` lint passes: `<T>Sub-thread: <Var>{subThreadTitle}</Var></T>`; the `label` string comes from client-runtime (`packages/client-runtime/src/state/loom/threadSearch.ts:22-28`, untranslated) and follows whatever the i18n researcher rules for Loom strings. Mobile twin `apps/mobile/src/features/threads/thread-search-match.tsx` (owned by `mobile-client`): upstream's change there is the same wrap only (`gt("You:", { $context: "label before a search snippet the user wrote" })`), so both resolve the same way: Loom's label function wins, upstream's wrap is dropped with the literal it wrapped. Gate 1 reads.

#### `apps/web/src/components/ThreadNotificationCoordinator.tsx` (1 marker, 5/2c)

#37893 wrapped "Guest request"/"Input needed" in `m(msg(…))`. Loom adds the S4 question header in the alert body. Rule U: upstream's two `m(msg(…))` lines, then Loom's three lines (comment, `header`, `body`) verbatim. The child-completion suppression (`kind === "completion" && state.raw.workstream?.parentThreadId`) and both `body` uses merged silently and are present. Gate 1: no.

#### `apps/web/src/components/ThreadRouteView.tsx` (1 marker, 3/3c)

#35761 nests `<HiddenThreadContext value={background}>` inside `BackgroundThreadContext`. Rule U: Loom's comment and `<ThreadTabsStrip activeRouteRef={serverThreadRef} />`, then upstream's nested contexts. The shell-less archived-root wait (`useAwaitingShelllessThread`, `renderState` override) and `useThreadTabsSync` merged silently and sit after upstream's new `useOpenThreadFamily` call (#32507, line 116). Both now fire for an archived root opened from search (it is "unlisted"); see §4. Gate 1: no.

#### `apps/web/src/components/NoProjectsHero.tsx` (1 marker, 4/3c)

#37893 adds `const gt = useGT();` and `gt("Home")`. Rule U: keep Loom's two comment lines and `export function NoProjectsHero({ header }: { header?: ReactNode }) {`, then `const gt = useGT();` and `const contentArea = workspaceAreaProps("home", 1, gt("Home"));`. The `ReactNode` import and `{header /* loom */}` merged. Consumer `routes/_chat.index.tsx` passes `header={<ThreadTabsStrip activeRouteRef={null} />}` (merged, intact). Gate 1: no.

#### `apps/web/src/routes/__root.tsx` (1 marker, 33/19c)

What upstream added at the root in range: no i18n provider here (that is `AppRoot.tsx`); `ConnectDeviceApprovalCoordinator` (#36419 approve new T3 Connect devices), `UseInAnotherAppDialogHost` (#33196 MCP), `/approve-agent` as a bare route (#33600), the chunk-reload "Try again" (#35806), lucide icons replacing `MorphIcon` in the error view (#33985), and, structurally, an `appHosts` fragment mounted both inside `FirstRunGate` and on `/welcome` (Settings can reopen Welcome mid-session; #33209), with `ThemeEditorHost` moved outside both. Rule D: take upstream's side whole; insert Loom's six lines into `appHosts` right after `<SnapShotCoordinator />` (where they sat before): `{/* loom: a /handoff failure reaches you on any thread */}<HandoffToastCoordinator />`, `{/* loom: the deploy warning, … */}<DeployToastCoordinator />`, `{/* loom: the hub login dialog, … */}<HubLoginDialogHost />`. Consequence: they now also mount on `/welcome`, which is harmless (toasts and a dialog host). Loom's dev `/preview` auth bypass in `beforeLoad` merged silently (line 70) and still works because `RootRouteBranch` returns `<Outlet />` for any status other than authenticated or hosted-static. Gate 1 reads.

#### `apps/web/src/routes/_chat.tsx` (1 marker, 25/5c)

#28703 moved the background-target state into `hooks/useShownThreadRouteTarget.ts`. Loom's 25 lines are that base state plus `useThreadTabKeyboard`. Rule D: take upstream's side; add `// loom: centre-panel thread tabs` + `import { useThreadTabKeyboard } from "../loom/useThreadTabKeyboard";` and, after `const { shownTarget, modalOpen } = useShownThreadRouteTarget();`, `useThreadTabKeyboard(shownTarget?.kind === "server" && !modalOpen ? shownTarget.threadRef : null); // loom: tab-strip keyboard bindings …`. This equals Loom's old argument (the raw route target, which is null on a modal page) without a second router read. Do not keep `threadRouteTargetKey`, `useState`, `useMatches` or `useThreadRouteTarget` here (lint: unused). Gate 1 reads.

#### `apps/web/src/state/entities.ts` (1 marker, 16/4c)

Superseded. #24583 added `useThreadError(ref)` (trial upstream line 217), identical to Loom's `useThreadSyncError` (DL-118, same `environmentThreadDetails.errorAtom`), and `ChatView` now feeds it into a new `"failed"` sync phase ("Could not sync messages"). Resolution: take upstream's `readDelegatedUnderParent`; delete Loom's `useThreadSyncError` and `EMPTY_SYNC_ERROR_ATOM`. Its one consumer is `apps/web/src/components/chat/ThreadNow.tsx:5,83` (conflicted, owned by `markdown-chat`): re-point to `useThreadError`. Keep ThreadNow's diagnostic line itself: upstream's `"failed"` phase applies only once detail exists, while Loom shows the error during the initial "Loading messages..." too. If `markdown-chat` keeps Loom's import, keep Loom's hook instead (Rule U) rather than break the build. Gate 1 reads.

#### The two "lost" `Sidebar.logic.ts` exports

| Name | Whose | Removed by | Replacement | Consumers in Loom hunks |
| --- | --- | --- | --- | --- |
| `isSidebarHiddenThread` | Upstream's (exported at base, `Sidebar.logic.ts:566`); Loom only imported it | un-exported by #37315 `b732621b51`, deleted by #37500 `45dedf2955` | `isShownUnderParent(ref, lineage, delegatedUnderParent)` from `@t3tools/client-runtime/state/threads` (also hides tasks a linked environment delegated under a listed parent) | `CommandPalette.logic.ts` hunks 1-2 (above). `CommandPalette.tsx:507`'s use was a base line upstream already replaced (#30428). No Loom-only file uses it. |
| `resolveSidebarRowThreadId` | Upstream's (base `Sidebar.logic.ts:573`) | #37500 `45dedf2955` | `resolveListedAncestorThreadRef(ref, threads)` from `@t3tools/client-runtime/state/threads` (`threadShell.ts:77`; takes and returns a `ScopedThreadRef`, follows `delegatedFrom` too) | `Sidebar.tsx` hunk 1 (above). No Loom-only file uses it. |

`rg -n "isSidebarHiddenThread|resolveSidebarRowThreadId"` over the trial tree finds only those two conflicted hunks; after resolution it must find nothing.

### Silently merged files Gate 2 reads in this zone

| File | `loom` lines (Loom = trial) | Why |
| --- | --- | --- |
| `apps/web/src/components/Sidebar.tsx` (silent sections) | 29 = 29 | **Compile break.** Line 2750 `showWithLoomGoalMenu(api, loomGoal)(buildThreadActionMenuItems(…), position, source)`: upstream's call now passes `source: ContextMenuSource` (#37727, keyboard-opened menus select their first item; `packages/contracts/src/ipc.ts` `show(items, position?, source?)`), but Loom's curried helper takes `(items, position?)`. Fix in `apps/web/src/loom/sidebarGoalActions.ts:40-59`: add `source?: ContextMenuSource` and pass it to `api.contextMenu.show(…, position, source)`. Otherwise the archived-search block, keyboard navigation and goal-menu dispatch still sit in code that means what they assume (checked lines 1408-1491, 1569-1614, 3376-3480). Archived rows get no right-click menu (#31545 added one for listed search rows); expected, they have no shell. |
| `apps/web/src/components/Sidebar.logic.ts` | 8 = 8 | `filterSidebarV2VisibleThreads` still ANDs Loom's `isTopLevelRow(thread.source, hosted)` onto upstream's unchanged `!isShownUnderParent(…)` predicate; `sortSidebarV2ProjectGroups` still calls it (needs Loom's `source` pick); `resolveSidebarRowAccessibility` still joins `startLabel`. No change in meaning. |
| `apps/web/src/components/ThreadRouteView.tsx` (silent sections) | Loom's archived-root wait | Upstream's `useOpenThreadFamily(serverThreadRef, bootstrapComplete && unlistedThreadRef !== null)` (#32507) and Loom's `useAwaitingShelllessThread` both fire for an archived root opened from search. Compiles and both are idempotent; whether `threadFamilies.mount` already brings an archived root into the shell rows (which would make Loom's shell-less fetch redundant) is a `store-shell` question. Live check: open an archived root from search, confirm one "Loading" then the timeline, no bounce home. |
| `apps/web/src/routes/_chat.index.tsx` | 5 = 5 | `NoProjectsHero header=` and `DraftStartError`'s strip intact; upstream's index flow unchanged around them. |
| `apps/web/src/components/chat/ChatHeader.tsx` | 11 = 11 | Passes `readRouteThread` to `useThreadActionMenu`; still the only `<ChatHeader>` call site besides its test, so the required prop does not break a new upstream caller (#39515's `SideThreadPane` does not render `ChatHeader`). |
| `apps/web/src/hooks/useThreadActions.ts` | 3 = 3 | `archiveThread(target, { onArchived?, thread? })` Loom option intact; `useThreadActionMenu.ts:351` passes `thread`. |
| `apps/web/src/contextMenuFallback.ts` | 1 = 1 | Loom's `target` icon for the Goal submenu intact; `ContextMenuItem` still has `children`, `icon`, `separatorBefore`. |

Already lost or made wrong in the trial tree: only the `source` argument break above. Not lost but dead: see §8 on the child-completion suppression.

### Left for the integration tracks (S2)

- **Typecheck:** after the marker resolutions, expect exactly one error from silent code in this area, `Sidebar.tsx:2750` (Expected 1-2 arguments, but got 3), fixed in `sidebarGoalActions.ts`. Any remaining `ThreadWorktreeIndicator`, `remoteMachineIcon`, `showsScratchMachine`, `accessibleTitle`, `parseStandaloneComposerSlashCommand`, `isSidebarHiddenThread` or `resolveSidebarRowThreadId` reference is a resolution mistake.
- **i18n lint (`t3code/no-untranslated-copy`), Loom literals in upstream files in this area:** `SidebarThreadRow.tsx` "Waiting" (fixed in hunk 2 by `gt`), `ThreadSearchMatch.tsx` "Sub-thread:" (fixed in its row), `CommandPalette.tsx` "Dismiss all notifications" and "Deploy Loom", `CommandPaletteThreadItems.tsx` "Untitled thread", `ThreadNotificationCoordinator.tsx`'s template body (no literal). The Loom-only files `sidebarGoalActions.ts` ("Goal", "Open goal tasks", "Rename goal…", "Could not rename the goal"), `LoomRollupBadge.tsx`, `SideThreadRows.tsx` ("Running") are flagged too (i18n scratch: `trial-perfile.txt`). Policy: §5.1 (Loom-only files are excluded; Loom strings inside upstream files are wrapped).
- **Tests:** upstream added `apps/web/src/hooks/useThreadActionMenu.test.ts` (calls the hook without `readRouteThread`; the prop is optional, compiles). `Sidebar.logic.test.ts` lost its `resolveSidebarRowThreadId` cases upstream (Rule T: take upstream's). No Loom test in this area references a deleted symbol (`rg` over `apps/web/src` test files: zero hits for the deleted names).
- **Knip / imports:** dropping `useThreadSyncError` removes an export. The trial `ThreadStatusIndicators.tsx` already lost the `FolderGit2Icon` and `formatWorktreePathForDisplay` imports (upstream's import list merged), so keeping Loom's side of that hunk would not compile: one more reason it must go.
