---
manager_sessions:
  - id: 1b2a5788-e948-4cb8-baad-aad3e7a89a7d
    role: plan
    authored_at: 2026-07-14T00:03:34.799Z
---

# Loom state-tier retool — align fork UI state with upstream's predictability model

_Loom (fork of `pingdotgg/t3code`) added several UI features whose state lives in
component-scoped `useState`/`useRef`, layered over upstream's thread-scoped persisted-store
architecture. The result is a class of unpredictable UX: user choices silently reset or get
overwritten depending on component lifetime and effect ordering. This plan classifies each
piece of loom UI state into upstream's state tiers and fixes the writers so automatic
behaviour never overrides an explicit user choice._

## Background: the state-tier model this plan enforces

Upstream's convention (observed, not documented) is four tiers:

1. **Durable per-thread UI choice** — persisted zustand store keyed by `scopedThreadKey`
   (`rightPanelStore`, `terminalUiStateStore`, `diffPanelStore`, `composerDraftStore`), with
   versioned migrations and cleanup on thread removal.
2. **Durable preference** — `uiStateStore` (client-local) or settings contracts (synced).
3. **One-shot cross-navigation intent** — ephemeral store, set once / consumed once
   (preview action bus; loom's `loomScrollStore` is already correct — leave it alone).
4. **Transient render state** — component `useState`/`useRef` (drag, viewBox, in-flight flags).

**Write policy (the second half of the fix):** automatic openers may *seed* UI state but never
*override* a user's persisted choice. Effect ordering must never decide which surface is active.

## Motivating bug (must be fixed by W1)

Open the Workstream right-panel surface on a thread → navigate to a new-thread draft →
navigate back: the goal-tasks surface is active instead of Workstream. Cause: the goal-tasks
auto-open effect in `apps/web/src/loom/useLoomThreadExtensions.ts` guards with a
component-lifetime `useRef` Set inside `ChatView`; route changes that remount `ChatView`
(draft, settings, index) wipe the guard, and the re-fired `open(ref, "tasks")` activates the
tasks surface over the persisted selection. The related comment in `ChatView.tsx`
(~line 3563, "declaration order is load-bearing: … last opener wins") documents the
effect-ordering race this plan removes.

## Fork-seam constraint (applies to every workstream)

Loom merges upstream regularly. New state must live in **loom-owned files**
(`apps/web/src/loom/`, `*.loom.ts`, `settings.loom.ts` field records) with one-line splice
points into upstream-owned files, per `plans/2026-07-07-fork-seam-campaign.md`. When a
workstream below proposes touching an upstream-owned file (e.g. `rightPanelStore.ts`,
`uiStateStore.ts`, `SettingsPanels.tsx`), the touch must stay to splice-point size.

---

## W1 — One-shot durable auto-open for the goal-tasks and workstream surfaces (fixes the bug)

**Goal:** the "auto-open already fired" record becomes durable per-thread state (matching the
lifetime of the choice it guards); auto-opens can never override, resurrect, or reorder
anything the user chose; the ref guard and the load-bearing effect ordering are deleted.

**Scope note (owner decision, post-review):** auto-open covers **two** surfaces — `tasks`
(existing behaviour, made safe) and `workstream` (new). Both default **on**. Same one-shot
machinery, per-surface flags. This extension was added after review sign-off at the owner's
direction; the mechanics are identical to the reviewed design, applied twice.

**Design note (rev 2):** the first revision tried to make panel-key presence double as the
"already auto-opened" record. Review showed that's a lossy proxy — `updateThread` prunes a
thread's key when its state empties (`rightPanelStore.ts:186-199`, via `closeAllSurfaces`),
so key-presence cannot distinguish "never visited" from "explicitly cleared", and re-adding a
closed tab is itself an override (resurrection). The guard must be its own durable record.

- **Durable one-shot flags, per surface:** a loom-owned persisted record
  `autoOpenedSurfaces: { tasks?: true; workstream?: true }` keyed by `scopedThreadKey`,
  living in the loom UI store introduced by W2 (`loom/workstreamUiStore.ts` or sibling — one
  store file is fine). If W1 ships before W2, create the store file in W1 with just this
  slice; W2 extends it.
- **Eligibility per surface:**
  - `tasks`: thread is goal-bound (`activeThread.goalId != null`) — unchanged.
  - `workstream`: thread **participates in a workstream** — `parentThreadId != null` or it
    has at least one child in the shell list. Deliberately *not* "is a server thread"
    (`workstreamAvailable` in `RightPanelTabs`), which would seed an empty panel on every
    ordinary thread. Eligibility can become true mid-session (first child spawned); the
    effect simply fires then — the flag keeps it one-shot.
- **Each surface's auto-open fires at most once per thread, ever:**
  - flag set for that surface → do nothing, regardless of panel state;
  - flag unset + no panel state for the thread → full open (add + activate + show;
    first-visit discovery), set flag;
  - flag unset + panel state exists → add the tab **without** changing `activeSurfaceId` or
    `isOpen`, set flag.
  - **Both eligible in the same commit** (goal-bound thread that is also a workstream
    participant, no panel state): seeding one surface first would create panel state and
    demote the second to a non-activating add — which surface ends up active would depend on
    ordering, the exact disease this plan cures. The implementation must therefore seed **in
    one pass**: compute the eligible, unflagged surfaces, then perform a single store
    transition that adds all of them and activates exactly one — priority `tasks` over
    `workstream` (tasks is the goal-level overview; workstream remains one click away on the
    tab strip). Do not rely on effect ordering.
  - Consequence: closing a tab or close-all permanently suppresses reseeding of that surface
    for that thread. The explicit path back is the surface's entry in `RightPanelTabs`.
  - Precedent: upstream's `planSidebarDismissedForTurnRef` suppresses within its scope (a
    turn); these opens are one-shot per thread by intent, so their suppression scope is the
    thread lifetime.
- **Atomic store transition:** the non-activating branch cannot be composed from the public
  store API — `upsertSurface`'s `activate=false` path is private and still forces
  `isOpen: true` (`rightPanelStore.ts:174-183`), and the only public generic entry point
  `open` both activates and shows (`rightPanelStore.ts:293-305`). Composing `open` + restore
  would be two persisted writes and reintroduces ordering risk. **Requirement:** one new small
  store action (e.g. `seedSurface`) performing a single functional `set`, with a `// loom:`
  marker; its pure reducer may live in a loom-owned module and be spliced in, keeping the
  upstream-file touch splice-sized.
- Rewire the auto-open effect in `useLoomThreadExtensions.ts` to: compute eligible unflagged
  surfaces → one seed transition → set flags. Delete `autoOpenedTasksByThreadKey`.
- **Settings** `autoOpenGoalTasksPanel` and `autoOpenWorkstreamPanel`, both **default `true`**
  (owner decision: first-visit discovery is wanted without manual + → tab for each thread;
  the one-shot flags make the cost a single non-overriding seed per thread). Migration note:
  pre-existing threads have no flags, so each gets one seed on next visit — for threads with
  existing panel state this is a **non-activating tab add** (no focus steal), which is the
  accepted cost of default-on. Contract changes required in
  `packages/contracts/src/settings.loom.ts`:
  - field in `LoomClientSettingsFields` **and** the corresponding optional field in
    `LoomClientSettingsPatchFields` (both splices exist; see `settings.ts:54,593`).
  - Settings UI: `SettingsPanels.tsx` is upstream-owned and enumerates dirty labels, restore
    values, dependency arrays, and per-row resets (`SettingsPanels.tsx:399-432,461-475,
    754-769`). Add the row as a **loom-owned component** with splice-sized integration into
    each enumeration point; do not inline a full row implementation into the upstream file.
  - Labels: the existing `autoOpenPlanSidebar` toggle is labelled "auto-open task panel" —
    disambiguate ("auto-open plan panel" / "auto-open goal tasks"). Relabeling the upstream
    toggle is in scope only if it's a one-line change.
- Update/remove the "declaration order is load-bearing" comment block in `ChatView.tsx`
  (~3563). With the one-shot flag and non-activating seed, the plan auto-open no longer races
  it. The hook call site may stay; the comment must stop claiming ordering is load-bearing.
- Leave the upstream plan auto-open mechanism (`autoOpenPlanSidebar`,
  `planSidebarDismissedForTurnRef`, `planSidebarOpenOnNextThreadRef`) untouched.

**Tests:**
- flag unset + no panel state → full open + flag set (each surface);
- flag unset + panel state with another surface active → tab added, active surface and
  `isOpen` unchanged, flag set;
- flag set → no store write at all;
- both surfaces eligible + no panel state → both tabs added in one transition, `tasks`
  active;
- workstream eligibility arriving late (first child appears) → seeds then, once;
- regression: close only the seeded tab → remount/re-fire → tab does not return;
- regression: `closeAllSurfaces` (key pruned) → remount/reload → nothing reopens.

## W2 — Durable per-thread Workstream panel state

**Goal:** graph/board view, selected node, and the half-typed spawn form survive tab switches
and navigation, like every upstream per-thread surface does.

- New loom-owned persisted store, e.g. `apps/web/src/loom/workstreamUiStore.ts`, keyed by
  `scopedThreadKey`, mirroring the shape conventions of `diffPanelStore`
  (persist middleware, versioned migrate, `removeThread`). State per thread:
  - `view: "graph" | "board"`
  - `selectedThreadId: ThreadId | null`
  - spawn-form draft: `{ role, title, purpose }` (cleared on successful spawn)
- `WorkstreamPanel.tsx` swaps its `useState` for this store. `isSpawning`, `error`, and
  everything in `WorkstreamGraph` (viewBox, drag refs) stay component-local (tier 4).
- Reconciliation: a persisted `selectedThreadId` may reference a deleted thread. The panel
  already derives the subtree from live shells — treat a selection not present in the subtree
  as null at read time (derive, don't write-back loop).
- **Cleanup (final, rev 4): no automatic orphan sweep.** History of this decision:
  - There is no existing production thread-deletion path to hook into —
    `deriveOrchestrationBatchEffects` (`orchestrationEventEffects.ts:10`),
    `collectActiveTerminalUiThreadKeys` (`lib/terminalUiStateCleanup.ts:12`) and
    `removeOrphanedTerminalUiStates` (`terminalUiStateStore.ts:745`) have no non-test
    consumers; `rightPanelStore.removeThread` / `diffPanelStore.removeThread` are only
    exercised by tests. Upstream tolerates orphaned per-thread localStorage keys today.
  - Two review rounds tried to make an absence-based sweep safe (environment scoping,
    draft-key retention, an "authoritative snapshot" gate) and each round surfaced another
    way it could delete valid state. The final blocker: there is **no catch-up-complete
    signal** on the client. `EnvironmentShellStatus` flips to `"live"` after any first
    non-empty batch (`packages/client-runtime/src/state/shell.ts:136-153`), replay is
    batched via `groupedWithin(64, "20 millis")` (`shell.ts:192-196`), and the server splices
    catch-up into the live stream with no completion marker (`apps/server/src/ws.ts:1024-1047`)
    — so with a backlog over one batch, "absent while live" can describe a thread whose
    replay simply hasn't arrived yet.
  - **Decision: ship without a sweep.** The orphaned entries are small localStorage keys
    (a view enum, a thread id, a short form draft, a boolean flag) — the same residue class
    upstream already accepts for `rightPanelStore`/`terminalUiStateStore`/`diffPanelStore`.
    A sweep that risks deleting valid state to reclaim bytes is a bad trade; correctness
    over convenience is this repo's stated priority.
  - The store still exposes a per-thread `removeThread(ref)` action (parity with the
    upstream stores, unit-tested), so if upstream later grows a real deletion/cleanup path,
    loom wires into it with one line.
  - Note in W5's doc: per-thread UI stores (upstream's and loom's) accumulate orphaned keys
    by design until an authoritative cleanup signal exists; any future sweep needs a true
    catch-up-complete marker (a protocol change) and a multi-batch (>64 event) replay test.
- **Not** chosen: extending the `workstream` surface descriptor in `rightPanelStore.ts`
  (terminal-surface precedent). Rationale: it churns an upstream-owned file and forces a
  storage-version bump for fork-only data. Reviewer should sanity-check this trade-off.

**Tests:** store unit tests (persistence shape, migration, removeThread, spawn-draft clear).

## W3 — Persist sidebar goal collapse

**Goal:** goal collapse behaves like the adjacent upstream project collapse (survives reload).

- Move `collapsedGoalIds` out of `useState` in `useLoomSidebarGoals.ts` into a small
  loom-owned persisted store (could share a file with W2's store or live as
  `loom/sidebarUiStore.ts` — implementer's judgment; goal ids are globally unique so a flat
  `Record<goalId, boolean>` suffices).
- Alternative considered: adding the field to upstream's `uiStateStore`/`PersistedUiState`
  beside `collapsedProjectCwds` — most "consistent", but churns an upstream-owned file
  beyond splice size. Loom-owned store preferred; the *behavioural* consistency (collapse is
  durable) is what users perceive.
- Garbage: collapsed ids for deleted/archived goals are harmless dead keys; prune on
  read against known goals only if trivial.

## W4 — Goal title/description edit-session semantics

**Goal:** a server-side goal update must not clobber an in-flight edit in `GoalTasksPanel.tsx`.

- Replace the unconditional resync effects (`useEffect(() => setTitleDraft(goal.title),
  [goal.title])`) with focus-aware semantics: while the input is focused, external updates do
  not overwrite the draft; on blur without local changes, resync. Keep the drafts
  component-local — this is deliberately **not** persistence (persisted drafts would resurrect
  stale edits); it's tier-4 state with a corrected write policy.
- Keep the existing commit semantics (blur commits, Enter blurs, Escape reverts) unchanged.

## W5 — Document the policy

- Add a short section to `CONTRIBUTING.md` (or `docs/`, wherever fork conventions live —
  check `docs/upstream-sync/`) stating the state-tier table and the seed-not-override write
  policy, so future loom features don't reintroduce the pattern. Keep it under a page.
- **Documented exception:** upstream's plan auto-open (`ChatView.tsx:3577-3587`) still calls
  the activating `open(..., "plan")` from an automatic effect. It is opt-in
  (`autoOpenPlanSidebar`, default off) and turn-scoped with dismissal memory, so it is
  retained as an explicit exception — document it as such rather than stating an absolute
  policy the code immediately violates.
- Note the orphan-key behaviour from W2: neither upstream's per-thread stores nor loom's are
  cleaned automatically; a future sweep requires a genuine catch-up-complete signal
  (protocol change) — absence from current client state is not a safe deletion signal.

---

## Sequencing & scope

- W1 is the priority and is independent. W2, W3, W4 are independent of W1 and each other.
  W5 last. Suitable for a single coder in one pass, or W1 split out if shipped first.
- Out of scope: `loomScrollStore` (already correct), plan auto-open internals,
  `WorkstreamGraph` internals, any server/contracts change beyond the one settings field.

## Verification bar

- `vp check` and `vp run typecheck` pass; unit tests above.
- Live verification via the dev-verify recipe (`docs/dev-site-testing.md`), seeded
  workstream. **Reproducibility caveat:** the seed uses stable thread IDs
  (`apps/server/src/dev/seedWorkstream.ts:56-63`) while right-panel state and the W1 flag are
  browser-local (not under the recipe's scratch `T3CODE_HOME`) — before the "fresh thread"
  cases, clear the relevant localStorage keys (`t3code:right-panel-state:v2`,
  `t3code:ui-state:v1`, the new loom store key) or use a fresh browser profile/origin.
  1. Motivating bug: thread → open Workstream surface → new-thread draft → back →
     **Workstream still active**.
  2. Discovery (defaults on): fresh goal-bound thread, no prior panel state → tasks surface
     opens and is active — once. Close it, navigate away and back, reload → it does not
     return. Spawn a child on a thread → workstream tab appears (without stealing focus if
     the panel was already in use); on a fresh orchestrator sub-thread both tabs are present
     with tasks active.
  3. W2: set board view + select a node → switch to another surface and back → both restored;
     type into spawn form → switch tabs → text intact.
  4. W3: collapse a goal in the sidebar → reload → still collapsed.
  5. W4: focus goal title, update the goal server-side via the goal CLI
     (`apps/server/src/cli/goal.ts:196-227`, `goal update` against the scratch
     `T3CODE_HOME`) → draft not clobbered.
  6. W2 residue: delete a thread with persisted workstream-panel state → no errors, panel
     features unaffected; the orphaned key remains in localStorage by design (no sweep).
