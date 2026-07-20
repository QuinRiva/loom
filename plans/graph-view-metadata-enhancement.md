---
manager_sessions:
  - id: ee32ce90-cdbf-4c1e-b265-013a362f20b3
    role: plan
    authored_at: 2026-07-20T07:20:26.201Z
---

# Graph view metadata enhancement — implementation plan

**Status:** ready for implementation
**Design source of truth:** `experiments/graph-node-metadata-mockup-v2.html` (v1 `graph-node-metadata-mockup.html` is superseded)
**Scope:** web client only — no server or contract changes (verified below).

---

## 1 · Design summary (the decided behaviour)

The workstream **graph view** becomes information-parity with the kanban board by
carrying the board's most valuable per-thread metadata on the graph's own
surfaces, state-aware:

1. **Node footer** — running/yielded nodes carry a compact always-on footer
   (`⚒ {toolUses} · {age}`, with a live pulse dot while a turn is in flight).
   Not-yet-run nodes (planned / awaiting brief / ready / blocked) have **no
   footer** — clean intent. Terminal nodes (done / cancelled) recede as today
   and drop the footer; their totals live in the hover card.
2. **The ⓘ affordance is removed entirely** from graph nodes. Single-click on a
   node still opens the thread (unchanged).
3. **Right-click context menu** replaces the ⓘ as the home of secondary
   actions (Open thread / View history / Open report / Release / Clear flags /
   Stop), state-aware. Keyboard path: the ContextMenu key or Shift+F10 on a
   focused node.
4. **Enriched hover card** (`WorkstreamQuickFacts`) — adds Tool calls, a
   provider+model pill, and Cost; shows the goal in full; the italic
   `› {lastActivityPreview}` turn line replaces the generic `getActivity()`
   phrase. Purely informational (actions live in the menu).
5. **Provider + model pill** — `{instanceId} · {model}` with a per-provider
   tint dot, because the same model on different providers is materially
   different. Used in the hover card and the active strip.
6. **Enriched active strip** — the chip's activity line becomes the
   `› {lastActivityPreview}` turn action; a meta row adds provider pill · cost
   · `⚒ tools`.
7. **Palette recolour** — `blocked` and the waits-on edge move from amber to a
   cool **steel** neutral (`#6d86a6`); warm hues (amber/orange/rose) are
   reserved for the human-attention overlay. Cool = passive, warm = "you".

Out of scope: the dense/taller running-node alternative (§6 of the mockup) —
footer-only is the chosen treatment; the dense node remains a possible future
option only. The board card is not redesigned, but it **inherits the blocked
recolour** through shared `STATUS_STYLES` — that is the intended, consistent
outcome (a passive dependency wait should read calm on both surfaces).

### Data availability (verified — no contract changes)

All required data already rides on the thread shell (surfaced to the web app
as `SidebarThreadSummary` = `EnvironmentThreadShell` →
`OrchestrationThreadShell`). The loom fields below live in
`packages/contracts/src/orchestration.loom.ts`; `modelSelection` is a required
field on `OrchestrationThreadShell` itself
(`packages/contracts/src/orchestration.ts`, which spreads
`LoomThreadShellFields`):

| Field | Shape | Notes |
| --- | --- | --- |
| `toolUses` | `number \| null` | null = unknown (non-pi provider / no snapshot yet), distinct from 0 |
| `cumulativeCostUsd` | `number \| undefined` | absent/0 when the provider reports no cost |
| `modelSelection` | `{ instanceId, model, options? }` | instanceId is a user-defined provider-instance slug |
| `lastActivityPreview` | `string \| null` | latest assistant-narration line; null before first narration |
| `reportPath` | `string \| null` | absolute markdown path; null until the child reports |
| `attention`, `planLane`, `blockedBy`, `routes`, `gateRounds`, `lastOutcome` | — | already consumed by the graph |
| running signal | `hasRunningSignal(thread)` (`workstreamRollup.ts`) | already consumed |

---

## 2 · Per-file change list

### 2.1 `apps/web/src/lib/workstreamPresentation.ts` (JSX-free helpers — all new logic testable here)

**Palette recolour (§7):**

- `STATUS_STYLES.blocked` becomes steel. Steel is not a stock Tailwind colour;
  use arbitrary-value classes (consistent with the file's hex-literal
  `graphStroke`/`graphFill` pattern; no new theme token needed for two call
  sites):

  ```ts
  blocked: {
    textClass: "text-[#9fb4cf]",          // was text-amber-300
    borderClass: "border-[#6d86a6]/40",   // was border-amber-400/40
    bgClass: "bg-[#6d86a6]/10",           // was bg-amber-400/10
    dotClass: "bg-[#6d86a6]",             // was bg-amber-400
    leftBorderClass: "border-l-[#6d86a6]",// was border-l-amber-400
    graphStroke: "#6d86a6",               // was #f59e0b
    graphFill: "rgba(109, 134, 166, 0.16)", // was rgba(245, 158, 11, 0.16)
  },
  ```

  `#9fb4cf` is the mockup's steel *text* tint (lighter for legibility on dark),
  `#6d86a6` the stroke/fill/dot hue — deliberately bluer than planned-slate
  `#94a3b8` and darker than ready-cyan so the three cool states stay separable.

- `WAITS_ON_STROKE = "#6d86a6"` (was `#f59e0b`). The
  `workstream-waits-arrow` marker fill, the dashed edge stroke, and the legend
  swatch in `WorkstreamGraph` all read this constant — they follow
  automatically. The board legend dot reads `STATUS_STYLES.blocked.dotClass` —
  also automatic.

- **Deliberately unchanged** (call out in the PR): `ATTENTION_STYLES`
  (amber/orange/rose/violet — now the *only* warm hues, per the design),
  `CHIP_AMBER` for the `needs_rework` verdict and the amber loop-edge tint
  (gate-verdict vocabulary, a live escalation signal, not a passive wait), and
  `FAN_IN_BADGE.conflict` amber (a merge conflict needs a human — warm is now
  *correct* for it). The active strip's `needsHuman` chip colour (`#fb923c`)
  is attention orange — stays.

**New formatters/helpers:**

- `formatCompactAge(iso: string): string` — `"23s"`, `"4m"`, `"3h"`, `"2d"`,
  `"—"` for unparseable. Same bucketing as `formatRelativeAge` minus the
  `" ago"` suffix (node footer real estate). Do **not** change
  `formatRelativeAge` (board + hover card keep the long form).
- `formatToolUses(n: number): string` — `"16"`, capped `"999+"` above 999 so
  the footer can never overflow into the badge corner.
- `getProviderTint(instanceId: string): string` — hex tint for the pill dot.
  A small known map (case-insensitive exact match on the slug) seeded with the
  mockup hues plus this repo's common instance ids:

  ```ts
  const PROVIDER_TINTS: Record<string, string> = {
    pi: "#38bdf8", codex: "#19c37d", openai: "#19c37d",
    claudeagent: "#d9895a", anthropic: "#d9895a", bedrock: "#d9895a",
    vertex: "#60a5fa", "google-vertex": "#60a5fa",
    cliproxy: "#e879a6", gemini: "#a78bfa",
  };
  ```

  Unknown slugs fall back **deterministically** — hash the slug into a fixed
  6-hue palette (e.g. `["#60a5fa","#e879a6","#19c37d","#d9895a","#a78bfa","#2dd4bf"]`)
  so an unrecognised instance id always gets the same tint. Instance ids are
  user-defined, so the fallback is the load-bearing path; the map is an
  aesthetic nicety.
- `getProviderModelParts(selection: ModelSelection): { provider: string; model: string }`
  — `provider = selection.instanceId`, `model = formatModelLabel(selection)`.
  **`formatModelLabel` is untouched** (the board card header keeps using it).
- `getNodeFooter(thread, column): { toolLabel: string | null; age: string; live: boolean } | null`
  — THE single state rule for the node footer (§3.2 below), so the render is a
  dumb consumer and the rule is unit-testable.
- `type WorkstreamNodeMenuAction = "open" | "history" | "report" | "release" | "clear-flags" | "stop"`
  and `buildNodeContextMenuItems(thread: SidebarThreadSummary): ContextMenuItem<WorkstreamNodeMenuAction>[]`
  — the state-aware action set (§4 below), pure and unit-testable.
  (`ContextMenuItem` comes from `@t3tools/contracts` — JSX-free, so it belongs
  here per the file's "board + graph share the vocabulary" charter.)

### 2.2 `apps/web/src/components/WorkstreamModelPill.tsx` (new, tiny)

Shared presentational pill (JSX, so it cannot live in `workstreamPresentation.ts`):

```tsx
export function WorkstreamModelPill({ selection }: { selection: ModelSelection })
```

Renders per the mockup: rounded-full pill, 6px tint dot (`getProviderTint`),
muted `{provider}` + `·` + `{model}` in mono ~9.5px, border/background derived
from the tint at low alpha (inline `style` with the hex + alpha suffixes, e.g.
`border: 1px solid ${tint}66; background: ${tint}1c` — avoids `color-mix`
support questions and arbitrary-class explosion for dynamic colours).
Consumed by `WorkstreamQuickFacts` and `WorkstreamActiveStrip`.

### 2.3 `apps/web/src/components/WorkstreamGraph.tsx`

**Remove the ⓘ affordance:**

- Delete the entire `ws-graph-inspect` sibling `<g>` from `GraphNode` (circle,
  dot, stem, hit rect, focus ring) and the `.ws-graph-inspect` rules from the
  `<style>` block (reveal-on-hover, focus, reduced-motion lines).
- **Delete the `onInspectThread` prop** from both `WorkstreamGraph` and
  `GraphNode` (and the panel's `onInspectThread={...}` pass-through). The ⓘ
  was its only caller inside the graph; "View history" is handled panel-side
  (`handleNodeContextMenu` → `setInspectedThreadId`, §2.4), so keeping the
  prop would leave it dead. The lifecycle drawer and its `inspectedThreadId`
  state are untouched — only the graph-side entry point changes.
- The comment on the badge row ("keeping the top-right corner free for the ⓘ
  control") and the header help text (`…click ⓘ to inspect its history`) are
  updated: `Click a node to open its thread; hover for its facts; right-click
  for actions.`

**Node footer (§3):**

- `GraphNode` computes `const footer = getNodeFooter(thread, status.column)`
  and, when non-null, renders inside the card-visuals `<g>` (so it recedes/
  fades with the card):
  - separator: `<line x1={node.x+12} y1={node.y+44} x2={node.x+node.w-12} y2={node.y+44} stroke="rgba(255,255,255,0.09)" strokeWidth={1} />`
  - live dot (only when `footer.live`): `<circle cx={node.x+17} cy={node.y+53} r={3} fill="#38bdf8" className="ws-footer-live" />`
    with a new opacity-pulse rule in the style block
    (`@keyframes wsFooterPulse { 0%,100%{opacity:1} 50%{opacity:0.35} }`),
    stilled under `prefers-reduced-motion` like the attention pulse.
  - footer text: mono `fontSize 8.5`, `fill rgba(255,255,255,0.72)`, x =
    `node.x + (footer.live ? 25 : 14)`, baseline `y = node.y + 56`. Content:
    `{footer.toolLabel ? `⚒ ${...} · ` : ""}{footer.age}` with the `·`
    separators in `rgba(255,255,255,0.25)` (two `<tspan>`s or sibling
    `<text>`s — implementer's choice; a single text with tspans is simplest).

**Context-menu + keyboard wiring:**

- New prop: `onNodeContextMenu: (thread: SidebarThreadSummary, position: { x: number; y: number }) => void`.
- On the **outer** `ws-graph-node` `<g>` (so pills/badges are included in the
  hit area): `onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); cancel the hover card (call onHoverEnd); onNodeContextMenu(thread, { x: event.clientX, y: event.clientY }); }}`.
  `preventDefault` suppresses the native browser menu; `stopPropagation` keeps
  the SVG canvas from ever seeing it. Bridge nodes and the empty canvas keep
  the native browser menu (no handler) — the menu is a *thread-node* affordance.
- Keyboard path on the `ws-graph-open` focusable `<g>`'s existing `onKeyDown`:

  ```ts
  if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    onNodeContextMenu(thread, { x: rect.left + rect.width / 2, y: rect.bottom });
  }
  ```

  This is the standard context-menu key pair; it anchors the menu to the node
  itself for keyboard users. (See §5 Accessibility.)
- Hover-card interplay: opening the menu must first cancel the hover
  dwell/card (`onHoverEnd`) so the facts card never sits under the menu.

**Recolour:** nothing graph-side beyond the constants — the waits-arrow marker
fill, dashed-edge stroke, and legend already read `WAITS_ON_STROKE` /
`STATUS_STYLES`.

### 2.4 `apps/web/src/components/WorkstreamPanel.tsx` (owns the menu handler — no new component, no new state)

**Key implementation decision — reuse the app's canonical context-menu
mechanism instead of building `WorkstreamNodeContextMenu.tsx`.** The app
already ships a shared context menu: `readLocalApi().contextMenu.show(items, {x, y})`
resolves to the **native desktop menu** under Electron (`desktopBridge`) and to
the DOM fallback `showContextMenuFallback` (`apps/web/src/contextMenuFallback.ts`)
in the browser. The fallback already implements close-on-Escape,
close-on-outside-pointer, close-on-second-contextmenu, viewport clamping
(`clampMenuPosition` — the "viewport flip" requirement), destructive/disabled/
header/icon item support, and is covered by `contextMenuFallback.test.ts`.
`apps/web/src/loom/ThreadTabsStrip.tsx` (`handleContextMenu`) is the exact
precedent: build `ContextMenuItem[]`, `await api.contextMenu.show(...)`,
`switch` on the result.

Building a bespoke overlay component would duplicate all of that
(AGENTS.md: shared logic first, duplicate logic is a code smell) and would be
*worse* on desktop, where users get the native menu for every other
right-click in the app. Consequently there is **no menu-open state at all** —
the promise-based API replaces it. The handler lives in `WorkstreamPanel`
because every action maps to a handler the panel already owns.

```ts
const handleNodeContextMenu = async (
  thread: SidebarThreadSummary,
  position: { x: number; y: number },
) => {
  const api = readLocalApi();
  if (!api) return;
  const action = await api.contextMenu.show(buildNodeContextMenuItems(thread), position);
  switch (action) {
    case "open":        openThread(thread); break;
    case "history":     setInspectedThreadId(thread.id); break;   // existing drawer path
    case "report":      if (thread.reportPath) openReport(thread.reportPath); break;
    case "release":     setLane(thread.id, "ready"); break;
    case "clear-flags": clearAttention(thread.id); break;
    case "stop":        stopThread(thread.id); break;
    case null:          break;                                     // dismissed
  }
};
```

Passed to the graph as `onNodeContextMenu={(thread, pos) => void handleNodeContextMenu(thread, pos)}`.
Update the panel's "Graph gesture map" comment (it still narrates the ⓘ).

### 2.5 `apps/web/src/components/WorkstreamQuickFacts.tsx`

- **Goal in full:** drop `line-clamp-3` on the purpose block. Purposes are
  1–3 sentences by convention; as an overflow guard against pathological
  purposes, add `max-h-[40vh] overflow-hidden` to the card (the imperative
  positioner already measures `offsetHeight` and flips, so a bounded card
  keeps positioning sane).
- **Rows** (per mockup §2): keep `Status`; **drop the `Role` row** (redundant —
  the card header's uppercase role label already says it; the mockup drops it);
  **replace the `Last activity` row** with the turn line below; add:
  - `Tool calls`: `⚒ {toolUses}` mono when `toolUses !== null`; italic muted
    `not started yet` when the thread has never run (see state rules §3.3);
    `—` when it ran/is running but the provider reports no tool count.
  - `Model`: `<WorkstreamModelPill selection={thread.modelSelection} />`.
  - `Cost`: `formatCostUsd(thread.cumulativeCostUsd) ?? "—"` mono.
  - Keep the conditional `Gate rounds` / `Fan-in` / `Forked from` rows.
- **Turn line** (replaces the `getActivity()` row — remove that import): a
  bordered-top block after the `<dl>`:
  - has `lastActivityPreview` → `› {preview}` italic, with
    `· {formatRelativeAge(getLastActivityAt(thread))}` inline muted;
  - running but no preview yet → muted italic `starting…`;
  - never run → muted italic `no turns yet`;
  - ran/idle with no preview (non-pi narration gap) → muted `—`.
- **Chips row** (verdict / attention badges / gate wait): unchanged.
- **Footer hint:** `click to enter · right-click for actions` (drop the ⓘ
  reference). The card stays `pointer-events-none` — purely informational
  (Option B keeps actions in the menu).

### 2.6 `apps/web/src/components/WorkstreamActiveStrip.tsx`

Chip layout per mockup §3 (structure changes, behaviour — filter, sort,
click-to-open — unchanged):

- **Top row:** title (truncate) + `formatRelativeAge(getLastActivityAt(thread))`
  right-aligned (`ml-auto`, ~9.5px, white/32).
- **Turn line** (replaces the `getActivity()` + inline-age line; note the
  imports all STAY — `getActivity` remains the attention-no-preview fallback
  below, and `getLastActivityAt`/`formatRelativeAge` move to the top row):
  pulse dot in the chip colour + italic 2-line-clamped text:
  - `› {lastActivityPreview}` when present (this carries the "why" for
    attention chips too — no more spelled-out `awaiting your acceptance`);
  - running with no preview → muted `starting…`;
  - attention-flagged with no preview (rare) → fall back to the short
    `getActivity()` phrase so the chip is never blank.
- **Meta row** (new): mono ~9.5px white/40 —
  `<WorkstreamModelPill/>` `·` `{formatCostUsd(...)}` `·` `⚒ {toolUses}`,
  omitting any null segment (and its separator) rather than printing `—` (the
  strip is a glance surface; the hover card is where honest degradation shows).
- Attention chips keep the warm border/gradient treatment and first-sort.

### 2.7 `apps/web/src/lib/forkJoinLayout.ts`

- `NODE_H = 66` (from 56). That is the whole change — every port, centre,
  loop-channel, viewBox and nested-block computation derives from the
  constant. See §3.1 for why the bump is uniform (not per-state).

---

## 3 · Node layout analysis

### 3.1 `NODE_H` decision: grow uniformly 56 → 66

**Why it must grow:** at 56, the footer baseline would have to sit at ~y+51,
and the bottom-straddling verdict pill (`GatePill` at `yCenter = y + h`, 13px
tall → covering y+49.5…y+62.5, up to ~102px wide right-aligned) would overlap
the footer text region on any gate-source node that is yielded/running — a
real, common state (a reviewer that just submitted `needs_rework`). The
bottom-right badge row (circles at cy `y+h−12`, spanning y+36…52 at h=56)
additionally leaves no clean horizontal band.

**Why uniform (not "only running nodes grow"):** the layout is memoised on a
*structural* key that deliberately excludes status
(`WorkstreamGraph.tsx` `structureKey`; "Layout depends only on structure").
Per-state heights would make node geometry a function of live status —
re-running the whole fork–join layout on every lane/turn transition and making
cards jump as threads start/finish. A uniform +10px preserves the structural
invariant; idle nodes get a little breathing room, which the mockup's visual
balance tolerates (its idle cards are `min-height` anyway).

**Cascade check (all safe, all derived from the constant):** member card
centres (`NODE_H / 2`), loop-channel ports (`source.y + NODE_H / 2` bottoms),
nested-block offsets (`NODE_H + nestVGap`), gate pills (`node.y + node.h`),
badge row (`node.y + node.h − 12`), focus rings and viewBox bounds all use
`node.h`/`NODE_H`. `forkJoinLayout.test.ts` does not hardcode 56. `BRIDGE_H`
(46) is untouched.

### 3.2 Footer geometry (all offsets relative to node origin, h = 66)

| Element | Spec |
| --- | --- |
| head (dot cy 17, icon/title baseline 21) | unchanged |
| subline baseline (role · status, 8.5 mono) | 39 — unchanged |
| **separator line** | y 44, from x 12 to x w−12, `rgba(255,255,255,0.09)`, width 1 |
| **live dot** (running only) | cx 17, cy 53, r 3, `#38bdf8`, opacity pulse |
| **footer text** | 8.5px mono, baseline y 56; x 25 with dot, x 14 without; text `rgba(255,255,255,0.72)`, separators `rgba(255,255,255,0.25)` |
| badge row (⑂ / fan-in / consult) | cy h−12 = 54 (circles span y 46…62) — clears the separator (44); no horizontal collision: footer maxes at ~x 81 (`⚒ 999+ · 23h`), the worst-case 3-badge row starts at x ≈ 86 |
| verdict pill (straddles bottom) | top edge y 59.5 — footer descenders end ≈ y 59; clears |
| gate-wait pill (straddles top) | unchanged, never collides |

### 3.3 State-aware rendering rules (explicit conditions)

Let `column = getThreadStatus(thread, byId).column`,
`running = hasRunningSignal(thread)`, `hasRun` = the thread has ever executed
(operationally: `column` is `in_progress`/`yielded`/`done`/`cancelled`, or
`toolUses !== null`).

| Surface | planned / awaiting_brief / ready / blocked | in_progress | yielded | done / cancelled |
| --- | --- | --- | --- | --- |
| **Node footer** | none (clean intent) | shown; live dot iff `running`; `⚒ n` iff `toolUses !== null`; age always | shown (no live dot unless a resume is in flight) | none; card recedes to 0.42 as today |
| **Hover card — Tool calls** | `not started yet` (italic muted) | `⚒ n`, or `—` if `toolUses === null` | same | `⚒ n` (totals) or `—` |
| **Hover card — Cost** | `—` | `formatCostUsd ?? "—"` | same | same |
| **Hover card — turn line** | `no turns yet` | `› preview · age`, else `starting…` | `› preview · age`, else `—` | `› preview · age`, else `—` |
| **Active strip** | (not shown — strip filters to running/attention) | turn line + meta row | only if attention-flagged | not shown |
| **Menu items** | see §4 conditions | §4 | §4 | §4 |

`getNodeFooter` encodes the footer row exactly:

```ts
export function getNodeFooter(thread, column) {
  if (column !== "in_progress" && column !== "yielded") return null;
  return {
    toolLabel: thread.toolUses !== null ? formatToolUses(thread.toolUses) : null,
    age: formatCompactAge(getLastActivityAt(thread)),
    live: hasRunningSignal(thread),
  };
}
```

---

## 4 · Context-menu action set (and justification)

Built by `buildNodeContextMenuItems(thread)`; grouped by a disabled-header-free
separator convention (the shared menu supports plain ordering; keep navigation
first, controls after — on the DOM fallback there is no separator primitive,
so ordering alone carries the grouping):

| Item | id | Condition | Rationale |
| --- | --- | --- | --- |
| Open thread | `open` | always | mirrors click; the menu must contain the primary action for keyboard users |
| View history | `history` | always | the ⓘ's replacement → existing `onInspectThread` drawer |
| Open report | `report` | `thread.reportPath !== null` | the single most-wanted artefact of a finished child; hidden (not disabled) when absent — an item that can never be actioned is noise |
| Release | `release` | `thread.planLane === "planned"` | **in scope**: the one state-mutating action a held node needs; without it the graph forces a view-switch to the board for the commonest staged-graph gesture; handler (`setLane(id, "ready")`) already exists |
| Clear flags | `clear-flags` | `attentionReasonsOf(thread).length > 0` | **in scope**: pairs with the attention pulse the graph itself renders — the surface that shows the flag should offer the acknowledgement; handler exists |
| Stop | `stop` | `hasRunningSignal(thread)` | `destructive: true`; mirrors the board's Stop (interrupt + needs_guidance) |

Excluded deliberately: lane select (a four-way choice doesn't fit a menu item;
board owns it), dependency editing (needs the sibling checklist UI), spawn.
The menu tops out at 6 items in the richest state — comfortably within the
"scales past the hover card" rationale for Option B.

Conditions are **presence** conditions (item omitted), not `disabled`
flags — a right-click menu on a small node should be short, and the state that
justifies each item is invisible-when-absent anyway.

---

## 5 · Accessibility plan

- **Keyboard path to every removed-ⓘ action:** each node's primary `<g>`
  (`ws-graph-open`) is already `tabIndex={0}` with Enter/Space → open. Add
  `ContextMenu` key and `Shift+F10` → `onNodeContextMenu` anchored to the
  node's rect (§2.3). On desktop the native menu is fully keyboard-navigable;
  the DOM fallback renders real `<button>` elements (Tab/Enter traversal,
  Escape closes). This keeps history/report/stop/release/clear-flags fully
  keyboard-reachable — better than the old ⓘ, which only exposed history.
- **Focus management:** the promise-based menu API leaves DOM focus where it
  was; after an action or dismissal, focus remains on the node's `<g>` (no
  restoration dance needed — verify in live testing; if the fallback steals
  focus, refocus `event.currentTarget` after the promise resolves).
- **Screen-reader semantics:** unchanged `role="group"`/`role="button"`
  structure, minus one sibling button (the ⓘ) — the tab order actually
  simplifies. The footer is decorative metadata inside the card visuals; the
  node's `aria-label` (`{role} {title}`) is unchanged.
- **Reduced motion:** the new footer live-dot pulse joins the existing
  `prefers-reduced-motion` block (animation: none, full opacity), like the
  attention pulse.

---

## 6 · Edge cases

- **`toolUses === null` while running** (non-pi provider): footer shows the
  live dot + age only; hover card shows `—`; strip meta row omits the segment.
- **No cost** (`cumulativeCostUsd` absent/0): `formatCostUsd` returns null →
  hover card `—`, strip omits. Never invent `$0.00`.
- **`lastActivityPreview === null`:** per-surface fallbacks in §3.3 —
  `starting…` only when actually running; never-run nodes say `no turns yet`.
- **`reportPath` missing:** menu item omitted. Also guard the action:
  `openReport` already no-ops via `isAbsolutePreviewablePath`.
- **Attention + running simultaneously:** attention pulse ring and footer
  live dot coexist (different elements, different colours); the strip chip
  keeps warm treatment with the live turn line.
- **Terminal recede × hover highlight:** unchanged mechanics — the footer
  renders inside the card-visuals `<g>` whose opacity carries recede/fade, and
  terminal nodes have no footer anyway.
- **Menu near viewport edges:** native menus self-position; the DOM fallback
  clamps via `clampMenuPosition`. No new code.
- **Right-click on bridge nodes / canvas:** native browser menu (untouched) —
  the affordance is thread-node-only.
- **Right-click while hover card open:** cancel the hover card before showing
  the menu (§2.3).
- **Very long purpose:** unclamped goal bounded by the card's new
  `max-h-[40vh] overflow-hidden` guard; the positioner already flips using
  measured height.
- **toolUses > 999:** `formatToolUses` caps at `999+` so the footer can't
  reach the badge corner.
- **`getLastActivityAt` on a never-run node** falls back to `createdAt` — fine
  everywhere it's shown (footer never shows on never-run nodes).

---

## 7 · Testing plan

Convention notes: unit tests live beside the lib
(`apps/web/src/lib/*.test.ts`, `vite-plus/test`); component tests use
`renderToStaticMarkup` assertions (see `ThreadStatusIndicators.test.tsx`) — no
jsdom interaction harness, so interaction logic must live in pure helpers
(which this plan does deliberately).

**New unit tests — `workstreamPresentation.test.ts`:**

- `getNodeFooter`: null for planned/awaiting_brief/ready/blocked/done/cancelled;
  present for in_progress/yielded; `toolLabel` null when `toolUses` null;
  `live` tracks `hasRunningSignal` (in_progress running vs yielded idle).
- `formatCompactAge`: second/minute/hour/day buckets, `—` on garbage.
- `formatToolUses`: passthrough + `999+` cap.
- `getProviderTint`: known slug (case-insensitive) → mapped hue; unknown slug →
  deterministic (same input twice ⇒ same output; two different unknowns from
  the palette).
- `getProviderModelParts`: instanceId + slug-tail; `formatModelLabel`'s
  existing tests continue to pass untouched.
- `buildNodeContextMenuItems`: richest state (planned+attention+report+running
  is impossible — use realistic combos): base = open+history; +report when
  reportPath; +release when planned; +clear-flags when attention; +stop
  (destructive) when running; omitted otherwise.
- `STATUS_STYLES.blocked` / `WAITS_ON_STROKE`: assert the steel hexes (cheap
  drift guard for the palette contract).

**New component tests (static markup):**

- `WorkstreamQuickFacts`: a running thread with preview/cost/tools renders
  `⚒`, the pill provider text, `$…`, the `›` turn line, and no `line-clamp-3`
  class; a planned thread renders `not started yet` / `—` / `no turns yet`;
  footer hint contains `right-click` and no `ⓘ`.
- `WorkstreamActiveStrip` chip: turn line renders preview (or `starting…`),
  meta row omits null cost/tools segments.

**Existing tests to check/update:**

- `forkJoinLayout.test.ts`: no hardcoded 56 — should pass; eyeball any
  geometry expectations after the `NODE_H` bump.
- No existing test asserts amber for `blocked` (verify with a grep for
  `amber` in the two workstream test files) — update if found.

**Live verification (required — UI-affecting):** the dev-verify recipe
(`docs/dev-site-testing.md`), seeded workstream
(`apps/server/src/dev/seedWorkstream.ts` — check it seeds running +
gate-source + planned + attention states; extend the seed if it lacks a
running thread with `toolUses`). Verify: footer on running/yielded only; no ⓘ;
right-click menu per state incl. Escape/click-outside/edge clamping;
Shift+F10 on a focused node; hover card full goal + pill + turn line; strip
meta row; steel blocked node + waits-on edge + legend; board card inherits
steel. `vp check` and `vp run typecheck` must pass.

---

## 8 · Staged implementation sequence

Each step is independently reviewable and leaves the app working:

1. **Palette recolour** — `STATUS_STYLES.blocked` + `WAITS_ON_STROKE` steel;
   drift-guard test. (Board inherits; graph legend/marker follow constants.)
2. **Pure helpers + tests** — `formatCompactAge`, `formatToolUses`,
   `getProviderTint`, `getProviderModelParts`, `getNodeFooter`,
   `buildNodeContextMenuItems` (+ `WorkstreamNodeMenuAction`).
3. **Node footer + `NODE_H` 66 + ⓘ removal** — `forkJoinLayout.ts` constant,
   `GraphNode` footer render, delete the inspect `<g>`/styles and the
   now-dead `onInspectThread` prop chain, update help text/comments.
4. **Context menu** — graph `onNodeContextMenu` prop + pointer/keyboard
   emitters; panel `handleNodeContextMenu` via `localApi.contextMenu.show`.
5. **Hover card enrichment** — `WorkstreamModelPill.tsx`, QuickFacts rows/turn
   line/footer hint; component tests.
6. **Active strip enrichment** — chip restructure + meta row; component test.
7. **Live verify** (dev-verify recipe) + `vp check` / `vp run typecheck`.

Steps 1–2 are pure presentation-layer and can land together; 3–6 each touch
one component. If review prefers a single PR, keep the commits in this order.

**Rollback:** every change is client-side and additive/presentational — no
migrations, no contract changes, no persisted-state shape changes (the graph's
saved viewBox is dimensionless and survives the `NODE_H` bump; at worst a
saved zoom shows slightly different framing once). A revert of the branch
restores the previous UI wholesale; individual steps are also independently
revertable since only step 2's helpers are shared downstream.

---

## 9 · Judgement calls made in this plan (vs. the brief's sketch)

1. **No `WorkstreamNodeContextMenu.tsx`, no lifted menu state.** The brief
   suggested a bespoke overlay component with panel-owned state; the codebase
   already has a canonical, tested context-menu mechanism
   (`localApi.contextMenu.show` → native menu on desktop / DOM fallback with
   Escape, outside-click, clamping) used by `ThreadTabsStrip`. Reusing it
   deletes an entire component, all menu state, and all positioning/dismissal
   code, and gives desktop users the native menu. The interaction contract
   (right-click → state-aware actions, preventDefault, keyboard path) is
   unchanged — this is an implementation substitution, not a design change.
2. **`Release` and `Clear flags` are IN the menu** (conditions in §4) — the
   graph renders the states that motivate them (planned nodes, attention
   pulses) and both handlers already exist on the panel.
3. **`NODE_H` grows uniformly to 66** rather than per-state, to preserve the
   structural-memoisation invariant of the layout (§3.1).
4. **Steel implemented as arbitrary-value Tailwind classes** (`#6d86a6` stroke
   family, `#9fb4cf` text) rather than a new theme token — two call-site
   families don't justify a token; the file already carries hex literals for
   graph colours.
5. **Verdict-amber, loop-edge amber, and fan-in-conflict amber are kept** —
   the recolour scope is exactly `blocked` + waits-on; those three are
   escalation/attention vocabulary, which is what warm now means.
6. **QuickFacts drops its `Role` row** (mockup does; the card header already
   states the role) — noted here since the brief didn't say it explicitly.
