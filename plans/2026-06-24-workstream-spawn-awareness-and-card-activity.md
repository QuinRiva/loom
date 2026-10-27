---
manager_sessions:
  - id: 1f36c27e-0954-4e92-a20e-d97e1badf6b5
    role: plan
    authored_at: 2026-06-24T11:15:31.022Z
---

# Plan: Workstream spawn-awareness + card activity line

## Context & motivation

The Workstream feature (sub-agent threads spawned off a parent, surfaced in a
right-panel Board/Graph) shipped its Phase 1 vertical slice from
`.plans/sub-agent-workstreams-implementation.md`. Two elements from the original
mockup (`.plans/mockups/workstream-panel.html`) were never built. We evaluated
both for *value* before deciding to build:

1. **Spawn card in the main transcript** — the mockup showed an inline card in
   the centre thread when sub-threads were spawned. **Verdict: build (modest
   value).** Agent-driven spawns (`workstream_spawn` MCP tool) currently surface
   only as individual, easily-missed collapsible tool chips in the timeline. The
   transcript is the only surface that answers *causality* ("**which turn**
   spawned these, and **what** was spawned") — the panel and any left-sidebar
   parent badge only answer *state* ("children exist"). The card's incremental
   value over the existing tool chips is **grouping** per-turn spawns into one
   legible unit and making each spawned child an **actionable** click-through.

2. **Drill-in drawer on card click** — the mockup opened a detail drawer instead
   of navigating into the child. **Verdict: do NOT build.** The card already
   carries role/title/goal/status/branch, and the breadcrumb-back
   (`threadRouteLineage.ts` + `ThreadLineageBreadcrumb`, already shipped) makes
   "navigate straight in" cheap to reverse. The drawer's only unique value was an
   in-place activity peek — which we deliver more cheaply by **adding a one-line
   activity preview to the card itself** (item 3 below).

Plus one behaviour the mockup implied and we want: **auto-open the Workstream
panel on the first agent-driven spawn**, so the user is taken to the work without
hunting through the right-panel menu.

## Scope — three items

### Item A — Auto-open the Workstream panel on first spawn

**Behaviour:** when the active (parent) thread transitions from 0 → ≥1 children
(a child is a thread whose `parentThreadId === activeThread.id`), auto-open the
Workstream right-panel surface for that thread, **once**, without stealing focus
from the composer or overriding a surface the user has deliberately opened.

**Why client-side / projection-driven:** spawns happen server-side via the
`workstream_spawn` MCP tool; the client learns of new children through projection
updates landing in `environmentState.sidebarThreadSummaryById`. So the trigger is
a client effect that watches the child count for the active thread.

**Touch points:**
- `apps/web/src/components/ChatView.tsx` — this is where `activeThread` and the
  right-panel store are already in scope (`addWorkstreamSurface` already calls
  `useRightPanelStore.getState().open(activeThreadRef, "workstream")`). Add an
  effect that observes the active thread's child count (reuse the
  `selectWorkstreamChildren` selector shape from `WorkstreamPanel.tsx`, or a
  lighter count selector) and calls `open(...)` on the 0 → ≥1 edge.
- `apps/web/src/rightPanelStore.ts` — `open(ref, "workstream")` already exists; no
  store API change expected.

**Guard rails (pin these — they are the easy-to-get-wrong part):**
- Fire **only on the rising edge** (0 → ≥1), tracked per **scoped** thread key
  (`environmentId + threadId` / `scopedThreadKey`, NOT a bare `ThreadId` — the
  right-panel store is keyed by scoped ref, `rightPanelStore.ts:10,410-416`, so a
  bare id risks cross-environment collisions).
- **Initialize the remembered count from the currently observed count** the first
  time a scoped parent is seen — do NOT seed it to `0`. Otherwise children
  delivered on bootstrap/reconnect/replay look like a false `0 → N` spawn and
  auto-open fires spuriously. The genuine edge is "a parent we were already
  observing gains its first child".
- Do **not** auto-open if the user currently has a *different* right-panel surface
  active for this thread. The predicate is expressible from store selectors
  (`rightPanelStore.ts:418-433`), but note `ChatView` can have the active kind
  **URL-forced to `"diff"`** via `selectActiveRightPanelKindWithUrl`
  (`ChatView.tsx:1311-1318`) — treat **any** active non-workstream surface,
  including the URL-forced diff, as "do not hijack". Opening when the panel is
  closed is the primary case.
- This is a navigation/UX side-effect — keep it minimal and easy to roll back.

### Item B — Inline spawn card in the transcript (grouped tool-result renderer)

**Decision: do NOT invent a new event type or a parallel "modal" surface.** Build
this as a **specialized rendering of the existing `workstream_spawn` tool work
entries** already flowing through the timeline. The spawn emits a tool result
(`"Spawned Workstream sub-thread <id>: <title>"`, see
`WorkstreamSpawnExtension.ts:74-83`, with `details: { ok: true, ...result }`
carrying `childThreadId` + `title`).

**BLOCKER amended in (review finding): the `childThreadId`/`title` payload does
NOT currently reach the web timeline — this is the load-bearing data contract to
fix first.** Pi classifies `workstream_spawn` as a `dynamic_tool_call`, not
`mcp_tool_call`, because the tool name has no `mcp` prefix
(`PiDriver.ts:320-345,530-561`). The web only copies tool result `data` into
`WorkLogEntry.toolData` for `itemType === "mcp_tool_call"`
(`session-logic.ts:721-746`), and `WorkLogEntry` carries no raw `data`/`details`
field (`session-logic.ts:63-81`). So the spawn `details` are dropped before the
timeline.

**Pin this contract:** thread the spawn result's `childThreadId` (+ `title`)
through to the work entry so the timeline can render an actionable card. Prefer
the smallest change: extend the dynamic-tool-result derivation in
`session-logic.ts` to surface the needed fields onto `WorkLogEntry` (e.g. carry
the dynamic tool result `data` the way `mcp_tool_call` already does), rather than
reclassifying the server emit. This is the one place a wrong assumption silently
breaks the feature — get it right before building presentation. Per-turn
attribution survives: each `WorkLogEntry` carries `turnId`
(`session-logic.ts:63-67`).

**Behaviour:**
- Within a single assistant turn, **group `workstream_spawn` result entries that
  share the same `turnId`** into one inline card rather than N separate tool
  chips. Group by matching `WorkLogEntry.turnId` — do NOT rely on the current
  "consecutive work entries" row boundary in `MessagesTimeline.logic.ts:344-366`,
  which groups across turns regardless of `turnId`.
- Collapsed: a one-line summary — e.g. `⌥ 3 sub-threads spawned ▸` — anchored at
  the turn where the spawns happened (this is the causality signal the buried
  individual chips fail to provide).
- Expanded: a row per spawned child showing **role + title** and, where available,
  live status (reuse the status vocabulary from `WorkstreamPanel.tsx` —
  `getEffectiveColumn` / `STATUS_STYLES` — by looking the child up in the store by
  `childThreadId`). Each row is **clickable** → navigate into that child (mirror
  `WorkstreamPanel.openThread` via `buildThreadRouteParams` /
  `scopeThreadRef`), or open the parent's Workstream panel.
- A single spawn still renders as a (clickable) card; grouping is for the
  multi-spawn case.

**Touch points:**
- `apps/web/src/session-logic.ts` — **(the blocker fix)** surface the dynamic
  tool result `data` (`childThreadId`, `title`) onto `WorkLogEntry` for
  `workstream_spawn` so the timeline can read it.
- `apps/web/src/components/chat/MessagesTimeline.tsx` — the timeline builds
  grouped work entries (`WorkGroupSection`, `SimpleWorkEntryRow`,
  `workEntryPreview`). Add a branch that detects `workstream_spawn` entries and
  renders the grouped (by `turnId`) spawn card instead of the generic work-entry
  rows. Prefer extending the existing grouping/render path over a parallel one.
- May need a small selector to resolve `childThreadId` → live
  `SidebarThreadSummary` for status/title. Children live in
  `environmentState.sidebarThreadSummaryById`.

**Open implementation questions for the implementer (not pinned here):** exact
collapsed/expanded styling, whether to show live status or just role+title in the
first cut, and how to detect "consecutive within a turn" given the timeline's
existing grouping model. These are presentation calls; the **contract** is: read
the existing `workstream_spawn` tool entries + their `details.childThreadId`,
group per turn, make rows actionable. No new event/command schema.

### Item C — One-line "last activity" preview on the Workstream card

**Replaces the rejected drill-in drawer.** Add a single truncated line to each
Workstream board card describing **what the sub-thread is currently doing**, so
the user can triage many children without navigating in.

**Content decision (pinned): intent-first, mechanism-as-fallback.**
- Primary: the **latest assistant narration text** for the child (the agent's own
  stated intent, e.g. "Now I'll look for the config file"), truncated to ~one line
  (first N chars). This is the highest-signal line for *human triage* — far more
  useful than a raw `grep …` command, which says "busy" but not "why".
- Fallback (best-effort, optional in the first cut): when the current turn has
  emitted a tool call but no assistant text yet, a compact tool descriptor
  (e.g. `running: bash`, `editing <path>`). Keep simple; do not over-build.

**Data path — the real cost of this item.** The card's data object
(`SidebarThreadSummary`, `apps/web/src/types.ts`) and its `latestTurn`
(`OrchestrationLatestTurn` in `packages/contracts/src/orchestration.ts`) carry
`assistantMessageId` (a *reference*), `state`, and timestamps — **no message
text.** Reading the child's message log client-side is not viable: children the
user hasn't opened are not loaded in the store, so most cards would show nothing.
The preview must come from the **projection / snapshot query**.

Two routes (implementer chooses; route 1 preferred — lower surface, no migration):

1. **Derive from existing persisted messages (preferred).** Assistant text is
   persisted to `projection_thread_messages` and updated on streaming chunks
   (`ProjectionPipeline.ts:999-1032`). **Caveat (review finding): the shell /
   sidebar-summary snapshot does NOT currently join messages** — it fetches only
   projects, active-thread rows, sessions, latest turns, and state
   (`ProjectionSnapshotQuery.ts:1607-1631`, mapped without messages at
   `1683-1720`); only the *full thread* snapshot reads
   `projection_thread_messages` (`513-532`). So route 1 is **"add a targeted
   latest-assistant-message query for shell snapshots"**, not merely "extend the
   existing `latestTurnRows`". Still no new column / migration, but it is a new
   targeted query, not free.
2. **Dedicated column (fallback).** Add a `last_activity_preview` column on
   `projection_threads`, maintained by the projector, with a new numbered
   migration (next is `039_…`, mirroring
   `037_ProjectionThreadWorkstreamFields.ts`). More write-path surface and
   duplicated data; use only if route 1's query proves awkward.

**Contract to pin (whichever route):** one nullable string field, e.g.
`lastActivityPreview: string | null`, semantics = "short human-readable
description of the most recent activity (latest assistant narration, else compact
tool descriptor)". Additive, optional, nullable with decode-default `null`
(correct projection versioning, mirrors `goalSlug` / workstream fields — NOT a
compat shim). **It must live on the shell schema, not just the projection thread:**
the shared shell type is `OrchestrationThreadShell`
(`packages/contracts/src/orchestration.ts:483-511`), mapped into
`SidebarThreadSummary` in `apps/web/src/store.ts:287-346`. Add the field there and
update the shell-equality checks (`store.ts:438-463`) or shell updates won't
propagate.

**Touch points:**
- `packages/contracts/src/orchestration.ts` — add the nullable field to
  `OrchestrationThreadShell` (decode-default `null`).
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` — add the
  targeted latest-assistant-message query for the shell snapshot (route 1) or read
  the new column (route 2).
- `apps/server/src/orchestration/projector.ts` — only if route 2 (maintain the
  column on message/turn events).
- `apps/web/src/store.ts` — carry the field through the shell→summary mapping
  (`287-346`) and the equality checks (`438-463`).
- `apps/web/src/types.ts` — add the field to `SidebarThreadSummary`.
- `apps/web/src/components/WorkstreamPanel.tsx` — render the line on
  `WorkstreamCard` (and optionally the graph node tooltip), truncated. There is
  already a `getActivity()` *status* string on the card; this new line is *content*
  and complements it — don't conflate the two.

**Fallback is route-2-only, so it is explicitly deferred for the first cut.** The
tool-descriptor fallback (`running: bash`, `editing <path>`) lives in activity /
work-log data, NOT in `projection_thread_messages`, so route 1 cannot produce it
without an extra activity query. First cut: assistant-narration preview only;
when there is no assistant text yet, show nothing (or the existing status line).
The fallback is a later enhancement (and a reason to pick route 2 if it turns out
to matter).

## Explicitly out of scope
- The drill-in drawer (rejected — superseded by item C + the existing breadcrumb).
- A left-sidebar parent "N children running" badge — being handled in a separate
  worktree; do not duplicate here, and do not add a Workstream-tab badge.
- Any new status state machine, dispatcher, or heartbeat work (later phases).

## Acceptance
- Spawning sub-threads from a parent (via the agent `workstream_spawn` tool)
  auto-opens the Workstream panel exactly once on the first spawn, without
  hijacking a deliberately-opened surface.
- The turn that spawned sub-threads shows a grouped, expandable, clickable spawn
  card in the transcript identifying **which** children were spawned (role +
  title), not just that "a" spawn occurred.
- Each Workstream board card shows a truncated one-line preview of the child's
  latest **assistant-narration** activity, sourced from the projection (shell
  snapshot), visible for children the user has not opened. The tool-descriptor
  fallback is explicitly out of scope for the first cut (see Item C).
- Old persisted threads/projections still load (new field defaults to `null`); no
  replay breakage.
- `vp check` and `vp run typecheck` pass. (No native mobile code expected; if any
  is touched, `vp run lint:mobile` too.)

## Notes for the implementer
This plan pins the **contracts and behaviour**: the auto-open rising-edge rule and
its no-hijack guard (A); "reuse existing `workstream_spawn` tool entries + their
`details.childThreadId`, group per turn, make rows actionable — no new
event/command" (B); and "one nullable `lastActivityPreview`-style projection
field, intent-first content, derive from existing messages if feasible" (C).
Component structure, styling, the exact timeline-grouping mechanism, and the
query mechanics are yours — follow existing conventions and keep surface area
minimal.
