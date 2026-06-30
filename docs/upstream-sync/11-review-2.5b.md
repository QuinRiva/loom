# Review 2.5b — Sidebar goal-CRUD lifecycle re-home

**Scope reviewed:** `git diff 880ed6182..HEAD` (HEAD = `824a656cc`)

- `ccb5915cc` — client-runtime `goal.create/archive/delete` wrappers
- `824a656cc` — Sidebar context-menu wiring

**Ground truth:** pre-merge fork `6150362cf:apps/web/src/components/Sidebar.tsx`
**Contracts:** `packages/contracts/src/orchestration.ts`

---

## Verdict: **SHIP**

The re-home is faithful to the fork's goal-CRUD semantics, correctly grafted onto upstream's current Sidebar (not a revert), routed through the new jotai/client-runtime command layer rather than the fork's zustand `dispatchCommand`, and — the part that matters most — the delete blast-radius is counted from the **full unfiltered** thread set, so it does not understate the cascade. Both required typechecks are green (0/0). **0 blockers, 0 majors.** A few minor notes below, none gating.

---

## Findings

### Blockers — none

### Majors — none

### Minor

**N1 — `assign-goal` submenu now project-filters (deviation from fork; an improvement).**
Re-home: `projectGoals.filter((goal) => goal.projectId === thread.projectId)`. The fork offered _all_ `projectGoals` (across every member project in a grouped project) for assignment. Restricting to the thread's own project is more correct — a goal carries a single `projectId` and threads are project-scoped, so cross-project assignment was always semantically odd (and the server may reject it). Defensible, deliberate, and the in-code comment explains it. Recorded as an intentional, safe deviation, not a regression.

**N2 — Delete count source differs from fork, but is equivalent-or-safer.**
Fork used `selectThreadCountForGoal(useStore.getState(), member.environmentId, goal.id)` (a zustand selector over the full environment summary map). That selector does not exist in the new atom-based state layer, so the re-home counts `sidebarThreads.filter(t => t.goalId === goal.id)`. Verified `sidebarThreads` here (`SidebarProjectItem` line 1403, `useThreadShellsForProjectRefs`) is the **full unfiltered shell set** — `projectThreads` (line 1422) is the roots-only derivative, and the delete handler correctly reads `sidebarThreads`, not `projectThreads`. Because a goal's attached threads (incl. workstream children) all live within the goal's project (one of this item's member projects) and shells include archived threads, the count cannot understate the decider's cascade; if anything it can only over-count harmlessly. Confirm dialog is genuinely gating (`if (!confirmed) return;` before `deleteGoal`). **Requirement met.**

**N3 — No live smoke test.** All wiring verified statically + typecheck only; no running Pi server available. The `contextMenu.show` `children` submenu path (used by "Assign to goal") is contract-supported and was the fork's mechanism, but should be exercised in the Phase 2.6 live smoke test. (Coder already flagged this.)

**N4 — `vp check` formatting not independently reproduced.** The two typechecks (the brief's verify bar) are 0/0. The repo's configured formatter wasn't runnable in isolation here (`prettier` not on PATH; `biome` is _not_ the project's formatter and its complaints don't apply). Trusting the coder's claim that `vp check` flags only pre-existing `docs/*` + `ChatHeader.tsx` issues, none in the three touched files. Worth a final `vp check` pass in 2.6.

---

## Judgement calls — both acceptable

**pinnedCollapsedThread intentional drop — CORRECT.** Confirmed the fork itself had `shouldShowThreadPanel = projectExpanded` (line 1431) — identical to the current code (line 1529). pinnedCollapsedThread was an **upstream-only** convenience; the fork never had it. Dropping it restores fork behaviour exactly, which is the whole point of this re-home. Restoring an upstream-only feature onto the Pi goal-grouping model (where the active thread can sit inside a collapsed goal _within_ a collapsed project) has ambiguous semantics and is disproportionate to a minor visual-anchor convenience. Sound decision.

**Compact single-thread goal row has no goal context menu — FAITHFUL, acceptable minor.** This is **not** a regression: the fork attached `onGoalContextMenu` only to the _expanded_ goal-header button (fork line 1056), never to the compact single-thread row. The re-home reproduces this exactly (`onContextMenu` on the goal-header button, `goal.known` only). Clear/assign remains reachable via the thread's own context menu, and a second thread expands the goal into the grouped header where the menu appears. Matches ground truth; leave as-is.

---

## Correctness spot-checks (all pass)

- **Wrapper shapes vs contracts:** `createGoal` uses `timestampedCommandMetadata` → emits `commandId` + `createdAt` (matches `GoalCreateCommand`: commandId, goalId, projectId, slug, title, description?, createdAt). `archiveGoal`/`deleteGoal` use `commandId` only (match `GoalArchiveCommand`/`GoalDeleteCommand`: commandId, goalId). Mirror `createProject`/`deleteProject` exactly. ✓
- **Atom wiring:** `create`/`archive`/`delete` added to `createGoalEnvironmentAtoms` reusing the same serial `scheduler` keyed on `[environmentId, goalId]` and `concurrency` as the 2.5 `updateMeta`. Re-exported via `state/threads.ts` → `goalEnvironment.{create,archive,delete}`; no barrel edits needed. ✓
- **create-goal flow:** title/slug/description prompts (slug auto-derived, same regex as fork) → `createGoal` (fresh `newGoalId()`) → awaited → `updateThreadMetadata({ threadId, goalId })`. Ordering preserved; added a failure toast the fork lacked (enhancement). ✓
- **assign / clear:** `thread.meta.update` with `goalId: rawGoalId ? GoalId.make(rawGoalId) : null` — identical to fork. ✓
- **rename:** reuses `goalEnvironment.updateMeta` (no new wrapper), guards `!title || title === goal.title`. ✓
- **Build:** `client-runtime` typecheck **0**, `apps/web` typecheck **0**. ✓
- No compat shims; no upstream sidebar feature regressed.

---

## Must-fix list

None. Recommended (non-gating) for Phase 2.6:

1. Exercise the goal create/assign/archive/delete + the `children` submenu in the live Pi-session smoke test (N3).
2. Final `vp check` pass to confirm the three files are clean (N4).
