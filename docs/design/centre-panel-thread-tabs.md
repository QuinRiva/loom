---
manager_sessions:
  - id: a7e27399-32a6-40f4-a776-d162a6512388
    role: plan
    authored_at: 2026-07-20T02:55:24.132Z
---

# Centre-panel thread tabs — design

**Status:** awaiting human sign-off before implementation.
**Feature:** threads open as tabs in the centre panel, mirroring how the right panel tabs its
surfaces, so switching between threads (especially subthreads reached via the workstream
surface) stops being a full centre-panel swap with no way back.

This document synthesises the two exploration reports (UX/interaction model; router↔store
architecture) into one set of **decisions**. Where the explorations disagreed, the resolution
is stated and marked. Items that need explicit human sign-off are collected in
[§10](#10-decisions-needing-explicit-human-sign-off).

Terminology: right panel = **surfaces**; centre panel = **tabs**, each backed by a
`ScopedThreadRef`. Keep the words distinct in code and UI.

---

## 1. The store: `threadTabsStore`

### 1.1 Location and tier

- **File:** `apps/web/src/loom/threadTabsStore.ts` (+ colocated test). This is a loom feature,
  so it lives behind the fork seam per `plans/2026-07-07-fork-seam-campaign.md`; splices into
  upstream files carry `// loom:` markers.
- **Tier classification** (against `docs/architecture/loom-ui-state-tiers.md`): **Tier 1 —
  durable UI store** (persisted zustand, versioned `migrate`, `removeThread` parity action).
  One deliberate variance from the Tier-1 exemplars: the store is **workspace-scoped, not
  keyed by `scopedThreadKey`** — it _contains_ many thread refs rather than being scoped under
  one. That is inherent to the feature (the open set spans threads) and does not change the
  tier's obligations: versioned migration, no absence-based sweep, `removeThread` hook, and the
  seed-not-override write policy (§3.4).

### 1.2 Scope: one global open-set (decision)

One workspace-global ordered list whose entries are full `ScopedThreadRef`s, identity =
`scopedThreadKey(ref)` (`${environmentId}:${threadId}`). Not per-environment: tabs must not
vanish when the user switches connection, and the ref already namespaces across environments.
The tab UI shows the environment label only when it differs from the primary environment (same
rule the sidebar row uses via `isRemoteThread`). _(Both explorations recommend this; flagged
for sign-off in §10.1 because it is a product call.)_

Draft threads (`/draft/$draftId`) are **not** tabbed in v1: they have no `ScopedThreadRef`
until promoted, at which point the first navigation to the server thread seeds a tab normally.

### 1.3 Shape

```ts
// apps/web/src/loom/threadTabsStore.ts
const THREAD_TABS_STORAGE_KEY = "t3code:thread-tabs:v1";
const THREAD_TABS_STORAGE_VERSION = 1;

interface ThreadTabsState {
  /** Ordered open set. Identity = scopedThreadKey(ref). No duplicates. */
  tabs: ScopedThreadRef[];
  /** scopedThreadKey of the active tab — a pure mirror of the URL (§3). */
  activeKey: string | null;
  /** scopedThreadKey of the transient preview tab, if any; always ∈ tabs (§2). */
  previewKey: string | null;
  /** Keys in most-recently-activated-first order; drives cap eviction (§7.1). */
  mru: string[];
  /** Recently closed refs, most recent first, cap 10; backs tab.reopenClosed (§5). */
  recentlyClosed: ScopedThreadRef[];

  /** Route-driven seed: append-if-absent (persistent) + activate. Never reorders. */
  seedActiveTab: (ref: ScopedThreadRef) => void;
  /** Explicit open with intent; dedupes by key (activates existing rather than duplicating). */
  openTab: (ref: ScopedThreadRef, mode: "preview" | "persistent") => void;
  /** Promote the preview tab to persistent (clears previewKey if it matches). */
  pinTab: (ref: ScopedThreadRef) => void;
  /**
   * Remove a tab; push onto recentlyClosed. Returns the neighbour-fallback ref to
   * navigate to when the closed tab was active (null ⇒ set emptied), so the caller
   * owns navigation (§3.3).
   */
  closeTab: (ref: ScopedThreadRef) => ScopedThreadRef | null;
  closeOthers: (ref: ScopedThreadRef) => void;
  closeToRight: (ref: ScopedThreadRef) => void;
  closeAll: () => void;
  /** Pop recentlyClosed; opens it persistent. Returns the ref to navigate to (or null). */
  reopenClosedTab: () => ScopedThreadRef | null;
  /** Drag-reorder. Reordering the preview tab pins it. */
  reorderTab: (ref: ScopedThreadRef, toIndex: number) => void;
  /** Parity hook for a future real thread-deletion path. NOT called from any sweep. */
  removeThread: (ref: ScopedThreadRef) => void;
}
```

List mechanics (index-nearest close fallback `list[Math.min(index, len - 1)]`, close-others,
close-to-right, dedupe-on-open) replicate `rightPanelStore` semantics exactly. To honour the
no-duplication rule, extract them as **pure helpers in a new
`apps/web/src/lib/tabListOps.ts`** consumed by `threadTabsStore`; migrating
`rightPanelStore.closeSurface`/`closeOtherSurfaces`/`closeSurfacesToRight` onto the same
helpers is a desirable **follow-up**, deliberately not bundled into this change to keep the
diff reviewable.

### 1.4 Persistence, versioning, migration

- `persist` with `createJSONStorage(() => resolveStorage(window.localStorage))` — identical
  plumbing to `rightPanelStore`.
- Key `t3code:thread-tabs:v1`, `version: 1`,
  `partialize: ({ tabs, activeKey, previewKey, mru, recentlyClosed }) => ...`.
- `migratePersistedThreadTabs(persistedState: unknown)` — exported and unit-tested like
  `migratePersistedRightPanelState`. It must, defensively:
  - keep only entries that are well-formed `{ environmentId: string, threadId: string }`
    (non-empty strings), deduped by key, preserving order;
  - null `activeKey` / `previewKey` if they don't point into the surviving `tabs`;
  - filter `mru` to surviving keys; filter `recentlyClosed` to well-formed refs, cap 10;
  - apply the tab cap (§6.4) on load.
- On reload the router restores the URL and the seed effect re-derives `activeKey`; the
  persisted `activeKey` is only a continuity hint (e.g. for close-fallback ordering) and
  **never overrides the URL**.

---

## 2. Open vs pin: preview-tab semantics (decision — resolves the main divergence)

**Adopt VS Code-style preview tabs.** The UX exploration recommended them; the architecture
exploration's store sketch omitted them. Resolution: **include the preview slot**, because it
is what preserves today's "sidebar click = replace the centre panel" feel — without it, casual
sidebar browsing piles up tabs and the feature punishes the most common navigation gesture.
The cost is one nullable key plus one branch in `openTab`.

Semantics:

- **Preview open** (`openTab(ref, "preview")`): if a preview tab exists, it is **replaced in
  place at the same index**; otherwise the tab is appended. `previewKey` set. At most one
  preview tab exists.
- **Persistent open** (`openTab(ref, "persistent")` or route seed): appended at the end;
  `previewKey` untouched (unless it referenced the same key — then it is promotion).
- **Already open** (either mode): activate the existing tab, never duplicate — mirror of
  `upsertSurface`'s dedupe. A persistent open of the current preview key **pins** it.
- **Promotion to persistent** (`pinTab`), triggered by: double-click on the **tab**, sending a
  message in that thread's composer, or drag-reordering the preview tab. _Not_ double-click on
  the sidebar row — that is already inline-rename (collision flagged by UX; resolution: the
  row keeps rename, the tab owns pin-by-double-click; §10.4).
- **Rendering:** preview tab label in italic (VS Code convention), otherwise identical.

### 2.1 Who opens what (intent table)

| Entry path                                                                        | Mechanism                                                      | Result                                         |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------- |
| Sidebar single-click                                                              | row handler calls `openTab(ref, "preview")` **then** navigates | reuses the preview slot (transient)            |
| Subthread nav from workstream surface / toasts / usage table / lineage breadcrumb | unchanged — they just `navigate(...)`                          | route seed appends a **persistent** tab (§3.1) |
| Command palette "Go to thread"                                                    | unchanged — navigates                                          | persistent tab via seed                        |
| Deep link / reload / back-forward                                                 | router only                                                    | persistent tab via seed                        |
| Tab click                                                                         | `navigate(...)` only (§3.2)                                    | activates existing tab                         |

Only **one** call site changes for intent (the sidebar row click); every other entry path
falls through to the route-seed default of _persistent_, which is exactly the behaviour the
feature exists to provide (accumulating a switchable set of subthreads). cmd/shift sidebar
multi-select stays selection-only; a bulk "Open in tabs (N)" context-menu action is **deferred
to a follow-up** (nice-to-have, not core).

---

## 3. URL ↔ active-tab sync (decision)

**The URL (`/$environmentId/$threadId`) remains the single source of truth for the _active_
tab; the store owns only the set and its order.** `activeKey` is a pure mirror of the URL.
Effect ordering must never decide the active tab — precisely the disease the tiers doc's
write policy exists to prevent.

All sync lives in **one hook**, `useThreadTabsSync`, called once from
`apps/web/src/routes/_chat.$environmentId.$threadId.tsx` — the universal chokepoint every
thread navigation funnels through (sidebar, workstream panel, palette, deep link, reload,
back/forward). No other call site writes `activeKey`.

### 3.1 Navigation → store (the seed)

In `useThreadTabsSync(threadRef, { bootstrapComplete, routeThreadExists })`, an effect keyed
on `scopedThreadKey(threadRef)`:

- **Gate:** do nothing until `bootstrapComplete && routeThreadExists`. This means a bad deep
  link (which the route's existing redirect effect sends to `/`) **never plants a phantom
  tab**, and a valid thread whose replay hasn't arrived yet seeds only once it resolves.
- **Seed:** `seedActiveTab(ref)` — if the key is absent, append the ref at the **end** of
  `tabs` as a persistent tab; set `activeKey` (and promote `mru`). If present, only set
  `activeKey`/`mru`. Seeding **never reorders** existing tabs and never touches `previewKey`
  of other tabs.

This one rule uniformly yields the required behaviours:

- **Reload:** URL restores → seed activates the (persisted) tab; if the persisted set lost it,
  it is re-appended.
- **Back/forward:** each history entry re-runs the seed → activates that tab; if the user had
  closed it, back re-opens it persistent (accepted consequence).
- **Deep link:** valid → persistent tab appended + activated; invalid → existing
  redirect-to-`/` fires and no tab is created.
- **Redirect-when-missing:** unchanged from today; the gate above is the only interaction.

### 3.2 Tab activation → URL

Clicking a tab (or keyboard-activating one) calls
`navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) })` and
**does not write the store**; the write comes back through the seed. This keeps one
write-path and removes any activation race.

### 3.3 Close → URL

- Closing the **active** tab: `closeTab(ref)` returns the index-nearest neighbour
  (`tabs[Math.min(index, len - 1)]` semantics, identical to `rightPanelStore.closeSurface`);
  the caller navigates to it, or to `/` when the set emptied. The navigation then re-seeds
  `activeKey` — the store never guesses the active tab itself.
- Closing a **non-active** tab: store-only; URL untouched.
- `closeOthers` / `closeToRight` keep the active tab when it survives; if it doesn't
  (close-others on a non-active tab), navigate to the kept tab.

### 3.4 Seed-not-override compliance

Activation-on-seed is legitimate focus-setting: navigation is an explicit user/programmatic
act, not an automatic opener. The policy-relevant guarantees kept: the seed is
**append-if-absent** (never reorders or rewrites the user's arranged strip), `activeKey` is
derived solely from the URL, and no effect anywhere else competes to set it.

---

## 4. Mounting: active-only (decision)

**Render only the active thread's `ChatView`** — the route component keeps rendering exactly
one `ChatView`, as today; tabs are a lightweight strip plus the open-set store. Rationale:

- Each mounted `ChatView` (~5.5k lines, dozens of effects) subscribes via `useThread` to a
  live `subscribeThread` WebSocket stream plus terminal/preview/diff/workstream state. N
  mounted tabs = N concurrent thread subscriptions and N heavy trees — directly against the
  repo's performance-first priority.
- Switch-back already stays warm without multi-mounting: per-thread state atoms carry
  `Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS = 5 min)`
  (`packages/client-runtime/src/state/threadRetention.ts`), so re-selecting a recently viewed
  tab re-mounts against retained state — no snapshot refetch.
- If switch flicker is ever observed for tabs idle >5 min, a bounded keep-last-N-mounted is a
  later, _measured_ optimisation. Do not build it speculatively.

---

## 5. Keyboard (decision; behaviour change flagged in §10.2)

Repurpose the existing thread-traversal bindings to operate on the tab strip, rather than
inventing a parallel scheme:

| Binding                       | Command                           | New behaviour                                                                                           |
| ----------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `mod+shift+[` / `mod+shift+]` | `thread.previous` / `thread.next` | prev/next **tab** (strip order, no wrap), when ≥1 tab is open; otherwise today's sidebar-list traversal |
| `mod+1` … `mod+9`             | `thread.jump.N`                   | activate **tab N** (strip position), when ≥1 tab is open; otherwise today's sidebar jump                |
| `mod+w`                       | **new** `tab.close`               | close the active tab (free: `terminal.close` is gated `when terminalFocus`)                             |
| `mod+shift+t`                 | **new** `tab.reopenClosed`        | reopen the most recently closed tab (persistent), backed by `recentlyClosed`                            |

- Fallback rule: when the tab set is empty, all four traversal bindings behave exactly as
  today, so no muscle memory breaks and no default bindings change.
- Contract changes: add `tab.close` and `tab.reopenClosed` to
  `packages/contracts/src/keybindings.ts` and defaults in `apps/server/src/keybindings.ts`.
- Handler placement: a loom hook `useThreadTabKeyboard` mounted in `ChatRouteGlobalShortcuts`
  (`apps/web/src/routes/_chat.tsx`). It `preventDefault()`s when it handles a command;
  `Sidebar.tsx`'s existing traversal handler must check `event.defaultPrevented` first (add
  the guard if missing) so the two window listeners cannot double-fire.

---

## 6. Tab strip UI and affordances (decision)

**Component:** `apps/web/src/loom/ThreadTabsStrip.tsx`. Copy the `RightPanelTabs` interaction
vocabulary wholesale, changing only label content:

- **Close:** hover-reveal `X`; **middle-click** close (`onAuxClick`); context menu with
  _Close_, _Close others_, _Close to the right_, _Close all_ (index-nearest active fallback
  throughout). Add _Copy link_ (the thread's URL) in place of the file-surface _Copy path_.
- **Overflow:** horizontal scroll with edge fade and active-tab
  `scrollIntoView({ block: "nearest", inline: "nearest" })` — same as `RightPanelTabs`. **No
  overflow dropdown** (consistency; the command palette already covers "find a thread").
- **Reorder:** dnd-kit drag-reorder (`@dnd-kit/sortable`, already a dependency). This is the
  one deliberate divergence from the right-panel reference — tab order is the user's working
  set here. Dragging the preview tab pins it.
- **Label:** thread title, truncated with full-title tooltip; _italic_ while preview. Leading
  status glyph reusing the sidebar's status machinery (`resolveThreadStatusPill` +
  `ThreadStatusLabel` from `ThreadStatusIndicators.tsx`) so a background thread that is
  running or needs attention shows it on the tab while inactive — this replaces
  `RightPanelTabs`' `pending` dot. Environment label suffix only when the tab's environment
  differs from the primary one.
- **Unavailable threads** (persisted tab whose thread isn't in client state): render enabled
  but visually muted with a tooltip ("Thread unavailable on this connection"); clicking
  navigates, and if the thread truly doesn't exist the route's redirect returns to `/`
  without seeding (§3.1). No crash, no auto-removal (§7). Archived threads render normally
  (they remain viewable), optionally with the existing archived styling.
- **Empty state:** when zero tabs, the strip renders nothing (zero height). The index route's
  existing `NoActiveThreadState` remains the centre-panel empty experience; do not duplicate
  the right panel's empty-state cards in the centre.

**Placement:** the strip renders at the top of the centre panel (inside `SidebarInset`,
above `ChatView`) in `_chat.$environmentId.$threadId.tsx`, and equivalently in
`_chat.index.tsx` and `_chat.draft.$draftId.tsx` so open tabs stay reachable from the index
and draft views (no active tab highlighted there). Keep it a one-line `// loom:` splice per
route.

---

## 7. Lifecycle and reconciliation (decision — resolves the second divergence)

The UX exploration proposed pruning tabs whose thread vanishes from the thread list, mirroring
`reconcileBrowserSurfaces`. The architecture exploration rejected that, citing the tiers doc.
**Resolution: no absence-based pruning.** The tiers doc is explicit that "absent while live"
is not a deletion signal (shell flips to `"live"` before replay catch-up completes); deleting
on it can destroy a valid working set moments after connect. Concretely:

- **No sweep.** A tab whose thread is missing from current client state renders in the
  muted "unavailable" state (§6) until the thread arrives or the user closes it manually.
- **`removeThread(ref)`** exists as the unit-tested parity hook (like every other per-thread
  store) so a genuine thread-deletion path can be wired in one line later. Nothing calls it
  from a heuristic.
- **Archived** threads keep their tabs (viewable); no auto-close.
- **Environment removal:** tabs for a removed connection linger as unavailable until closed
  manually — accepted for v1; if a definitive environment-removed signal is available, wiring
  it to `removeThread` per ref is a follow-up.
- **Stale persisted state** is handled structurally by `migratePersistedThreadTabs`
  (malformed entries dropped; dangling `activeKey`/`previewKey`/`mru` repaired), not
  semantically (no existence checks at load).

### 7.1 Tab cap

Soft cap **12** open tabs (number needs sign-off, §10.3). On appending past the cap, evict the
least-recently-activated non-preview tab from the tail of `mru`, never the active tab and
never the tab being opened; evicted refs go to `recentlyClosed`. The cap is also applied in `migrate` so
old persisted state can't exceed it.

---

## 8. File-by-file implementation outline

New files (all loom-owned):

| File                                        | Contents                                                                                                                                                                                      |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/loom/threadTabsStore.ts`      | Store per §1 (`persist`, `migratePersistedThreadTabs`, selectors `selectTabs`, `selectActiveKey`, `selectIsPreview`)                                                                          |
| `apps/web/src/loom/threadTabsStore.test.ts` | Migration, seed/open/pin/close/reorder/cap/mru semantics (mirror `rightPanelStore.test.ts` coverage style)                                                                                    |
| `apps/web/src/lib/tabListOps.ts` (+ test)   | Pure ordered-tab-list helpers: `closeWithNeighbourFallback`, `keepOnly`, `truncateAfter` — shared semantics extracted rather than duplicated (rightPanelStore migration to it is a follow-up) |
| `apps/web/src/loom/ThreadTabsStrip.tsx`     | Strip UI per §6 (dnd-kit sortable, context menu, status glyphs)                                                                                                                               |
| `apps/web/src/loom/useThreadTabsSync.ts`    | The seed hook (§3.1) + `closeTabAndNavigate` helper used by strip and keyboard                                                                                                                |
| `apps/web/src/loom/useThreadTabKeyboard.ts` | Keyboard handling per §5                                                                                                                                                                      |

Touched files (each a small `// loom:` splice):

| File                                                              | Change                                                                                                                                              |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/routes/_chat.$environmentId.$threadId.tsx`          | Call `useThreadTabsSync(threadRef, …)` (it already computes `bootstrapComplete`/`routeThreadExists`); render `<ThreadTabsStrip />` above `ChatView` |
| `apps/web/src/routes/_chat.index.tsx`, `_chat.draft.$draftId.tsx` | Render `<ThreadTabsStrip />` (no active tab)                                                                                                        |
| `apps/web/src/routes/_chat.tsx`                                   | Mount `useThreadTabKeyboard` in `ChatRouteGlobalShortcuts`                                                                                          |
| `apps/web/src/components/Sidebar.tsx`                             | Row single-click: `openTab(ref, "preview")` before navigate; traversal handler: respect `event.defaultPrevented`                                    |
| `apps/web/src/components/ChatView.tsx` (or composer submit path)  | On message send: `pinTab(threadRef)` (one line)                                                                                                     |
| `packages/contracts/src/keybindings.ts`                           | Add `tab.close`, `tab.reopenClosed` commands                                                                                                        |
| `apps/server/src/keybindings.ts`                                  | Default bindings `mod+w`, `mod+shift+t`                                                                                                             |

Explicitly **not** in scope for v1: bulk "Open in tabs (N)" from multi-select; keep-last-N
mounted; rightPanelStore refactor onto `tabListOps`; draft-thread tabs; auto-restoring the
last active tab on `/` (index keeps its current goal-overview behaviour).

Verification: `vp check` + `vp run typecheck`; store/helper unit tests; **live verification
via the dev-verify recipe** (`docs/dev-site-testing.md`) covering: sidebar preview reuse,
workstream-subthread persistent open, reload restore, back/forward, bad deep link (no phantom
tab), close-active fallback, keyboard traversal, cap eviction.

---

## 9. Risks

- **Sidebar traversal double-handling:** two window keydown listeners (Sidebar, tab hook)
  now share four commands. The `defaultPrevented` contract must be verified in both — this is
  the most likely subtle bug.
- **Seed vs redirect ordering:** the seed gate replicates `routeThreadExists` logic; if the
  route's redirect conditions change later, the gate must move with them (they live in the
  same file, which is the mitigation).
- **`ChatView` pin splice:** `ChatView.tsx` is huge; the pin-on-send hook should attach to the
  narrowest stable submit path, not deep in the send pipeline.
- **Behaviour change** for existing `mod+1..9` users (§10.2) — mitigated by the empty-set
  fallback but still a real change once tabs exist.

## 10. Decisions needing explicit human sign-off

1. **Global open-set** (vs per-environment): recommended global-with-scoped-refs (§1.2).
2. **Keybinding repurpose:** `mod+shift+[`/`]` and `mod+1..9` traverse the **tab strip** when
   tabs are open (sidebar fallback when empty); new `mod+w` close / `mod+shift+t` reopen (§5).
3. **Tab cap = 12** (mechanism fixed; the number is a product choice) (§7.1).
4. **Pin-on-double-click lives on the tab**, not the sidebar row (row keeps inline-rename);
   preview promotes on composer send (§2).
5. **Index route `/` does not auto-restore** the last active tab (§8, out-of-scope list).
