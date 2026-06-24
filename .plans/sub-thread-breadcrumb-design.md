# Sub-thread breadcrumb / "navigate up to parent" — design recommendation

## Problem

A thread can spawn child **sub-threads** (`thread.create` with
`parentThreadId` + `role` + `goal`, see `WorkstreamPanel.spawnChild`). Sub-threads
are deliberately hidden from the left sidebar / goal tree
(`selectSidebarThreadsForProjectRef` filters to `parentThreadId === null`) and are
only surfaced in the right-panel **Workstream** Board/Graph rendered on the parent.

The gap: once you navigate **into** a sub-thread (via a Workstream card, the graph,
or a deep link), the only entry point that knew about the parent — the parent's
Workstream panel — is no longer on screen. There is no breadcrumb, no "back to
orchestrator" affordance, and the child is not in the sidebar. The user is stuck
in a leaf with no path back up the lineage. Nesting makes this worse: spawn depth
can be > 1, so there can be a whole chain (`grandparent → parent → this child`) and
no single "parent" link is sufficient.

## Relevant code (what's already there)

- **Header**: `apps/web/src/components/chat/ChatHeader.tsx` renders the thread title
  (`activeThreadTitle`) plus an optional `GoalHeaderSection` pill (`goalSlug`).
  This is the natural, already-established home for thread-scoped context chips.
  It is invoked from `apps/web/src/components/ChatView.tsx` (~line 4526) where
  `activeThread` (a full `Thread`, including `parentThreadId` / `role` / `goal`) is
  already in scope.
- **Routing**: `apps/web/src/threadRoutes.ts` → `buildThreadRouteParams(scopeThreadRef(env, id))`
  returns `{ environmentId, threadId }` for the route `"/$environmentId/$threadId"`.
  `WorkstreamPanel.openThread` already navigates **down** with exactly this shape;
  going **up** is the mirror image (navigate to the parent's ref instead of the
  child's).
- **Data model**: `apps/web/src/types.ts` — `Thread` (and `ThreadShell` /
  `SidebarThreadSummary`) carry `parentThreadId: ThreadId | null`, `role`, `goal`,
  `archivedAt`, `title`, `environmentId`.
- **Lookups**: `apps/web/src/storeSelectors.ts` — `createThreadSelectorByRef`
  (full `Thread` by `ScopedThreadRef`) and `createThreadSelectorAcrossEnvironments`
  (by id, scans all envs). The store also holds `threadShellById` per environment
  (`store.ts`), which is the cheapest source for walking the lineage chain: each
  shell has `parentThreadId`, `title`, `role`, `goal`, `archivedAt`. Parents are
  top-level threads, so they are present in both `threadShellById` and
  `sidebarThreadSummaryById`.
- **Right panel**: `apps/web/src/rightPanelStore.ts` exposes
  `open(ref, "workstream")` and `show(ref)`. The Workstream surface kind already
  exists (`RIGHT_PANEL_KINDS` includes `"workstream"`).

Key facts that constrain the design:

- A child always lives in the **same environment** as its parent — `thread.create`
  in `WorkstreamPanel` reuses `activeThread.environmentId` and never sets a
  cross-env parent. So lineage resolution can stay scoped to the active thread's
  `environmentState`; a cross-env parent is a "should never happen" we only guard
  against, not a supported flow.
- `parentThreadId` is set only for sub-threads, so `parentThreadId != null` is the
  exact, sufficient signal for "this is a sub-thread".

## Design options

### Option A — Single "↑ parent" chip in ChatHeader (minimal)

Add one pill to the left cluster of `ChatHeader`, next to the title, shown only
when `activeThread.parentThreadId != null`. It shows a back/branch icon + the
parent's title (and optionally the child's own `role`). Clicking navigates to the
parent's `/$environmentId/$threadId`.

- **Pros**: smallest surface; mirrors the existing `GoalHeaderSection` pattern
  one-for-one; one new selector (parent shell by id); trivial to reason about.
- **Cons**: only shows the immediate parent. In a `>1` deep chain you can still
  only step up one level at a time, and you get no sense of "where am I in the
  tree". You also don't jump straight to the orchestrator (root).

### Option B — Full lineage breadcrumb chain in ChatHeader (recommended)

Render a compact breadcrumb of the **ancestor chain** in `ChatHeader`, e.g.

```
[Orchestrator title] › … › [parent title] › reviewer
```

Build the chain by walking `parentThreadId` up through the active environment's
`threadShellById` until `parentThreadId == null` (the orchestrator root) or a
missing/cycle guard trips. Each ancestor is a clickable segment that navigates to
that thread; the final non-clickable segment is the current child's own `role`
(or "sub-thread" when role is null). The root segment carries an "Orchestrator"
affordance/label so the user always has a one-click path to the top.

Collapse long chains: show root + immediate parent and elide the middle as a `…`
(matching how the Workstream graph already labels the root "Orchestrator" and
truncates titles). Tooltip on each segment shows the full title; the `…` can
tooltip the elided titles.

- **Pros**: solves nesting directly (jump to any ancestor, including straight to
  the orchestrator); gives spatial context ("I am 2 deep under X"); still lives in
  the one obvious place and reuses existing navigation + selector patterns; degrades
  gracefully to Option A's behaviour when depth is 1.
- **Cons**: slightly more layout logic (elision, responsive truncation) and one
  small pure helper to build/validate the chain. Marginally more than A, but the
  nesting requirement is explicitly in scope, so A would be under-built.

### Option C — Breadcrumb + auto-reveal child in parent's Workstream panel

Option B, plus: navigating up to a parent also opens the parent's right-panel
Workstream surface (`rightPanelStore.open(parentRef, "workstream")` /
`show(parentRef)`) and highlights/scrolls to the card for the child you came from,
so the round-trip is legible ("you came from this sub-thread").

- **Pros**: most polished; closes the loop between the two views.
- **Cons**: requires new state — a "highlight this child id" signal the Workstream
  panel reads on mount — plus scroll-into-view and a transient highlight style.
  `WorkstreamPanel` currently has no concept of a focused/highlighted card and no
  per-card refs. This is real new surface (a store field or route search param +
  panel wiring) for a polish win, and risks auto-opening a panel the user didn't
  ask for on every up-navigation.

## Recommendation

**Adopt Option B now; treat the auto-reveal half of Option C as a follow-up.**

Option B is the smallest change that actually satisfies the stated requirement
(nested chains, jump to orchestrator, consistent home, edge-case-safe). It reuses
the `GoalHeaderSection` pill pattern, the existing `buildThreadRouteParams` +
`navigate` flow already used by `WorkstreamPanel`, and a single new pure helper for
chain construction. Option A is strictly weaker on the nesting requirement that is
explicitly in scope; Option C's auto-reveal adds new cross-component state and an
opinionated side effect (force-opening a panel) that should be a deliberate,
separately-reviewed follow-up rather than bundled in.

Recommended behaviour details:

- **Visibility**: render the breadcrumb only when `activeThread.parentThreadId != null`.
  For root/orchestrator threads, render nothing new (no behavioural change).
- **Content**: ancestor titles as clickable segments, root segment marked as the
  orchestrator, trailing current-`role` label (fallback `"sub-thread"`, matching
  `WorkstreamPanel.getRoleLabel`). Keep `goal` out of the breadcrumb — it's already
  surfaced on the Workstream card and would bloat the header; optionally expose the
  child's own `role`/`goal` via the segment tooltip.
- **Navigation**: clicking a segment calls
  `navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(scopeThreadRef(environmentId, ancestorId)) })`,
  mirroring `WorkstreamPanel.openThread`.
- **Auto-open Workstream on the parent (lightweight version)**: acceptable to do the
  *cheap* half of Option C — after navigating up, call
  `rightPanelStore.open(parentRef, "workstream")` so the parent lands with its
  Workstream board visible. The *highlight/scroll-to-this-child* part is the piece
  to defer, since it needs new panel state. If even the auto-open feels too
  opinionated, ship plain navigation first.
- **General "this is a sub-thread" marker**: yes — the breadcrumb itself is that
  marker (it only appears for sub-threads). No separate badge is needed beyond the
  leading branch icon on the breadcrumb.

### Edge cases (all handled in the chain builder)

- **Parent missing / archived / deleted**: if a `parentThreadId` has no shell in
  `threadShellById`, stop the walk and render the chain built so far; if the
  *immediate* parent is missing, show a non-clickable "parent unavailable" segment
  (mirrors `GoalHeaderSection`'s "Missing goal package" dashed pill) rather than a
  dead link. Archived ancestors (`archivedAt != null`) stay clickable but can be
  visually dimmed.
- **Cross-environment parent (shouldn't happen)**: scope the walk to the active
  thread's `environmentState`; a parent id not found there is treated exactly like
  a missing parent. Do not scan other environments for it — that would resurrect a
  flow the spawn path never creates.
- **Cycles / very deep chains**: walk with a `visited` set and a hard depth cap
  (e.g. 16); on cap/cycle, stop and prepend a `…` so the UI can't loop or grow
  unbounded.
- **Empty role**: fall back to `"sub-thread"`.

### Visual consistency

Reuse the `GoalHeaderSection` chip vocabulary: same `rounded-md border
border-border/60 px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent`
treatment, `lucide-react` icon (e.g. `CornerLeftUpIcon` / `GitBranchIcon`),
`Tooltip`/`TooltipPopup` for full titles, `truncate` + `max-w-*` for long titles,
`›` (or a `ChevronRightIcon`) as separators. Place it in the existing left cluster
(`<div className="flex min-w-0 flex-wrap items-center gap-2 ...">`) right after the
title `<h2>` and before/around the goal pill, so it folds responsively like the
existing controls.

## Implementation handoff — exact touch points

1. **`apps/web/src/components/chat/ChatHeader.tsx`** (primary)
   - Add a `ThreadLineageBreadcrumb` component next to `GoalHeaderSection`.
   - Add props to `ChatHeaderProps`: the resolved ancestor chain (array of
     `{ threadId, title, archived, missing }` from root→parent) and the current
     child's `role`. Prefer passing the *already-resolved* chain in (keep `ChatHeader`
     a pure presenter, consistent with how it receives `goalSlug` rather than
     resolving goals itself — `GoalHeaderSection` is the one exception and uses a
     hook; either pattern is fine, but resolving in `ChatView`/a selector keeps the
     store access centralised).
   - Render only when the chain is non-empty; wire each segment's `onClick` to a
     navigate callback (either pass an `onNavigateToThread(threadId)` prop, or pass
     `environmentId` and call `useNavigate` locally — `ChatHeader` does not currently
     use the router, so passing a callback from `ChatView` is the lower-surface choice).

2. **`apps/web/src/threadRouteLineage.ts`** (new, tiny pure helper) — or colocate in
   `threadRoutes.ts`:
   - `buildThreadLineage(threadShellById, childThreadId, { maxDepth }): LineageSegment[]`
     walking `parentThreadId` with a `visited` cycle-guard and depth cap, returning
     ancestors root→parent with `{ threadId, title, archived, missing }`. Pure and
     trivially unit-testable (the one place a wrong guard could infinite-loop —
     worth a small test per the project's "tests only when risk is high" rule).

3. **`apps/web/src/components/ChatView.tsx`** (wiring)
   - Where `ChatHeader` is rendered (~line 4526): select the active environment's
     `threadShellById` (via a memoised store selector), call `buildThreadLineage`,
     and pass the chain + `activeThread.role` to `ChatHeader`.
   - Provide the navigate callback using the existing `navigate` already in scope
     and `buildThreadRouteParams` (mirroring `WorkstreamPanel.openThread`).
   - Optional (lightweight Option C): in that callback, after navigating, call
     `useRightPanelStore.getState().open(parentRef, "workstream")`.

4. **`apps/web/src/storeSelectors.ts`** (optional)
   - If a memoised `threadShellById`-by-environment selector doesn't already exist
     in a convenient form, add a small selector here for the lineage walk (or read
     `selectEnvironmentState(state, env).threadShellById` inline in a `useStore`
     memo in `ChatView`). No change to `Thread`/types needed — all required fields
     already exist on `ThreadShell`.

No schema, contract, or server changes are required — this is purely a web-client
read of existing fields plus existing navigation.

## Out of scope / deferred

- The full Option C "highlight + scroll to the originating child card" in
  `WorkstreamPanel` (needs new panel focus state + per-card refs). Track as a
  follow-up if the plain breadcrumb + auto-open isn't enough.
- Showing sub-threads in the sidebar (explicitly a non-goal of the feature).
