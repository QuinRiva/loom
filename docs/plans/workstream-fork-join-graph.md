---
manager_sessions:
  - id: 8b6bf51c-6ac6-4334-bf04-b43def926704
    role: plan
    authored_at: 2026-06-29T23:55:58.965Z
---

# Workstream fork–join graph — implementation plan

## Why we're changing it

The current Graph view (`apps/web/src/components/WorkstreamGraph.tsx`) is a
parent→child **topology** view: position encodes who-spawned-whom, laid out by a
layered Sugiyama DAG engine (`d3-dag`). For the orchestrations this product
actually runs, that is the _least_ informative axis:

- One orchestrator, several children hanging directly off it. Every parent→child
  edge says the same thing ("the orchestrator spawned this") — near-zero
  information, and the lineage-depth ranking the DAG engine exists for has
  nothing to rank (depth is almost always 1).
- It also only ever shows **direct children** (`selectWorkstreamChildren` filters
  `parentThreadId === activeThread.id`), so nested spawns (grandchildren) never
  appear at all.
- The relationship that _is_ meaningful — "the second coder was dispatched
  **after**, and because of, the first reviewer's findings" — is invisible,
  because it's neither a lineage edge nor a `blockedBy` dependency. It's
  temporal/causal.

## The model (the reframe)

Render the orchestration as a **fork–join "dispatch episode" flow**, with the
orchestrator as a **recurring spine node**, not a single root.

The load-bearing discovery from recon: **the engine already models this.** The
server groups children by `(parentThreadId, spawnGeneration)` and wakes the
parent only when _every_ member of a generation is terminal
(`selectJoinedGenerations` / `isTerminalForJoin` in
`packages/shared/src/workstreamGraph.ts`, consumed by
`apps/server/src/orchestration/Layers/WorkstreamDispatcher.ts`). So:

- A **`spawnGeneration`** _is_ a dispatch episode — the wave of children spawned
  before the orchestrator next regains control.
- A generation **joins** when all its members go terminal — the exact moment the
  orchestrator is re-prompted.
- Therefore one **orchestrator spine node = one `spawnGeneration`**. We are not
  inventing structure; we are drawing structure the engine already computes to
  drive re-prompting.

Resulting picture (matches the user's sketch):

```
Orchestrator (wave 1) ── coder A ──▶ reviewer A   (parallel wave; A→revA, B→revB
                     └─ coder B ──▶ reviewer B     are blockedBy cross-edges)
        │  (wave 1 all terminal → join → re-prompt)
Orchestrator (wave 2) ── coder C ──▶ reviewer C
        │
Orchestrator (wave 3) ── researcher
```

> **`spawnGeneration` is an opaque turn-id, not an ordinal.** It's a `TurnId`
> string (`spawnGeneration = current.session?.activeTurnId ?? childThreadId`,
> `WorkstreamSpawnHttp.ts:303`) — all children of one orchestrator turn share it;
> a different turn is a different generation. There is **no numeric order and no
> reliable lexical order**, so the spine MUST be ordered by each wave's
> `min(child.createdAt)`, never by the generation key. The "wave 1/2/3" labels
> above are by dispatch time, not a stored ordinal.

- **Within a wave**: children of the same generation render side-by-side
  (parallel); `blockedBy` edges (coder→reviewer) are the cross-edges _inside_ the
  wave. These are the only edges that carry real information, so they stand out.
- **Across waves**: the spine, ordered by `min(createdAt)`, carries the
  temporal/causal order. Coder C sitting below the wave-1 join _is_ the "after
  the reviewer, the orchestrator reacted" relationship — expressed by position,
  no fake dependency invented.
- **The orchestrator node is the bridge between waves.** There is one
  orchestrator node per wave — it is the dispatch turn for that wave AND where the
  previous wave's results returned. Without it, consecutive waves are disjoint
  subgraphs (coder-2 has no real link to reviewer-1). So we draw **synthetic
  connectors**: each terminal member of wave _N_ joins _into_ the orchestrator
  node for wave _N+1_ (a join edge), and that node forks _out_ to wave _N+1_'s
  children (fork edges). `coder → reviewer ─[join]→ orchestrator ─[fork]→ coder2 →
reviewer2`. These connectors are **structural, not dependencies**: render them
  as the neutral solid spine line, visually distinct from real `blockedBy`
  (dashed amber) — the one genuinely information-bearing edge must not be confused
  with plumbing. The first orchestrator node forks wave 1 with no inbound join;
  there is **no node after the last wave** — the spine ends there.
- **Nesting**: a child that itself spawns children is just a sub-orchestrator with
  its own generations — the same rule applied recursively. Grandchildren stop
  being a special case.
- **"Open" vs "joined" wave**: derivable from _current_ state today
  (`isTerminalForJoin` over a generation's members runs purely off
  `SidebarThreadSummary`). No timestamp needed for structure.

## Decisions locked (by the user)

1. **Always whole-orchestration.** The graph always shows the full tree from the
   top-most ancestor orchestrator, regardless of which thread is currently open
   (easier navigation). Today the panel re-roots on `activeThread`; change it to
   root on the top-most ancestor and render the whole descendant subtree.
2. **Click a spine (orchestrator) node → scroll the orchestrator conversation to
   where that wave was dispatched.** Spine nodes become navigation anchors, not
   just connectors.
3. **Defer timing polish to v2.** No `planTerminalAt` / no server change in this
   pass. Structure comes entirely from `spawnGeneration` + current state.

## Changes (all client-side; `apps/web`)

### 1. Surface `spawnGeneration` on the thread summary

`spawnGeneration` is **already on the wire** (`OrchestrationThreadShell`) but
`mapThreadShell` (`apps/web/src/store.ts`, ~L337) drops it when building
`SidebarThreadSummary` (`apps/web/src/types.ts`). Re-expose it — a one-line add to
the projector + the type. This is the authoritative wave key; do **not**
re-derive waves from timestamps.

### 2. Whole-orchestration data feed

Replace `selectWorkstreamChildren`'s direct-children filter
(`WorkstreamPanel.tsx`, ~L46) with: walk `parentThreadId` up from the active
thread to the top-most ancestor (the root orchestrator), then gather its full
descendant subtree. Reuse `descendantsOf` / `subtreeOf` from
`packages/shared/src/workstreamGraph.ts` rather than hand-rolling.

- **Assumption to confirm:** the environment's `sidebarThreadSummaryById` map
  contains the _whole_ subtree (all descendants, not just sidebar-visible
  threads). The current panel reads sub-threads from it, so it should — verify
  grandchildren are present before relying on it.

### 3. Fork–join layout & render

Lay out as a vertical sequence of `(spine node, wave)` pairs **ordered by each
wave's `min(child.createdAt)`** (see the M1 note above — do NOT sort by the
generation key). Within each wave, place generation members side-by-side and
route `blockedBy` edges as cross-edges. The existing rendering vocabulary stays:
status-coloured node cards, role icon/label, dashed-amber `waits-on` edges,
zero-dependency pan/zoom, legend, fit-to-content. View stays **read-only**
(per `docs/research/workstream-dag-visualization.md` — do not grow it into an
editor).

- **Decision: hand-roll the band layout and DROP `d3-dag`.** Its only value is
  Sugiyama depth-ranking, the axis we've established is near-useless here
  (depth ≈ 1). Fork–join is a deterministic band layout: spine nodes at x=0
  stacked by `min(createdAt)`; each wave's children in a row to the right of its
  spine band; within-wave `blockedBy` as short horizontal cross-edges. Less code
  than the current `computeLayout`, and the heavy lazy-loaded dependency goes.
- **Nesting is net-new and the one non-trivial part — budget for it.** A
  wave-child that is itself a sub-orchestrator is NOT "just drawn recursively" in
  a flat band: its own spine+waves form a self-contained block that must be
  **measured (w×h) then packed as a unit** into the parent wave's row
  (measure-then-place recursion). The current renderer only ever draws one root +
  direct children (`RootNode` + `GraphNode`), so nesting is new regardless of
  engine choice. Spine ordering by `min(createdAt)` is **per-orchestrator** — a
  nested sub-orchestrator's waves order within its own block, not against the
  root's global timeline.
- **Group strictly by `(parentThreadId, spawnGeneration)`, then time-sort.**
  Out-of-turn spawns (parent had no active turn) fall back to the child's own id
  as the generation, becoming singleton waves — they must degrade gracefully into
  extra one-child spine nodes. Don't assume one spine node per multi-child turn.
- **No trailing head node** (decided): the spine ends at the last real wave. But
  the **inter-wave orchestrator bridge nodes are required** (see model section) —
  one per wave, with synthetic join edges in from the prior wave's terminal
  members and synthetic fork edges out to its own children. Solid neutral spine
  line for these connectors; dashed amber reserved for real `blockedBy`. Each
  bridge node is the click-to-scroll target for its wave's dispatch turn (§4).

### 4. Click-to-scroll dispatch anchor — a small _feature_, not a hook

On clicking a spine node for wave _G_, scroll the **root orchestrator's**
conversation to where that wave was dispatched. Anchor heuristic (client-side, no
server data): the orchestrator message whose timestamp is the latest at or before
`min(createdAt)` over _G_'s members.

Review confirmed this is materially bigger than a hook — it is a full
cross-component flow. Build all of:

1. **Navigate to the orchestrator thread first.** Under decision #1 the graph
   shows the whole orchestration, so the clicked spine usually belongs to the
   root orchestrator, which is often NOT the open thread (you may be viewing a
   grandchild). The panel is mounted in `ChatView` keyed to the active thread, so
   acting on the click means routing to the orchestrator thread.
2. **Await its message load.** Full `thread.messages` exist only for the active
   thread; the shell map holds summaries only. So the anchor resolution runs
   _after_ navigation + message load — an async sequence, not a synchronous read.
3. **Resolve message-id → row index → scroll.** The timeline is virtualised
   (`@legendapp/list`); off-screen rows aren't mounted, so there is no
   scroll-to-DOM-by-id. Rows carry `data-message-id` (`MessagesTimeline.tsx:434`)
   but you must map id → index and call `LegendListRef.scrollToIndex` /
   `scrollToItem`.
4. **Add the scroll-request channel.** No `scrollToMessage`/`pendingScroll`/
   `focusMessage` signal exists today. Add a small target `{threadId, messageId}`
   to `uiStateStore` (which `MessagesTimeline` already consumes) that survives the
   navigation + load and is consumed once on arrival.

Still v1-sized, but estimate it as a feature, not a one-liner.

## Explicitly out of scope (v2)

- `planTerminalAt` projection field and any server change.
- Wave durations / join timing / animations.
- The precise terminal timestamp for the _attention-flagged-not-executing_ join
  path (the dominant `done`/`cancelled` case needs nothing here).

## Verification

- `vp check` and `vp run typecheck` pass.
- Real check against the nested-spawn thread that motivated this
  (`17ddc482-f8d2-44d9-bf2b-1c8189ba2900`): the grandchild now appears; the
  orchestrator shows as repeated spine nodes per generation; `blockedBy` pairs
  render as within-wave cross-edges; clicking a spine node scrolls the
  conversation to that wave's dispatch point.
- The common flat case (one orchestrator, a couple of waves) reads cleanly.

## Key references

- `packages/shared/src/workstreamGraph.ts` — `spawnGeneration` grouping,
  `selectJoinedGenerations`, `isTerminalForJoin`, `descendantsOf`/`subtreeOf`.
- `apps/server/src/orchestration/Layers/WorkstreamDispatcher.ts` — `wakeEligibleParents`/`deliverWake` (the join→re-prompt boundary; read-only context).
- `apps/web/src/store.ts` (`mapThreadShell`) + `apps/web/src/types.ts`
  (`SidebarThreadSummary`) — where `spawnGeneration` is dropped.
- `apps/web/src/components/WorkstreamPanel.tsx` (`selectWorkstreamChildren`),
  `WorkstreamGraph.tsx` (`computeLayout`, render), `lib/workstreamGraph.ts` /
  `lib/workstreamPresentation.ts` — presentation.
