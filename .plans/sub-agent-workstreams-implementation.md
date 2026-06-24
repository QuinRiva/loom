---
manager_sessions:
  - id: 86c158b7-7422-42ee-abb0-c9065deaa1ec
    role: plan
    authored_at: 2026-06-23T02:17:16.590Z
---

# Implementation plan: sub-agent workstreams (Phase 1)

## Goal (one paragraph)
Make a chat thread able to **spawn child "sub-threads"** (e.g. a coder, a
reviewer) that are real T3 threads carrying a `parentThreadId`, a `role`, and a
short `goal` (why it was launched). Sub-threads are **hidden from the left goal/
thread sidebar** and instead surfaced under their parent in a new **"Workstream"
right-panel surface** that lists them as a board, fed by **real projection
data**. This is the foundational vertical slice; the dependency graph, status
state machine, dispatcher, heartbeats, and role prompt overlays are later phases
(sketched at the end). The design is already prototyped in
`.plans/mockups/workstream-panel.html`; this plan turns the data model + board
half of it into working code.

## Ground rules (this is real code now, not a mock)
- `vp check` and `vp run typecheck` MUST pass before "done". If native mobile
  code is touched, `vp run lint:mobile` too. (See repo AGENTS.md.)
- **No backwards-compat shims** (repo AGENTS.md). BUT this is an event-sourced
  system: new fields on persisted events/commands must be **additive, optional,
  nullable with a decoding default of `null`**, exactly like `goalSlug` is today
  — that is correct event versioning so old stored `ThreadCreated` events still
  replay, NOT a compat shim. Do not add dual-shape output or "kept for compat"
  fields.
- Follow existing patterns; don't invent parallel mechanisms. Threads, events,
  projector, projection persistence, and the right-panel surface system already
  exist — extend them.
- Keep `packages/contracts` schema-only (no runtime logic).

## The data model additions (the contract — get these exact)
Three nullable fields describe a sub-thread. Add them as additive/optional/
nullable with decode-default `null` (mirror `goalSlug`'s treatment):

- `parentThreadId: ThreadId | null` — the spawning thread. `null` = a normal
  top-level thread. This is the single load-bearing field.
- `role: string | null` — the agent's role label (e.g. `coder`, `reviewer`,
  `scaffold`, `migration`). Keep it an open trimmed string for now, not a closed
  enum — roles will churn.
- `goal: string | null` — the short "why it was launched" intent.

Apply consistently across these existing definitions in
`packages/contracts/src/orchestration.ts`:
- `ThreadCreateCommand` (~line 500)
- `ThreadCreatedPayload` (~line 870)
- `ThreadTurnStartBootstrapCreateThread` (~line 562) — so a turn that bootstraps
  a thread can carry lineage too
- `ThreadMetaUpdateCommand` (~line 543) and `ThreadMetaUpdatedPayload` (~line
  905) — `goal` (and maybe `role`) editable; `parentThreadId` is immutable after
  create (do NOT make it editable).

## Server wiring
- **Projector** (`apps/server/src/orchestration/projector.ts`, thread record
  built ~line 280, meta-update ~347): carry `parentThreadId`/`role`/`goal` onto
  the in-memory thread record on `ThreadCreated`, and apply `goal`/`role` on
  meta-update. Mirror exactly how `goalSlug`/`worktreePath` are handled.
- **Projection persistence**: the projection thread row is stored and queried
  via `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` and the
  DB schema under `apps/server/src/persistence/`. Add the new columns and a new
  numbered migration following the existing migration pattern in
  `apps/server/src/persistence/Migrations/` (look at a recent one, e.g. the
  backfill/canonicalize migrations, for the idempotent shape). The snapshot
  query must select/decode the new columns.
- **Decider** (`apps/server/src/orchestration/decider.ts`): ensure
  `thread.create` carries the new fields from command → `ThreadCreated` event.

## Web wiring
- **Types** (`apps/web/src/types.ts`) and any thread store selectors: carry the
  new fields.
- **Hide sub-threads from the sidebar / goal tree.** The left list is built in
  `apps/web/src/components/Sidebar.tsx` / `Sidebar.logic.ts` and
  `apps/web/src/goals/goalIndex.tsx`. A thread with `parentThreadId != null` must
  NOT appear there. (It still inherits the parent's `goalSlug` for constraint —
  it's just not rendered as its own sidebar/goal node.)
- **New right-panel surface "workstream".** Add `"workstream"` to
  `RIGHT_PANEL_KINDS` in `apps/web/src/rightPanelStore.ts` (singleton surface,
  like `plan`/`tasks`), wire it into `RightPanelTabs.tsx` and the render switch
  in `ChatView.tsx`. Use `GoalTasksPanel.tsx` as the *structural* reference for a
  panel that reads projection data and renders into the dock — but its data
  source is different, so mirror the shape, not the content.
- **The Workstream board** lists the current thread's **children** (threads whose
  `parentThreadId` === this thread's id), grouped into board columns. For Phase 1
  derive the column from **existing signals** (session running, pending approval,
  archived/done, otherwise planned/idle) — do NOT introduce a new status state
  machine yet (that's Phase 2). Each card shows role badge, title, goal, and
  whatever live signal exists. Clicking a card navigates into that sub-thread
  (it's a normal thread route).
- **Spawn affordance.** Add a way to create a sub-thread from the orchestrator
  thread (e.g. a "Spawn sub-agent" action) that dispatches `thread.create` with
  `parentThreadId` = current thread id, plus `role`, `goal`, `title`, inheriting
  the parent's `goalSlug`/project/model as sensible defaults. Reuse the existing
  thread-creation path in `apps/web/src/hooks/useHandleNewThread.ts` rather than
  building a parallel one.

## Acceptance (Phase 1)
- You can spawn a sub-thread from a thread; it gets `parentThreadId`/`role`/`goal`.
- The sub-thread does NOT appear in the left sidebar/goal tree.
- The Workstream right-panel surface on the parent lists its children as a board
  with role + goal, from real projection data, and clicking one opens it.
- Old persisted threads still load (new fields default to `null`); no replay
  breakage.
- `vp check` and `vp run typecheck` pass.

## Out of scope (later phases — sketch only, do NOT build now)
- **Phase 2:** explicit per-sub-thread **status state machine**
  (`planned→running→blocked→review→done`) as events + a `blockedBy` dependency
  edge, and the **Graph view** (the SVG dependency view from the mockup).
- **Phase 3:** a **dispatcher** (auto-promote ready / spawn), **heartbeat +
  stale-claim** detection, and a **consecutive-failure circuit breaker** (steal
  the semantics from Hermes Kanban).
- **Phase 4:** **role system-prompt overlays** (coder principles, review
  heuristics), **worktree isolation per sub-thread**, and diff-as-review handoff.

## Notes for the implementer
You are trusted to make the structural/judgement calls. This plan pins the
**contract** (the three fields, their nullability/versioning, where they live)
and the **behaviour** (hidden from sidebar; Workstream board of children from
real data; spawn affordance). Everything about migration mechanics, component
structure, board-column derivation, and the spawn UX form is yours — follow the
codebase's existing conventions and keep the surface area minimal.
