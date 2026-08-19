# Loom UI state conventions — tiers and the seed-not-override write policy

Loom (fork of `pingdotgg/t3code`) layers extra UI on top of upstream's thread-scoped,
persisted-store architecture. To keep behaviour predictable — user choices must not silently
reset or get overwritten depending on component lifetime or effect ordering — every piece of
UI state belongs to one of **four tiers**, and automatic openers follow a **seed-not-override**
write policy. New loom features must classify their state against this table before adding it.

Background and the retool that established this: `plans/2026-07-13-loom-state-tier-retool.md`.
Fork-seam rules (loom state lives in loom-owned files — `apps/web/src/loom/`, `*.loom.ts`,
`settings.loom.ts` — with `// loom:` splice markers): `plans/2026-07-07-fork-seam-campaign.md`.

## The four state tiers

| Tier                                | What it is                                                                          | Storage                                                                                                  | Example                                                                                                                                                                                                             |
| ----------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Durable per-thread UI choice     | A choice scoped to one thread that must survive tab switches, navigation and reload | Persisted zustand store keyed by `scopedThreadKey`, with versioned `migrate` and a `removeThread` action | Upstream: `rightPanelStore`, `diffPanelStore`. Loom: the Workstream panel store (view, selected node, spawn-form draft)                                                                                             |
| 2. Durable preference               | A client-wide or synced setting, not thread-scoped                                  | `uiStateStore` (client-local) or a settings contract (synced)                                            | Loom: `autoOpenWorkstreamPanel` / `autoOpenGoalTasksPanel` in `packages/contracts/src/settings.loom.ts`                                                                                                             |
| 3. One-shot cross-navigation intent | A value set once by one surface and consumed once by another; never lingers         | Small ephemeral store, set-once / read-once                                                              | Loom: `loom/loomScrollStore.ts` (scroll-to-dispatch) — already correct, leave it alone                                                                                                                              |
| 4. Transient render state           | State meaningful only while a component is mounted                                  | Component `useState` / `useRef`                                                                          | `WorkstreamGraph` viewBox and drag refs; in-flight flags (`isSpawning`); the goal title/description **edit drafts** in `GoalTasksPanel` (deliberately not persisted — persisted drafts would resurrect stale edits) |

Picking the tier is the design decision. If a choice should outlive the component that sets it,
it is tier 1 or 2 and belongs in a store — not in `useState` layered over the persisted world.

## Write policy: seed, don't override

**Automatic surface openers may _seed_ UI state, but must never _override_ a user's persisted
choice, and effect ordering must never decide which surface is active.**

Concretely, for the loom goal-tasks and workstream auto-opens:

- Whether an auto-open has already fired is itself **durable per-thread state** (tier 1), keyed
  by `scopedThreadKey` — not a component-lifetime `useRef`. A ref guard is wiped by any remount
  (route change to a draft/settings/index view) and re-fires the opener, which is exactly how an
  automatic effect ends up overriding the user's selection.
- Each surface auto-opens **at most once per thread, ever**:
  - flag already set → no store write at all;
  - flag unset and no panel state for the thread → full open (add + activate + show), set flag;
  - flag unset but panel state already exists → add the tab **without** touching the active
    surface or `isOpen` (a non-activating seed — no focus steal), set flag.
- When more than one surface is eligible in the same commit, seed them in **one atomic store
  transition** that activates exactly one by an explicit priority — never by which effect ran
  first. Do not compose two public store calls to achieve this; add one small `set`-based store
  action (marked `// loom:`) so the transition is a single persisted write.
- Consequence: closing a tab or closing all surfaces permanently suppresses reseeding for that
  thread. That is intended — the explicit way back is the tab strip, not an effect re-firing.

The disease this cures: "last opener wins" races where the active surface depends on component
lifetime and effect declaration order rather than on what the user chose.

## Retired exception: upstream's plan auto-open

This section used to carve out an exception for upstream's plan-sidebar auto-open
(`autoOpenPlanSidebar` + `planSidebarDismissedForTurnRef`), which activated a surface from an
automatic effect.

**It is gone.** Upstream folded plans into the chat transcript and deleted `PlanSidebar`
(#5558); cadence pull 6 adopted that deletion, so the `autoOpenPlanSidebar` setting, the `plan`
right-panel surface, and the turn-scoped dismissal refs no longer exist. The seed-not-override
policy above now has **no exceptions** — every automatic surface opener goes through
`seedSurfaces`.

## Orphan keys: no automatic sweep (by design)

Per-thread UI stores — both upstream's (`rightPanelStore`, `terminalUiStateStore`,
`diffPanelStore`) and loom's — accumulate orphaned `localStorage` keys for threads that no
longer exist. This is accepted: the residue is tiny (a view enum, a thread id, a short form
draft, a boolean flag), and upstream already tolerates it.

There is deliberately **no absence-based cleanup sweep**. Absence of a thread from current
client state is **not** a safe deletion signal: the client has no catch-up-complete marker —
shell status flips to `"live"` after the first non-empty batch, replay is batched, and the
server splices catch-up into the live stream with no completion event — so "absent while live"
can describe a thread whose replay simply has not arrived yet. Deleting on that signal risks
destroying valid state.

A future sweep is only safe once a genuine **catch-up-complete signal** exists (a protocol
change), and must be covered by a multi-batch (>64-event) replay test. Until then, loom's
per-thread stores expose a `removeThread(ref)` action (parity with the upstream stores, unit
tested) so that if upstream later grows a real thread-deletion path, loom wires into it with one
line rather than inventing an unsafe heuristic.
