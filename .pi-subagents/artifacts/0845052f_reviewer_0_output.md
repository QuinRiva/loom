Review complete. The change is small, well-commented, and correct. Findings below.

## Assessment

**Wiring is correct and consistent.** The new `onOpenHistory` gesture calls `setInspectedThreadId(thread.id)` (WorkstreamPanel.tsx:406), which is byte-for-byte identical to the existing `"history"` context-menu action (WorkstreamPanel.tsx:266). So middle-click and the right-click "View history" now share one code path. Both call sites of `WorkstreamGraph` (panel + preview fixture) supply the new required prop; `tsc` clean confirms no missed sites.

**1. Event handling — no pitfalls.**

- Autoscroll: suppressed via `onMouseDown` `preventDefault()` for `button === 1` (WorkstreamGraph.tsx:871). Standard and correct.
- Open on `onAuxClick`, filtered to `button === 1`, with `preventDefault()` + `stopPropagation()` (WorkstreamGraph.tsx:874). Right-button auxclick is ignored, so the context menu (`onContextMenu`) is untouched.
- Pan conflict: none. Pan uses **Pointer Events** (`onPointerDown`, WorkstreamGraph.tsx:298) and bails early when the target is inside `.ws-graph-node` (line 299). The node's middle-click uses **Mouse Events**; the two event families don't cross-trigger, and the node guard prevents a pan from starting on the card.
- Bubbling to SVG canvas: the canvas has no `onMouseDown`/`onAuxClick`, so the un-stopped mousedown is harmless; the auxclick is stopped anyway.

**2. Drawer switch-while-open works.** The drawer's `open` is `inspectedInSubtree !== null` and its `thread` is derived from that id (WorkstreamPanel.tsx:416-417). Re-pointing `inspectedThreadId` to a different node re-renders the drawer against the new thread and re-runs `useThreadLifecycle` for it — switching histories with no reselect, as intended. The stale-target guard (line 166-169) still resets cleanly if the new node leaves the subtree.

**3. Accessibility — additive, no regression.** Middle-click has no keyboard equivalent, but keyboard users retain "View history" through the context menu (`ContextMenu` / `Shift+F10`, WorkstreamGraph.tsx). The gesture only adds an affordance.

## Findings

Must-fix: **none.**

Nice-to-have:

- The hint text now advertises "middle-click for its history" to all users (WorkstreamGraph.tsx:328), including trackpad/touch users who may lack a physical middle button. Cosmetic only — the fallback (context menu) still exists. Not worth changing unless the team wants gesture hints gated by input capability.

Code quality is in keeping with the file's conventions: minimal, thoroughly commented rationale, mirrors the existing `openMenu` helper with a parallel `openHistory` helper. No over-engineering.
