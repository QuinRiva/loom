---
manager_sessions:
  - id: 86c158b7-7422-42ee-abb0-c9065deaa1ec
    role: plan
    authored_at: 2026-06-23T01:14:38.041Z
---

# Plan: add a per-agent "goal" to the Workstream mockup

## Context
`/home/Carl/pi-frontend-workstreams/.plans/mockups/workstream-panel.html` is a
single-file, offline, interactive design prototype of T3 Code's "Workstream"
right-panel surface. It shows sub-agent sessions ("sub-threads") two ways — a
**Board** (Kanban columns) and a **Graph** (dependency/lineage SVG) — switched
by a segmented control, with a shared drill-in **drawer** opened by clicking a
board card or a graph node. Data lives in a `THREADS` array (plus a synthetic
`DONE_NODE`/`done-merge` terminal node); rendering is `cardHTML`, `renderGraph`,
and `openDetail`.

## Objective
Every agent/sub-thread (card **and** graph node) must carry a short **goal** —
its *intended purpose / why it was launched*. When the user opens the drill-in
drawer they should immediately see "what is this agent for / why does it exist",
distinct from what it is momentarily *doing*.

## The key distinction (write good content, not duplicates)
- `title` = the work item ("Review branch-picker diff").
- `activity` = what it's doing *right now* ("reading diff +412 −88").
- **`goal` = the durable intent / why it was spawned** ("Gate the branch-picker
  diff against our review heuristics before it merges").

Each goal should be one short phrase/sentence, role-appropriate, and clearly an
*intent* rather than a restatement of the title.

## Scope of change (all within the one HTML file)
1. **Data model:** add a `goal` string to every entry in `THREADS` *and* to the
   synthetic `done-merge` node. No entry may be left without one.
2. **Drawer (primary surface — required, prominent):** surface the goal clearly
   in `openDetail`, near the top of the drawer so it reads as the agent's
   purpose — visually distinct and labelled (e.g. a "Goal" / "Purpose" line or
   block). It must appear for all nodes including the terminal done node.
3. **Card + graph node (secondary — must be discoverable):** the goal must be
   *associated with the card/node*, not drawer-only. Use your judgement on form
   given the tight ~28rem dock and small SVG nodes — e.g. a subtle goal line on
   the card and a native tooltip on the node — but it must be present and not
   wreck the existing layout.

## Constraints (do not violate)
- Stay a **single, self-contained, offline** file: no network/CDN/new deps, no
  build step; must still open by double-click.
- Do **not** break existing behaviour: Board/Graph toggle, clickable cards and
  nodes, the drawer, the four stress-test scenarios (parallel, blocked+stale,
  emergent, review-bounce), and the state colour palette must all still work.
- Don't redesign the panel or change the palette/columns; this is an additive
  field, not a re-layout.
- It's a throwaway prototype in a worktree — touch only this file; don't wire it
  to real app code.

## Acceptance
- Every `THREADS` entry and the `done-merge` node has a meaningful `goal` that
  reads as intent (not a copy of `title`).
- Opening the drawer for any board card or graph node shows the goal prominently.
- The goal is also discoverable from the card and the graph node without opening
  the drawer.
- `node --check` on the extracted script is clean; both views render; no external
  references introduced.

## Notes for the implementer
You are trusted to make the design/placement calls — the above pins *what* must
exist and *where it must surface*, not the exact markup or styling. Write the
goal copy yourself to fit each existing agent's role and situation.
