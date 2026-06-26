---
manager_sessions:
  - id: 1607f513-c69b-41ec-a34c-e5c12a3828a0
    role: research
    authored_at: 2026-06-26T01:48:17.126Z
---

# Workstream DAG visualization: evaluation & recommendation

Research deliverable — **no code changes**. Evaluates how to replace the weak
hand-rolled "Graph" view in `apps/web/src/components/WorkstreamPanel.tsx` with a
layout where **position encodes topology** (who spawned whom, dependency order)
and **status is conveyed by colour only**.

## TL;DR recommendation

**Keep our own SVG renderer and add exactly one small, pure layout library —
`@dagrejs/dagre` — to compute node x/y from the graph topology.** Dagre is a
zero-React, zero-DOM layout engine (~40 KB gzip, MIT, bundles its own graphlib)
that runs the layered **Sugiyama** algorithm purpose-built for directed acyclic
graphs: it ranks nodes by lineage depth, orders within each rank to minimise edge
crossings, and assigns coordinates — handling true DAGs with cross edges (our
dashed `waits-on` dependencies) as well as the parent→child tree. We feed it the
lineage edges + `blockedBy` edges, read back `{x, y}` per node, and render with
the **exact custom node cards, status colours, and pan/zoom we already have**. We
delete only the swimlane hack (`getGraphPositions` / `getParentPosition`).

This is the highest-leverage option for _this_ codebase: it directly fixes the
one thing that is broken (layout), adds the least surface area, keeps full control
of rendering, and respects the "performance / minimal-dependency" culture. A full
framework (React Flow) is **not** warranted here — it would replace our renderer,
re-introduce custom-node work, pull in d3 + an internal Zustand store + a
stylesheet, **and still need dagre/ELK for layout anyway** (React Flow does not
lay out graphs for you).

> One caveat worth flagging up front: dagre is in low-maintenance "stable but
> sleepy" mode. If active upstream maintenance matters more than ecosystem
> familiarity, **`d3-dag`** is the actively-developed, TypeScript-first
> equivalent and a drop-in alternative for the same role. Both are fine; the
> architecture (separate layout lib + our renderer) is the real decision.

---

## Decision & outcome (implemented)

The recommended architecture was built with **`d3-dag`** (not dagre) as the
layout library — actively maintained, TS-first, and the operator knobs let us
drop the LP-solver dependency. Concretely:

- Layout lives in `apps/web/src/components/WorkstreamGraph.tsx` (`computeLayout`),
  loaded via `React.lazy` + `Suspense` from `WorkstreamPanel.tsx` so `d3-dag`
  lands in its own chunk (~39 KB gzip) off the initial/board path. Shared
  status/role/label presentation was extracted to
  `apps/web/src/lib/workstreamPresentation.ts`, consumed by both the board cards
  and the graph.
- Operators: `sugiyama().layering(layeringLongestPath()).coord(coordGreedy())`
  with default solver-free `decrossTwoLayer`. The default `layeringSimplex` /
  `coordSimplex` (which pull in `javascript-lp-solver` + `quadprog`, ~142 KB) are
  _referenced by the `sugiyama()` factory's defaults_ and so still land in the
  lazy graph chunk even though they are overridden — acceptable because the chunk
  is never on the initial/board render path.
- `waits-on` (`blockedBy`) edges participate in ranking, but any edge that would
  make the graph non-acyclic (incl. self-edges) is added then backed out via
  `g.acyclic()`. **All** `waits-on` edges still render as dashed amber overlays
  regardless of whether they were fed to the layout.
- Top-down (TB) orientation, as recommended for the side panel. The panel now
  defaults to the Graph view.

## Future direction — when to switch to React Flow

This view is **deliberately read-only**: it visualises lineage + dependency
topology and nothing more. The SVG-plus-`d3-dag` architecture is the right tool
_for that scope_ and should not be incrementally grown into an editor.

Switch to **React Flow (`@xyflow/react`)** — a rewrite of the renderer, not an
extension of this SVG — the moment the product intent flips to an **editable
orchestration canvas**, i.e. any of:

- **drag-to-reposition** nodes (manual layout the user expects to persist);
- **drag-to-rewire** dependencies by pulling edges between node handles;
- **multi-select / marquee** and bulk operations on nodes;
- a **minimap** / large-canvas navigation because real orchestrations routinely
  exceed ~100 nodes;
- node-anchored connection **handles** as first-class interaction targets.

At that point React Flow's built-in pan/zoom/`fitView`/minimap/selection/drag
kit pays for its up-front cost (custom nodes rebuilt as RF components with
`Handle`s, a required CSS import, an internal store, and _still_ `d3-dag`/dagre
for the initial layout). Until then, do **not** bolt those behaviours onto this
SVG one at a time — that path reconstructs a worse React Flow by hand. Keep this
view minimal; when it must become editable, port it wholesale.

---

## Options compared

Bundle figures are min+gzip of the JS you ship, from Bundlephobia / UNPKG /
pkg-size (cited below); treat as approximate — they move with versions and
tree-shaking.

| Approach                                      | Bundle (min+gzip)                                              | Custom-node support                                           | True DAG (multi-parent / cross edges)?                             | Interaction included                                | License / maint.                       | Fit for us                                          |
| --------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------- | -------------------------------------- | --------------------------------------------------- |
| **Keep SVG + `@dagrejs/dagre`** (layout only) | **~40 KB** (incl. graphlib)                                    | Total — it's _our_ SVG, unchanged                             | **Yes** — layered Sugiyama, ranks + crossing minimisation          | None (we keep our pan/zoom)                         | MIT; stable but **low activity**       | ★ **Recommended**                                   |
| Keep SVG + `d3-dag` (layout only)             | **~30–40 KB**                                                  | Total — our SVG                                               | **Yes** — layered + unique algos (Zherebko/Grid), optimal crossing | None (keep ours)                                    | MIT; **actively maintained**, TS-first | ★ Strong alternative                                |
| Keep SVG + `d3-hierarchy` (layout only)       | **~7 KB**                                                      | Total — our SVG                                               | **No** — tree only; cannot place a node with two parents           | None (keep ours)                                    | ISC; stable, d3 core                   | ✗ Can't represent `waits-on`                        |
| Keep SVG + `elkjs` (layout only)              | **~1.3–1.5 MB** raw; ~140 KB gzip; needs **web worker**        | Total — our SVG                                               | **Yes** — best-in-class, orthogonal routing, ports, nesting        | None (keep ours)                                    | EPL; maintained (Eclipse/KIELER)       | ✗ Overkill / heavy for <100 nodes                   |
| Adopt **React Flow** (`@xyflow/react`)        | **~50 KB core + ~30 KB CSS + d3-zoom/drag + internal Zustand** | Yes, but **rewrite cards as RF node components** w/ `Handle`s | Renders any edges; **but still needs dagre/ELK to lay out**        | Pan, zoom, fitView, minimap, selection, drag — free | MIT; **very active**, 7M dl/wk         | ◐ Only if we want the free interaction kit          |
| Cytoscape.js / vis-network / Sigma.js         | ~120–400 KB+                                                   | Custom styling, not React cards (canvas/own DOM)              | Yes                                                                | Lots, free                                          | MIT/Apache; active                     | ✗ Heavier; canvas styling ≠ our HTML/Tailwind cards |
| Mermaid flowchart                             | ~500 KB+                                                       | No (renders its own SVG from text)                            | Yes                                                                | Minimal                                             | MIT; active                            | ✗ Doc tool, not an interactive app widget           |

### Why the layout-only libraries are the right _category_

Every good DAG tool separates three concerns — **layout** (assign coordinates),
**rendering** (draw nodes/edges), **interaction** (pan/zoom/select). React Flow's
own docs make this explicit: it does rendering + interaction but tells you to
bring a layout library (dagre, d3-hierarchy, d3-force, or ELK) because it "does
not come with a layouting solution" ([React Flow — Layouting][rf-layout]). Our
problem is _purely_ the layout concern — we already do rendering and interaction
fine. So the minimal fix is to add only the missing concern.

### Notes per candidate

- **`@dagrejs/dagre`** — the maintained scoped fork of the classic `dagre`.
  Pure JS layered (Sugiyama) layout for directed graphs; handles DAGs with
  cross edges. Dist ships an ESM build; min+gzip is in the ~40 KB range and it
  carries its own graphlib (no separate dep to add) ([Bundlephobia][bp-dagre],
  [UNPKG dist][unpkg-dagre]). Battle-tested (5.6k★, 2.9M dl/wk) and the de-facto
  default in React Flow's dagre example. Downside: **maintenance is slow** —
  stable, but don't expect new features. Known weak spot (edges to/from
  _parent/compound_ nodes) is irrelevant to us; we have flat nodes
  ([layout-engine summary][mckruz]).
- **`d3-dag`** — explicitly markets itself as "a fraction of elkjs's ~500 KB",
  TypeScript-first, with **optimal edge-crossing minimisation** and layout
  variants dagre lacks; advertised as a "drop-in replacement for dagre as a
  layout" ([d3-dag][d3dag]). Actively maintained by one author (≈2k★). This is
  the pick if upstream liveliness or TS ergonomics outweigh dagre's larger
  ecosystem of examples.
- **`d3-hierarchy`** — tiny (~7 KB) and excellent, but it lays out **trees**
  (`d3.tree`/`d3.cluster`), one parent per node. Our graph is a DAG _because_ a
  thread can `waits-on` siblings — those cross edges cannot be expressed, so a
  thread with a tree-parent _and_ a dependency can't be positioned by it. Use
  only if we ever decide waits-on edges are drawn as pure overlays on a strict
  tree (see Risks).
- **`elkjs`** — the most capable engine (orthogonal edge routing, ports, nested
  compound nodes), but it's transpiled Java/GWT: `elk.bundled.js` is ~1.3 MB and
  the recommended pattern is to run it in a **web worker** (async). A real-world
  agent-graph project measured exactly this: switching ELK to a worker shrank
  their graph chunk from **1.5 MB → 36 KB** ([agentviz commit][agentviz]). All
  that power buys orthogonal routing and compound nesting we don't need at
  <100 flat nodes. Over-engineering for this view.
- **React Flow (`@xyflow/react`)** — excellent library, wrong scope for us. It
  is rendering+interaction: pan, zoom, `fitView`, `<MiniMap>`, `<Controls>`,
  selection, draggable handles all come free ([Custom Nodes][rf-custom],
  [MiniMap][rf-minimap]). But: (1) custom nodes become **React components with
  explicit `Handle` source/target anchors**, i.e. we rebuild our cards in its
  model; (2) it still needs dagre/ELK for layout, so we'd add _both_; (3) it
  brings d3-zoom, d3-drag, an internal Zustand instance, and a required CSS
  import; (4) integrating dagre with RF custom nodes has a well-known wrinkle —
  you must measure rendered node dimensions out of RF's internal store before
  layout ([Coughlin][coughlin]). Net: more bundle, more surface, for interaction
  features a read-only lineage view mostly doesn't use.

---

## Design patterns worth stealing

Concrete, cited UX choices from well-regarded DAG/flow tools — and what to adopt:

1. **Layout direction: prefer top-down (TB) for a spawn tree; consider LR for
   deep chains.** Airflow's graph defaults to and is most robust in
   **Left-to-Right**; their own bug history shows other orientations are
   fragile ([Airflow #61384][af-orient]). Pick _one_ direction and commit to it.
   For an orchestrator→children spawn tree that fans out wide but shallow,
   **top-down** reads like a spawn hierarchy (root at top, generations descend);
   switch to **left-to-right** if chains get deep (LR uses horizontal space,
   which a narrow right-hand panel has less of — so TB is the safer default
   here). Dagre/d3-dag both take a `rankdir` parameter, so this is a one-line
   change to revisit later.

2. **Fit-to-content on load, then let the user take over.** This is exactly the
   `fitView` behaviour React Flow ships and what good tools do — frame the whole
   graph initially, stop auto-fitting once the user pans/zooms. **We already do
   this** (`computeGraphViewBox` + the `adjusted` flag + reset button); keep it.
   Just feed it dagre's real extents instead of the swimlane grid.

3. **Edges: smooth/bezier for tree edges, visually distinct dashed for
   dependencies.** We already render lineage as bezier and `waits-on` as dashed
   amber with arrowheads — keep that vocabulary. Airflow/Prefect treat
   "structural" vs "dependency/dataset" edges as separable layers the user can
   toggle ([Airflow dep edges][af-deps]); a future "show/hide waits-on" toggle
   is a cheap, high-clarity win when fan-out gets dense. Orthogonal (elbow)
   routing (ELK/n8n style) looks tidy but isn't worth ELK's weight here.

4. **Dependency-aware ranking, not status lanes.** Prefect explicitly rewrote
   their flow-run graph around a **"dependency layout"** for readability and perf
   ([Prefect #11112][prefect]). That is precisely our fix: rank by topology, not
   by status. Status belongs in **colour + a legend**, which we already have.

5. **Minimap only if it earns it.** React Flow's `<MiniMap>` is the canonical
   pattern for large canvases, but at <100 nodes in a side panel it's likely
   clutter. Skip for now; revisit only if real orchestrations get big.

6. **There is no vendored reference to copy.** AGENTS.md lists _CodexMonitor_ as
   a strong reference, but inspection of the cloned repo (`/tmp/pi-github-repos/
Dimillian/CodexMonitor`, also checked against `.repos/` which only contains
   `alchemy-effect` and `effect-smol`) shows it has **no graph/DAG library and no
   node-graph view at all** — no `reactflow`/`xyflow`/`dagre`/`elkjs`/`d3-dag`/
   `cytoscape` anywhere. It renders agent hierarchy as a **nested sidebar**
   (workspace groups → worktree cards → thread rows: `SidebarWorkspaceGroups`,
   `WorktreeSection`, `ThreadList`, `ThreadRow`). So there's no design to steal
   from it for this; the references above (React Flow, Airflow, Prefect) are the
   relevant ones.

---

## Recommended implementation sketch

Slots into `WorkstreamPanel.tsx` with surgical changes. The `WorkstreamGraph`
component's SVG, nodes, edges, pan/zoom, legend, and viewBox-fitting **all stay**.
Only the position source changes.

**Data → layout** (replaces `getGraphPositions`):

```text
buildLayout(activeThread, threads, childById):
  g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: "TB", nodesep: 28, ranksep: 64 })   // tune to taste
  g.setNode(ROOT_ID, { width: 160, height: 48 })            // orchestrator card
  for t in threads: g.setNode(t.id, { width: 126, height: 54 })  // our card size
  // lineage edges: parent -> child (root if parentThreadId is the orchestrator)
  for t in threads: g.setEdge(parentIdOf(t) ?? ROOT_ID, t.id)
  // waits-on cross edges participate in ranking so dependents sit below deps
  for t in threads, dep in t.blockedBy where dep != t.id && childById.has(dep):
    g.setEdge(dep, t.id, { class: "waits-on" })
  dagre.layout(g)
  return positions: Map<id, {x,y}> from g.node(id).{x,y}  // centres, as we use today
```

Dagre returns node **centres** in a content coordinate space — the same thing our
SVG already consumes (`x`, `y` are centres; rects are drawn at `x-63, y-27`). So
downstream code is nearly untouched.

**Render** — unchanged. `RootNode`, `GraphNode` (status colour, role icon,
truncated title, monospace sub-label), the bezier lineage `path`s, and the dashed
amber `waits-on` lines all keep rendering from the `positions` map exactly as now.

**Interaction** — unchanged. Keep our zero-dependency pan/zoom (`viewBox` drag,
wheel-zoom-at-cursor, reset/auto-fit via `adjusted`). Keep `computeGraphViewBox`
but compute extents from dagre's node list (it already does — it reads
`positions`), so fit-to-content "just works" with the new coordinates. Optionally
read `g.graph().width/height` for a tighter initial frame.

**What we delete:**

- `getGraphPositions` (the status-swimlane `columnIndex * 132` / `rowIndex * 84`
  grid — the root cause of edges sweeping at arbitrary angles).
- `getParentPosition`'s reliance on the swimlane array (dagre now owns parent
  placement; we just look parents up in the positions map / use ROOT for
  top-level children).
- Nothing else. Status styling, legend, the board view, and the dependency
  editor are all orthogonal and stay.

**Dependency added:** `@dagrejs/dagre` (+ `@types/dagre` if its bundled types
aren't sufficient). One package, ~40 KB, lazy-import it inside the graph module
so the board path doesn't pay for it. Consider `React.lazy`/dynamic `import()` of
the whole graph subtree so dagre lands in a separate chunk and never bloats the
initial load (addresses the existing large-chunk warnings).

---

## Risks / open questions for you to decide

1. **dagre vs d3-dag.** Both fit the recommended architecture identically. Dagre
   = bigger ecosystem, more examples, but sleepy maintenance. d3-dag = active,
   TS-first, slightly smaller, fewer copy-paste examples. **My default: dagre**
   (lowest friction, the React Flow docs/examples all assume it), but I'd switch
   to d3-dag without hesitation if you weight active maintenance highly. Your
   call.

2. **Layout direction (TB vs LR).** I recommend **top-down** for a side panel
   (vertical space is cheaper there and it reads as a spawn hierarchy). It's a
   one-param change; do you want a UI toggle, or just pick one?

3. **Should `waits-on` edges affect ranking, or be pure overlays?** Feeding them
   to dagre makes dependents rank _below_ their dependencies (clearer ordering)
   but can pull the tree shape around. Alternatively, lay out _only_ the lineage
   tree (even with `d3-hierarchy`, ~7 KB) and draw waits-on as non-layout
   overlay edges. Trade-off: topological-correctness of dependency order vs.
   tree tidiness. I lean "include them in ranking" (it's the honest DAG), but
   it's a judgement call worth confirming.

4. **Cycles.** `blockedBy` is user-editable; a `waits-on` cycle (A waits on B,
   B waits on A) would make the graph non-acyclic and dagre will still lay it out
   but ranking degrades. Low-stakes at our scale, but worth a tiny guard
   (drop/flag back-edges) if dependency editing is common.

5. **Bundle accounting.** Even ~40 KB is real. If you'd rather add _zero_ deps,
   a hand-rolled longest-path ranking + barycenter ordering is doable for
   <100 nodes (this is what dagre does, ~a few hundred lines). I don't recommend
   it — re-implementing crossing-minimisation is exactly the "code you shouldn't
   write" — but it's the no-dependency escape hatch if minimalism wins outright.

6. **Do we ever want the React Flow interaction kit** (draggable nodes, minimap,
   built-in selection, multi-select, edge handles)? If product direction is
   "this becomes an editable orchestration canvas," React Flow's up-front cost
   pays off and the recommendation flips. If it stays a **read-only lineage
   view**, the SVG + dagre path is clearly better. Confirm the product intent.

---

## Sources

- React Flow — Layouting overview (separation of concerns; dagre/d3/ELK options):
  <https://reactflow.dev/learn/layouting/layouting> [rf-layout]
- React Flow — dagre example: <https://reactflow.dev/examples/layout/dagre>
- React Flow — ELK example: <https://reactflow.dev/examples/layout/elkjs>
- React Flow — Custom Nodes: <https://reactflow.dev/learn/customization/custom-nodes> [rf-custom]
- React Flow — MiniMap: <https://reactflow.dev/api-reference/components/minimap> [rf-minimap]
- Coughlin — React Flow + dagre custom-node dimension wrinkle:
  <https://ncoughlin.com/posts/react-flow-dagre-custom-nodes> [coughlin]
- `@dagrejs/dagre` Bundlephobia: <https://bundlephobia.com/package/@dagrejs/dagre> [bp-dagre]
- `@dagrejs/dagre` dist (UNPKG): <https://app.unpkg.com/@dagrejs/dagre@2.0.4/files/dist> [unpkg-dagre]
- `@xyflow/react` registry (deps: d3-zoom, d3-drag, zustand): <https://registry.npmjs.org/%40xyflow%2Freact>
- d3-dag (small bundle, TS-first, dagre drop-in claim): <https://erikbrinkman.github.io/d3-dag/> [d3dag]
- elkjs (web-worker recommendation): <https://github.com/kieler/elkjs>
- agentviz — ELK in a worker shrank graph chunk 1.5 MB → 36 KB:
  <https://github.com/jayparikh/agentviz/commit/33cb8c340e51afd4504573edafd1e9b9ad940a56> [agentviz]
- ELK "only viable for compound graphs; 435 KB justified by capability" exec summary:
  <https://github.com/MCKRUZ/ArchitectureHelper/blob/master/layout-engine-executive-summary.md> [mckruz]
- Airflow — graph orientation robustness (LR is the safe default): <https://github.com/apache/airflow/issues/61384> [af-orient]
- Airflow — dependency edges as a toggleable layer: <https://github.com/apache/airflow/issues/42367> [af-deps]
- Prefect — "improved flow run graph with new dependency layout": <https://github.com/PrefectHQ/prefect/pull/11112> [prefect]
- CodexMonitor (inspected): `/tmp/pi-github-repos/Dimillian/CodexMonitor` — no graph
  library; hierarchy rendered as nested sidebar (`SidebarWorkspaceGroups`,
  `WorktreeSection`, `ThreadList`, `ThreadRow`). `.repos/` contains only
  `alchemy-effect` and `effect-smol`.
- Current implementation reviewed: `apps/web/src/components/WorkstreamPanel.tsx`
  (`WorkstreamGraph`, `getGraphPositions`, `computeGraphViewBox`).
