---
manager_sessions:
  - id: a7e27399-32a6-40f4-a776-d162a6512388
    role: plan
    authored_at: 2026-07-20T02:55:24.132Z
---

# Centre-panel thread tabs — design

**Status:** shipped (v1, PR #120); **v2 revision** — tabs grouped per orchestration tree.
**Feature:** threads open as tabs in the centre panel, mirroring how the right panel tabs its
surfaces, so switching between threads (especially subthreads reached via the workstream
surface) stops being a full centre-panel swap with no way back.

> **v2 revision (grouped tabs).** v1 kept a single workspace-global open-set, which meant
> threads from _different_ root orchestration trees landed in the same strip. v2 makes **tabs
> grouped per orchestration tree**: a root thread and all of its subthreads form one group, and
> switching to a thread under a _different_ root shows that root's own group of tabs. The
> sections below marked _(v2)_ supersede their v1 text; everything else (preview semantics,
> keyboard, mount-active-only, no-sweep lifecycle) is unchanged. Persisted v1 tabs are dropped
> on upgrade (storage `version` bumped to 2).

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

### 1.2 Scope: grouped per orchestration tree _(v2 — supersedes v1's single global open-set)_

Tabs are bucketed into **groups keyed by the thread's lineage root**. A group key is the
`scopedThreadKey` of the root orchestrator thread (the ancestor whose own `parentThreadId` is
`null`), derived by walking `parentThreadId` upward via `buildThreadLineage`
(`apps/web/src/threadRouteLineage.ts`). A root thread (no parent) is its own group. Entries
remain full `ScopedThreadRef`s, identity = `scopedThreadKey(ref)`; grouping is **not**
per-environment (the ref already namespaces across environments and the root walk stays within
one environment's shell map). The tab UI shows the environment label only when it differs from
the primary environment (same rule the sidebar row uses via `isRemoteThread`).

The store stays **pure** — it never computes lineage. The **sync hook supplies the group key**
(it has the shell map): the seed/open/reopen actions take a `groupKey` argument, while
close/reorder/pin locate the group that already contains the ref. The **active group is
derived**, never stored: it is the group that contains the top-level `activeKey` (itself the
URL mirror), so there is no competing source of truth for which group is active.

> v1's single-global-list rationale (tabs must survive connection switches; refs namespace
> across environments) still holds — v2 only adds the per-tree bucketing on top.

Draft threads (`/draft/$draftId`) are **not** tabbed in v1: they have no `ScopedThreadRef`
until promoted, at which point the first navigation to the server thread seeds a tab normally.

### 1.3 Shape

```ts
// apps/web/src/loom/threadTabsStore.ts  (v2)
const THREAD_TABS_STORAGE_KEY = "t3code:thread-tabs:v1"; // key name kept; version bump drives migration
const THREAD_TABS_STORAGE_VERSION = 2;

interface ThreadTabGroup {
  /** Ordered open set for this orchestration tree. Identity = scopedThreadKey(ref). */
  tabs: ScopedThreadRef[];
  /** scopedThreadKey of this group's transient preview tab, if any; always ∈ tabs (§2). */
  previewKey: string | null;
  /** Keys most-recently-activated-first; drives this group's cap eviction (§7.1). */
  mru: string[];
}

interface ThreadTabsState {
  /** Open tabs bucketed by group key (the lineage root's scopedThreadKey; §1.2). */
  groups: Record<string, ThreadTabGroup>;
  /** scopedThreadKey of the active tab — a pure mirror of the URL (§3). The active
   * group is derived as the group that contains this key. */
  activeKey: string | null;
  /** Recently closed refs (global across groups), most recent first, cap 10 (§5). */
  recentlyClosed: ScopedThreadRef[];

  /** Route-driven seed into `groupKey`: append-if-absent (persistent) + activate; moves the
   * ref out of a stale group if it lived elsewhere (lineage-lag). Never reorders. */
  seedActiveTab: (ref: ScopedThreadRef, groupKey: string) => void;
  /** Explicit open with intent into `groupKey`; dedupes by key. */
  openTab: (ref: ScopedThreadRef, groupKey: string, mode: "preview" | "persistent") => void;
  /** Promote the preview tab to persistent within its group (locates group by ref). */
  pinTab: (ref: ScopedThreadRef) => void;
  /**
   * Remove a tab from its group; push onto recentlyClosed. Returns the neighbour-fallback ref
   * (within the group) to navigate to when the closed tab was active (null ⇒ group emptied or
   * not active), so the caller owns navigation (§3.3).
   */
  closeTab: (ref: ScopedThreadRef) => ScopedThreadRef | null;
  closeOthers: (ref: ScopedThreadRef) => void;
  closeToRight: (ref: ScopedThreadRef) => void;
  /** Close every tab in the active group (the group containing `activeKey`). */
  closeAll: () => void;
  /** Pop recentlyClosed; opens it persistent into `groupKey`. Returns the ref to navigate to. */
  reopenClosedTab: (groupKey: string) => ScopedThreadRef | null;
  /** Drag-reorder within the ref's group. Reordering the preview tab pins it. */
  reorderTab: (ref: ScopedThreadRef, toIndex: number) => void;
  /** Parity hook for a future real thread-deletion path. NOT called from any sweep. */
  removeThread: (ref: ScopedThreadRef) => void;
  /** Merge provisional groups into their resolved root group once lineage replays (§7.2). */
  coalesceGroups: (moves: ReadonlyArray<{ from: string; to: string }>) => void;
}
```

Group-key derivation lives in `apps/web/src/loom/threadTabGroups.ts`
(`resolveThreadGroupKey` / the `useThreadGroupResolver` hook), consumed by the sync hook and
the sidebar. The strip renders the **active group** via the `selectActiveGroup` selector; no
consumer reads a flat `tabs` list any more.

List mechanics (index-nearest close fallback `list[Math.min(index, len - 1)]`, close-others,
close-to-right, dedupe-on-open) replicate `rightPanelStore` semantics exactly, now applied
**within a group**. To honour the
no-duplication rule, extract them as **pure helpers in a new
`apps/web/src/lib/tabListOps.ts`** consumed by `threadTabsStore`; migrating
`rightPanelStore.closeSurface`/`closeOtherSurfaces`/`closeSurfacesToRight` onto the same
helpers is a desirable **follow-up**, deliberately not bundled into this change to keep the
diff reviewable.

### 1.4 Persistence, versioning, migration

- `persist` with `createJSONStorage(() => resolveStorage(window.localStorage))` — identical
  plumbing to `rightPanelStore`.
- Key `t3code:thread-tabs:v1` (name kept so the version bump is what triggers migration),
  `version: 2`, `partialize: ({ groups, activeKey, recentlyClosed }) => ...`.
- `migratePersistedThreadTabs(persistedState, version)` — exported and unit-tested. _(v2)_:
  - **v1 → v2 drops persisted tabs**: any pre-v2 (flat `tabs`) shape, or any non-object /
    non-grouped payload, returns empty grouped state (clean slate);
  - for a **v2-shaped** `{ groups }` payload it sanitises each group defensively — keep only
    well-formed `{ environmentId, threadId }` entries deduped by key (drop empty groups), null a
    group's `previewKey` and filter its `mru` to surviving keys, apply the per-group cap (§7.1),
    null the top-level `activeKey` if it points into no surviving group, and cap
    `recentlyClosed` to 10.
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
- **Seed:** `seedActiveTab(ref, groupKey)` where the hook derives `groupKey` from the current
  shell map _(v2)_ — if the key is absent in that group, append the ref at the **end** of the
  group's `tabs` as a persistent tab; set `activeKey` (and promote the group's `mru`). If
  present, only set `activeKey`/`mru`. Seeding **never reorders** existing tabs and never
  touches other tabs' `previewKey`. If the ref currently lives in a _different_ (provisional)
  group, the seed moves it into the resolved group (see coalescing, §7.2).

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

## 5. Keyboard (decision; revised after implementation — see §10.2)

The tab strip has its **own** command family. The sidebar's `thread.*` bindings are left
entirely alone:

| Binding                                | Command                             | Behaviour                                                                    |
| -------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------- |
| `mod+alt+[` / `mod+alt+]`              | **new** `tab.previous` / `tab.next` | prev/next **tab** (strip order, no wrap)                                     |
| `mod+alt+1` … `mod+alt+9`              | **new** `tab.jump.N`                | activate **tab N** (strip position)                                          |
| `mod+w`                                | **new** `tab.close`                 | close the active tab (free: `terminal.close` is gated `when terminalFocus`)  |
| `mod+shift+t`                          | **new** `tab.reopenClosed`          | reopen the most recently closed tab (persistent), backed by `recentlyClosed` |
| `mod+shift+[` / `]`, `mod+1` … `mod+9` | `thread.*` (unchanged)              | sidebar thread traversal / jump, exactly as before tabs existed              |

- `mod+alt+…` is deliberate: it is nearly-unclaimed real estate (only `mod+alt+b`, the right
  panel), and `apps/web/src/keybindings.ts` already aliases `BracketLeft`/`BracketRight`/
  `Digit0-9` by `event.code`, so alt-modified brackets and digits still match on mac.
- No fallback rule: a tab command that cannot act (no tabs, index past the end) does nothing —
  including no `preventDefault()` — so the key falls through untouched.
- Contract changes: `tab.close`, `tab.reopenClosed`, `tab.previous`, `tab.next` and the
  `tab.jump.1..9` family in `packages/contracts/src/keybindings.ts`; defaults in the canonical
  table `packages/shared/src/keybindings.ts` (`apps/server/src/keybindings.ts` re-exports it).
  The server's startup sync appends the new commands into existing users' `keybindings.json`.
- Handler placement: a loom hook `useThreadTabKeyboard` mounted in `ChatRouteGlobalShortcuts`
  (`apps/web/src/routes/_chat.tsx`). It resolves **only** `tab.*` commands, so it can never
  pre-empt another listener's command even though it listens in the capture phase (capture is
  kept so composer/terminal bubble handlers cannot swallow tab keys). Its shortcut context
  mirrors the sidebars' (`terminalFocus` + `modelPickerOpen`) so resolution is identical
  everywhere and no `when`-gated command loses to a stale context here.

---

## 6. Tab strip UI and affordances (decision)

**Component:** `apps/web/src/loom/ThreadTabsStrip.tsx`. The strip renders **only the active
group's tabs** _(v2)_ — the tabs of the orchestration tree the active thread belongs to (or, on
the index/draft routes where nothing is highlighted, the group of the last active thread, via
`selectActiveGroup`). Every affordance below (close/others/to-right/all, preview italics, dnd
reorder, status glyph, cap) operates within that active group. Copy the `RightPanelTabs`
interaction vocabulary wholesale, changing only label content:

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

### 7.1 Tab cap _(v2: per group)_

Soft cap **12** open tabs **per group**. On appending past the cap, evict the
least-recently-activated non-preview tab from the tail of that group's `mru`, never the active
tab and never the tab being opened; evicted refs go to the global `recentlyClosed`. The cap is
also applied per group in `migrate` so old persisted state can't exceed it.

### 7.2 Lineage-lag coalescing _(v2)_

On a cold load / deep link / reload into a subthread, the ancestor shells may not have replayed
yet, so the thread's root is briefly unknown and the derived group key is **provisional** (the
topmost reachable ancestor — often the thread itself). The tab is seeded under that provisional
group and **coalesced into the real root group once lineage resolves**. This is purely
replay-timing; no user action triggers it.

Mechanism: `resolveThreadGroupKey` is a pure function of the shell map, so re-deriving on every
shell change is what surfaces the resolution. The sync hook runs a coalescing effect keyed on
the resolver identity: for each existing group it probes a tab's now-resolved key; where that
differs from the group's current bucket it emits a `{ from, to }` move, and
`coalesceGroups(moves)` merges the provisional group into the root group (order preserved, at
most one preview per group kept, per-group cap re-applied). Because all tabs in one provisional
group share the same ancestor, a whole-group merge is always correct. `activeKey` is untouched,
so the active tab stays active while its surrounding group changes underneath it.

---

## 8. File-by-file implementation outline

New files (all loom-owned):

| File                                        | Contents                                                                                                                                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web/src/loom/threadTabsStore.ts`      | Store per §1 (grouped `persist`, `migratePersistedThreadTabs`, `coalesceGroups`, selectors `selectActiveGroup`/`selectActiveGroupKey`/`selectActiveKey`/`selectIsPreview`, `findGroupKeyByTab`) _(v2)_ |
| `apps/web/src/loom/threadTabGroups.ts`      | _(v2)_ Group-key derivation from lineage: `resolveThreadGroupKey` + `useThreadGroupResolver`, shared by the sync hook and the sidebar                                                                  |
| `apps/web/src/loom/threadTabsStore.test.ts` | Migration, seed/open/pin/close/reorder/cap/mru semantics (mirror `rightPanelStore.test.ts` coverage style)                                                                                             |
| `apps/web/src/lib/tabListOps.ts` (+ test)   | Pure ordered-tab-list helpers: `closeWithNeighbourFallback`, `keepOnly`, `truncateAfter` — shared semantics extracted rather than duplicated (rightPanelStore migration to it is a follow-up)          |
| `apps/web/src/loom/ThreadTabsStrip.tsx`     | Strip UI per §6 (dnd-kit sortable, context menu, status glyphs)                                                                                                                                        |
| `apps/web/src/loom/useThreadTabsSync.ts`    | The seed hook (§3.1) + `closeTabAndNavigate` helper used by strip and keyboard                                                                                                                         |
| `apps/web/src/loom/useThreadTabKeyboard.ts` | Keyboard handling per §5                                                                                                                                                                               |

Touched files (each a small `// loom:` splice):

| File                                                              | Change                                                                                                                                              |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/routes/_chat.$environmentId.$threadId.tsx`          | Call `useThreadTabsSync(threadRef, …)` (it already computes `bootstrapComplete`/`routeThreadExists`); render `<ThreadTabsStrip />` above `ChatView` |
| `apps/web/src/routes/_chat.index.tsx`, `_chat.draft.$draftId.tsx` | Render `<ThreadTabsStrip />` (no active tab)                                                                                                        |
| `apps/web/src/routes/_chat.tsx`                                   | Mount `useThreadTabKeyboard` in `ChatRouteGlobalShortcuts`                                                                                          |
| `apps/web/src/components/Sidebar.tsx`                             | Row single-click: `openTab(ref, "preview")` before navigate; traversal handler: respect `event.defaultPrevented`                                    |
| `apps/web/src/components/ChatView.tsx` (or composer submit path)  | On message send: `pinTab(threadRef)` (one line)                                                                                                     |
| `packages/contracts/src/keybindings.ts`                           | Add `tab.close`, `tab.reopenClosed`, `tab.previous`, `tab.next`, `tab.jump.1..9` commands                                                           |
| `packages/shared/src/keybindings.ts`                              | Default bindings `mod+w`, `mod+shift+t`, `mod+alt+[`/`]`, `mod+alt+1..9`                                                                            |

Explicitly **not** in scope for v1: bulk "Open in tabs (N)" from multi-select; keep-last-N
mounted; rightPanelStore refactor onto `tabListOps`; draft-thread tabs; auto-restoring the
last active tab on `/` (index keeps its current goal-overview behaviour).

Verification: `vp check` + `vp run typecheck`; store/helper unit tests; **live verification
via the dev-verify recipe** (`docs/dev-site-testing.md`) covering: sidebar preview reuse,
workstream-subthread persistent open, reload restore, back/forward, bad deep link (no phantom
tab), close-active fallback, keyboard traversal, cap eviction.

---

## 9. Risks

- ~~**Sidebar traversal double-handling:** two window keydown listeners (Sidebar, tab hook)
  now share four commands.~~ **This risk materialised** and is now designed out: the tab hook
  won the shared commands unconditionally (capture beats the sidebars' bubble-phase
  `defaultPrevented` guard) and the empty-set fallback that was supposed to protect the
  sidebar proved unreachable, so sidebar traversal/jump was simply dead. Resolved by giving
  tabs their own commands (§5) — the two listeners now share no command at all.
- **Seed vs redirect ordering:** the seed gate replicates `routeThreadExists` logic; if the
  route's redirect conditions change later, the gate must move with them (they live in the
  same file, which is the mitigation).
- **`ChatView` pin splice:** `ChatView.tsx` is huge; the pin-on-send hook should attach to the
  narrowest stable submit path, not deep in the send pipeline.
- ~~**Behaviour change** for existing `mod+1..9` users (§10.2) — mitigated by the empty-set
  fallback but still a real change once tabs exist.~~ No longer applies: `mod+1..9` and
  `mod+shift+[`/`]` keep their pre-tabs meaning (§10.2).

## 10. Decisions needing explicit human sign-off

1. **Global open-set** (vs per-environment): recommended global-with-scoped-refs (§1.2).
2. **Keybindings.** _Original decision (signed off):_ repurpose `mod+shift+[`/`]` and
   `mod+1..9` to traverse the **tab strip** when tabs are open, with a sidebar fallback when
   the tab set is empty; new `mod+w` close / `mod+shift+t` reopen.
   **Reversed after implementation (user-approved):** the fallback is unreachable in practice —
   `useThreadTabsSync` seeds a tab for the route thread on every navigation and the store
   (including `activeKey`) is persisted, so the tab set is never empty, not even on the index
   route. The repurpose therefore removed sidebar thread traversal/jump outright instead of
   overlaying it, and (with one tab open) swallowed `mod+2..9` to no effect at all. Tabs now
   own `tab.previous` / `tab.next` / `tab.jump.1..9` on `mod+alt+…` and the `thread.*`
   bindings are untouched (§5). `mod+w` / `mod+shift+t` are unchanged from the original
   decision.
3. **Tab cap = 12** (mechanism fixed; the number is a product choice) (§7.1).
4. **Pin-on-double-click lives on the tab**, not the sidebar row (row keeps inline-rename);
   preview promotes on composer send (§2).
5. **Index route `/` does not auto-restore** the last active tab (§8, out-of-scope list).
