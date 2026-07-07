---
manager_sessions:
  - id: 5d1b9fcb-6cbd-486f-a86c-759840d7699a
    role: plan
    authored_at: 2026-07-07T12:32:33.235Z
---

# Evacuate fork components from upstream chat files (web)

## Intent

Loom is a fork of T3 Code that continually merges upstream. Upstream owns and
heavily churns `apps/web/src` chat files; the fork currently defines whole
component bodies inline in them. This plan moves those bodies into fork-owned
files so the residual intrusion in each upstream file is thin — imports, render
lines, prop threading — and future upstream merges conflict on a handful of
one-line hunks instead of 350-line component blocks.

**Zero visual or behavioural change.** No upstream code is refactored; the only
edits to upstream-owned lines are three `export` keywords (justified below).

**Why now / insurance value:** `docs/upstream-sync/02-fork-deltas.md` §H flags
the reasoning display as a strong REDO-CLEAN candidate — upstream has its own
reasoning rendering that may eventually win. After this extraction, adopting
upstream's version is "delete one fork file + drop ~10 thin hunks", not
"unpick 346 inline lines". The same holds for the spawn/consult cards.

Baseline for all diff references: merge-base `600972084` (`git diff 600972084 HEAD -- <file>`).

## Target layout — one fork-owned directory

Create `apps/web/src/loom/` as the single fork-owned home for evacuated web
code. (Scout report recommends this dir as the future home for
`useLoomThreadExtensions` and the Sidebar work too — both explicitly out of
scope here, but the dir choice anticipates them.)

New files:

| File | Contents |
|---|---|
| `apps/web/src/loom/loomScrollStore.ts` | `ScrollToDispatchRequest`, `ConsultRevealRequest`, `useLoomScrollStore` (zustand) |
| `apps/web/src/loom/loomScrollStore.test.ts` | small unit test (request sets both fields; clears are idempotent) |
| `apps/web/src/loom/useScrollToDispatch.ts` | the one-shot scroll effect as a hook |
| `apps/web/src/loom/ReasoningBlock.tsx` | `ReasoningBlock` |
| `apps/web/src/loom/SpawnCardSection.tsx` | `SpawnCardSection` + `spawnChildStatus` |
| `apps/web/src/loom/ConsultCardSection.tsx` | `ConsultCardSection` + `ConsultCard` + `CONSULT_ANSWER_CLAMP_CHARS` |
| `apps/web/src/loom/ThreadLineageBreadcrumb.tsx` | `ThreadLineageBreadcrumb` + `LineageSegmentChip` + `MAX_VISIBLE_LINEAGE_SEGMENTS` |

File split is a suggestion — coder may merge the three timeline-card files if
that reads better, but keep the breadcrumb and the store separate (different
hosts, independent deletion).

Move component bodies verbatim (including their doc comments); do not restyle
or "improve" them in flight.

---

## Extraction 1 — `MessagesTimeline.tsx` (14 hunks, +409)

Hunk-by-hunk inventory at merge-base line numbers:

| # | Hunk | What it is | Action |
|---|---|---|---|
| 1 | `@@ -3,9` | imports: `ThreadId`, `scopeThreadRef`, `useNavigate` | **Reverts** — all serve extracted components; restore upstream import lines exactly |
| 2 | `@@ -30,8` | imports: `WorkLogEntry`, `SidebarThreadSummary`, `useThreadShells`, `buildThreadRouteParams`, `useClientSettings` | **Mostly reverts** — only `useClientSettings` stays (reasoning setting read); rest move to fork files |
| 3 | `@@ -41,14` | lucide icons `BrainIcon`, `GitBranchIcon`, `Loader2Icon`, `MessageCircleQuestionMarkIcon` | **Reverts** — icons move to fork files |
| 4 | `@@ -96,7` | `type ReasoningDisplayMode` added to settings import | **Keep** (threading) |
| 5 | `@@ -122,6` | `reasoningDisplay` field on `TimelineRowSharedState` | **Keep** (threading) |
| 6 | `@@ -318,6` | ~28-line one-shot scroll-to-dispatch effect | **Extract** → `useScrollToDispatch(rows, listRef, routeThreadKey)`; residual = 1 hook call |
| 7 | `@@ -406,9` | `useClientSettings(reasoningDisplay)` + `sharedState` field | **Keep** (threading) |
| 8 | `@@ -424,6` | `reasoningDisplay` in memo deps | **Keep** (threading) |
| 9 | `@@ -813,6` | 2 row-kind branches in `TimelineRowContent` (`spawn`, `consult`) | **Keep** — render lines now reference imported components |
| 10 | `@@ -976,11` | `AssistantTimelineRow`: `hasReasoning` + placeholder suppression + `<ReasoningBlock …/>` render | **Keep** (~8 lines) — render line references imported component |
| 11 | `@@ -1016,6` | **+344 lines**: `ReasoningBlock`, `SpawnCardSection`, `spawnChildStatus`, `ConsultCardSection`, `CONSULT_ANSWER_CLAMP_CHARS`, `ConsultCard` | **Extract** — the whole block moves to fork files |
| 12 | `@@ -1623,7` | `UserMessageReviewCommentCard` `comment.kind === "line"` guard | **Out of scope** (mdx-plan-annotation feature) — do not touch |
| 13 | `@@ -1644,7` | same, line guard on diff render | **Out of scope** — do not touch |
| 14 | `@@ -1653,6` | mdx-anchor quoted-text block | **Out of scope** — do not touch |

New residual (fork import block): 1 import hunk near the top importing
`ReasoningBlock`, `SpawnCardSection`, `ConsultCardSection`,
`useScrollToDispatch` from `~/loom/…`.

### Dependencies the extracted code has on the host file

These are the only non-mechanical decisions; everything else the extracted
components use is already importable (`ChatMarkdown`, `cn`, lucide icons,
`useNavigate`, `buildThreadRouteParams`, `scopeThreadRef`,
`parseScopedThreadKey`, `useThreadShells`, `SidebarThreadSummary`,
`WorkLogEntry` from `session-logic`, `MessagesTimelineRow` from
`MessagesTimeline.logic.ts`, `ReasoningDisplayMode` from contracts settings).

1. **`TimelineRowCtx`** (module-private context, merge-base line 145).
   `ReasoningBlock`, `SpawnCardSection`, `ConsultCard` all `use(TimelineRowCtx)`.
   **Decision: add `export` to the existing declaration** — a one-word hunk on
   a stable upstream line. Do NOT move the context or the
   `TimelineRowSharedState` interface into a fork file (upstream edits that
   interface; moving it would convert upstream churn into fork-file
   conflicts). The interface itself does not need exporting — `use(TimelineRowCtx)`
   infers its type structurally.
2. **`WorkingTimer`** (component, merge-base ~1082) and
   **`formatWorkingTimer`** (pure helper, merge-base ~1701) — used by
   `ReasoningBlock`'s header. **Decision: add `export` to both** (two more
   one-word hunks) rather than duplicating ~50 lines into the fork file.
3. **`TimelineMessage` type** (module-private alias). Do NOT export it —
   re-derive in the fork file:
   `type TimelineMessage = Extract<ReturnType<typeof deriveTimelineEntries>[number], { kind: "message" }>["message"]`
   with `deriveTimelineEntries` imported from `~/session-logic`.
4. **`listRef` type** for the hook: `LegendListRef` from
   `@legendapp/list/react` — importable directly.

**Import cycle note:** the loom files import `TimelineRowCtx` / `WorkingTimer`
/ `formatWorkingTimer` from `MessagesTimeline.tsx`, which imports the loom
components — a module cycle. It is runtime-safe: every cross-import is
referenced only inside render functions (live bindings resolved at call time),
never during module evaluation. tsgo and Vite both handle this; no `no-cycle`
lint rule is configured in this repo. If `vp check` ever objects, the fallback
is to duplicate `WorkingTimer`/`formatWorkingTimer` (~50 pure lines) into
`ReasoningBlock.tsx` and pass `markdownCwd`/`threadRef`/`skills` as props from
the (already ctx-reading) `AssistantTimelineRow` render site — but do not do
this pre-emptively.

### Test file

`MessagesTimeline.test.tsx` currently adds `reasoningDisplay: "collapsed"` to
`buildProps()` — but `MessagesTimelineProps` has no such prop (the component
reads the setting via `useClientSettings`); the line is dead. **Remove it**,
reverting the test file to upstream exactly.

### Expected result

`git diff 600972084 -- apps/web/src/components/chat/MessagesTimeline.tsx`
after this extraction: ~10 hunks, no hunk larger than ~10 lines, net inline
fork addition ≤ ~50 lines (was +409), zero component bodies. Hunks 12–14
(mdx) unchanged.

---

## Extraction 2 — `ChatHeader.tsx` (6 hunks, +124)

| # | Hunk | What it is | Action |
|---|---|---|---|
| 1 | `@@ -6,9` | imports: `ReactNode`, lucide `ChevronRightIcon`/`CornerLeftUpIcon`, `LineageSegment`, `cn` (moved up) | **Mostly reverts** — only the `LineageSegment` type import stays (props typing) plus a new `ThreadLineageBreadcrumb` import; restore `cn` to its original merge-base position and drop `ReactNode`/lucide |
| 2 | `@@ -16,7` | `cn` import removed from original position | **Reverts** (see above) |
| 3 | `@@ -30,6` | 3 props on `ChatHeaderProps` (`threadLineage`, `threadRole`, `onNavigateToThread`) | **Keep** |
| 4 | `@@ -40,6` | **+111 lines**: `MAX_VISIBLE_LINEAGE_SEGMENTS`, `LineageSegmentChip`, `ThreadLineageBreadcrumb` | **Extract** → `~/loom/ThreadLineageBreadcrumb.tsx` |
| 5 | `@@ -64,6` | 3 destructured params | **Keep** |
| 6 | `@@ -92,6` | 5-line `<ThreadLineageBreadcrumb …/>` render | **Keep** |

Dependency check: the extracted components use `Tooltip`/`TooltipPopup`/
`TooltipTrigger` (`~/components/ui/tooltip`), `cn`, lucide icons,
`LineageSegment` (`~/threadRouteLineage` — fork-owned), `ThreadId` (contracts).
Nothing private to the host file — clean cut, no export hunks, no cycle.
`ChatHeader.test.ts` is untouched (tests `shouldShowOpenInPicker` only).

Expected result: ~4 thin hunks, net inline ≤ ~15 lines (was +124).

---

## Extraction 3 — scroll slice out of `uiStateStore.ts` (5 hunks, +49)

The `UiScrollState` slice (`scrollRequest`, `consultReveal`,
`requestScrollToDispatch`, `clearScrollRequest`, `clearConsultReveal`) is
purely Loom state, never persisted (`parsePersistedState` hard-resets it to
null — preserve that ephemerality by simply not persisting the new store).

Create `apps/web/src/loom/loomScrollStore.ts`: a standalone zustand store with
the two request interfaces and three actions, bodies copied verbatim.

**Complete reader/writer inventory** (verified via repo-wide grep for
`scrollRequest|consultReveal|requestScrollToDispatch|clearScrollRequest|clearConsultReveal|UiScrollState|ScrollToDispatchRequest|ConsultRevealRequest`):

| File | Usage | Change |
|---|---|---|
| `apps/web/src/uiStateStore.ts` | slice definition (5 hunks) | Remove entirely — file reverts to upstream **exactly** (verify: `git diff 600972084 -- apps/web/src/uiStateStore.ts` is empty) |
| `apps/web/src/uiStateStore.test.ts` | 2 hunks adding `scrollRequest: null, consultReveal: null` literals | Remove — file reverts to upstream exactly |
| `apps/web/src/components/WorkstreamPanel.tsx` (fork-owned) | writer: `requestScrollToDispatch` at lines 131/167 (`openDispatch`) | Swap to `useLoomScrollStore` |
| `apps/web/src/components/chat/MessagesTimeline.tsx` | readers: scroll effect (`scrollRequest`/`clearScrollRequest`, lines 337–357) and `ConsultCard` (`consultReveal`/`clearConsultReveal`, lines 1299–1300) | Both readers move out anyway via Extraction 1 — the hook and `ConsultCard` subscribe to `useLoomScrollStore` in their fork files. The host's pre-existing upstream `useUiStateStore` usages (changed-files expansion, line 1625+) are untouched |

No other references exist. Sequencing tip: land Extraction 1 and 3 in one
commit or do 3 first — the timeline scroll effect is the only consumer that
straddles both.

### Behaviour-preservation verification for the state move

- The slice was never persisted → no localStorage migration concerns.
- Unit: keep `uiStateStore.test.ts` green after revert; new
  `loomScrollStore.test.ts` covers request-then-clear semantics (including the
  "clear is a no-op when already null" identity behaviour from the current
  implementation — preserve the `state.scrollRequest ? … : state` guards).
- Manual smoke (single dev-session pass):
  1. Reasoning blocks: with `reasoningDisplay` collapsed/expanded/off — block
     expands while streaming, collapses after (collapsed mode), toggles by
     click, absent when off.
  2. Workstream graph: click an orchestrator (bridge) node → navigates to the
     dispatching thread and scrolls to the spawning turn (one-shot: navigating
     away and back does not re-scroll).
  3. Workstream graph: click a consult edge → navigates, scrolls, and the
     matching consult card auto-expands once (and can be re-collapsed).
  4. Spawn card: expand, click a child row → navigates to the sub-thread.
  5. Chat header: lineage breadcrumb renders on a sub-thread, elides >3
     segments, chips navigate, role chip shows.

---

## Execution notes for the coder

- Single coder, one branch. Suggested commit split: (a) breadcrumb extraction,
  (b) scroll store + timeline extraction, or one commit for all — coder's call.
- Move bodies verbatim; the win is measured in the residual diff, not in
  cleaning the moved code. Resist renaming, retyping, or restyling.
- After each extraction, diff the upstream file against the merge-base and
  check it against the hunk tables above — every hunk should be either in the
  "keep" list or gone.
- Import paths: use the `~/` alias (`~/loom/…`) as the host files already do
  for `~/uiStateStore` etc.

## Reviewer checklist

1. `git diff 600972084 -- apps/web/src/uiStateStore.ts apps/web/src/uiStateStore.test.ts apps/web/src/components/chat/MessagesTimeline.test.tsx` → **empty**.
2. `git diff 600972084 -- apps/web/src/components/chat/MessagesTimeline.tsx` →
   only the "keep" hunks from the Extraction 1 table + the fork import block +
   three `export` keywords + untouched mdx hunks 12–14; no component bodies.
3. `git diff 600972084 -- apps/web/src/components/chat/ChatHeader.tsx` → only
   the four thin "keep" hunks.
4. Extracted file contents match the pre-move bodies (verbatim modulo imports).
5. `vp check` green; `vp run -r typecheck` green (repo root; or
   `pnpm typecheck`); `vp run --filter @t3tools/web test` green.
6. Manual smoke list above (or explicit note of which items were exercised).

## Out of scope — do not touch

- `Sidebar.tsx` goal-list extraction (separate future work).
- `ChatView.tsx` / `useLoomThreadExtensions` hook (separate future work).
- `rightPanelStore.ts`, `RightPanelTabs.tsx` (accepted UPSTREAM-ENTANGLED).
- `MessagesTimeline.logic.ts` fork additions (append-only, low conflict —
  stays).
- The mdx-plan-annotation hunks in `MessagesTimeline.tsx` (hunks 12–14).
- Any behaviour, styling, or naming change to the moved components.
