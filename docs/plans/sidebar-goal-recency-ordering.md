---
manager_sessions:
  - id: 717eb62a-8dcf-4c11-a62d-1fe681cdb75a
    role: plan
    authored_at: 2026-06-26T10:40:43.656Z
---

# Sidebar goal ordering: recency, and unify jump numbering with render order

## Problem

The sidebar renders threads grouped under goals. Two orderings have drifted apart:

- **Visual order**: goals are sorted **alphabetically by title** (`localeCompare`), each
  goal's threads by recency, then "loose" threads (no `goalId`, pre-auto-goal-assignment)
  dumped in a block at the bottom. (`Sidebar.tsx` `goalRows` useMemo + the
  `goalRows.map` / `looseThreads.map` render.)
- **Jump-number order** (`Ctrl+1..6`): assigned by index into a **flat, ungrouped**
  `sortThreads(...)` recency list (`visibleSidebarThreadKeys` → `threadJumpCommandByKey`).

Because the jump map is keyed by thread, each `Ctrl+N` badge lands on the correct thread,
but the numeric sequence does not run top-to-bottom — the flat recency numbering and the
goal-grouped/alphabetical layout disagree. Dynamic goal-title regeneration makes it worse
(a goal's alphabetical slot teleports when its title changes).

Alphabetical was never a considered choice — it has been `localeCompare` since the goal
tier was first added (`f8990ced5`, "Add goal tier to sidebar"). Goals carry `createdAt`
and `updatedAt`, so recency ordering is fully available and simply unused.

## Decisions (the contract)

1. **Goal ordering = recency, interleaved with loose threads.** Produce ONE
   recency-ordered, top-to-bottom sequence. Each top-level entry is either a goal group
   (ranked by its most-recently-active thread) or a loose thread (ranked by its own
   recency). Most recent at top. This is the literal "just sort by recency" the user asked
   for, and it makes jump order == visual order by construction. Loose threads are a
   shrinking legacy artifact and just fall wherever their recency puts them.

2. **A goal's recency timestamp** = max `getThreadSortTimestamp(thread, sortOrder)` over
   the goal's (non-archived) threads, falling back to the goal's `updatedAt`/`createdAt`
   when it has no threads. This mirrors the existing `getProjectSortTimestamp` precedent in
   `Sidebar.logic.ts` — reuse that shape; do not invent a different fallback scheme.

3. **Single source of truth for ordering.** The grouped/interleaved ordering must be
   computed once (a shared pure helper, e.g. in `Sidebar.logic.ts`) and consumed by BOTH:
   - the `SidebarThreadList` render, and
   - the `Ctrl+N` jump-number map (`visibleSidebarThreadKeys` /
     `threadJumpCommandByKey` in the parent `Sidebar`).
     They must never be able to drift again. The jump sequence is exactly the flattened
     render order of the preview-visible rows. Use the same preview-slice / expansion subset
     the list actually renders, so `Ctrl+N` matches what is on screen.

## Preserve (do not regress)

- The **compact single-thread goal** rendering (a known goal with exactly one thread
  renders as a single thread row with the "new session under this goal" affordance). In the
  interleaved order it ranks by its one thread's recency — naturally consistent.
- Goal collapse/expand, goal context menu, "new session under goal", progress counts.
- Preview / "Show more" overflow behavior and per-project expansion state.
- Thread-within-goal ordering stays recency (`sortThreads`).
- Project-level sorting is untouched.

## Out of scope

- Project ordering, thread sort-order settings, archived handling semantics.
- No new settings/toggles — recency is the order, full stop.

## Follow-up: collapsed-goal-aware jump numbering

The first pass left one known gap: `Ctrl+N` still counts threads inside a **collapsed**
goal even though those rows are hidden, because goal-collapse state
(`collapsedGoalIds`) lives inside `SidebarProjectThreadList` and the parent's jump-map
(`visibleSidebarThreadKeys`) can't see it. That makes the numbering inconsistent with the
visible rows — which defeats the point of jump navigation. Fix:

- **Lift goal-collapse state to the top-level `Sidebar`** (a single `Set<goalId>` works —
  goal ids are globally unique), so BOTH the render and the jump-map read the same source.
- **The jump flatten excludes threads inside collapsed, collapsible goal groups**, so
  `Ctrl+N` numbers only rows actually on screen. The **compact single-thread goal** form
  (known goal with exactly one thread) is never collapsible and its thread always counts.
- The render must consume the same lifted state so its visual behavior is unchanged.
- Extend the ordering test to assert flatten-with-collapse == the visible-row walk,
  including at least one collapsed multi-thread goal.

## Follow-up 2: hoist the per-project ordering to ONE computation

After the above, the per-project sorted + preview-sliced thread set (and its
`buildSidebarGoalOrderedEntries` result) is still derived in TWO places that must stay
byte-for-byte in lockstep for jump==render:

- child `SidebarProjectItem`: `selectSidebarThreadsForProjectRefs` → `sortThreads` →
  preview-slice → `renderedThreads` → `orderedEntries` (~Sidebar.tsx:1313–1513).
- parent `Sidebar`: `threadsByProjectKey` → sort/filter/slice →
  `buildSidebarGoalOrderedEntries` → `flattenSidebarOrderedThreads` for the jump keys
  (~:3390, ~:3559).

Collapse these into a SINGLE per-project computation that both the render and the Ctrl+N
jump-map consume, so the lockstep is structural, not coincidental. Expected to REDUCE total
lines / moving parts. If hoisting drags in so much incidental per-project state (status
pills, pinned-collapsed, hidden-thread status, lastVisited mapping) that it does NOT come
out simpler, STOP and report the tradeoff rather than forcing a messy hoist — the goal is
less code and less maintenance, not a bigger abstraction.

## Verification

- `vp check` and `vp run typecheck` must pass.
- Manually (or via existing browser tests) confirm: goals/threads render most-recent-first,
  and holding `Ctrl` shows `Ctrl+1..N` running strictly top-to-bottom down the visible list.
