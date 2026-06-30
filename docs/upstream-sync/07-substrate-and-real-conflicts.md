---
manager_sessions:
  - role: analysis
    authored_at: 2026-06-30
---

# Upstream sync — substrate established & REAL conflict surface

_Phase 2.0. Substrate built; conflicts **measured**, not resolved. No conflict
was touched; the working tree is clean and the graft is left in place.
Australian English._

> **What this document is.** Doc 04 (`04-conflict-surface.md`) and doc 05
> (`05-strategy.md`) _predicted_ the conflict surface from `git diff` attribution.
> This document replaces prediction with **ground truth**: it grafts the synthetic
> merge-base and runs a real 3-way merge, then reports exactly which files git
> actually conflicts on. Read the headline, then the surprises, then the
> zone-by-zone reconciliation.

---

## Headline — the surface is ~40% lighter than predicted

| Set                                               | Predicted (doc 04) | **Measured** |
| ------------------------------------------------- | ------------------ | ------------ |
| Files changed fork-side (`$B..HEAD`)              | 319                | **325**      |
| Files changed upstream-side (`$B..upstream/main`) | 1535               | **1535**     |
| Files touched by **both** (candidates)            | 106                | **106**      |
| **Files git actually CONFLICTS on**               | _(implied ~106)_   | **62**       |

**The single most important number: 62 real conflicts, not 106.** Of the 106
both-touched candidates, **45 auto-merged cleanly** (git reconciled the two sides
with no human needed) and 1 extra conflict surfaced from rename detection outside
the 106 set. The genuine human surface is **62 files**:

- **43 `UU`** — both sides edited the same file; standard 3-way conflict.
- **19 `UD`** — fork modified a file upstream **deleted**; the hard
  delete/modify core that cannot be auto-merged and must be re-homed.

Substrate facts (all verified live in this worktree):

- Branch fast-forwarded to `origin/main` (`e9e86648b`); Phase 1 docs committed
  locally on top (`edc0cd715`, **not pushed**).
- `git replace --graft 6c82133 477795697` created; `git merge-base HEAD
upstream/main` → **`477795697`** ✓. The graft ref is global to the shared clone,
  reversible with `git replace -d 6c82133`, and has **not** been pushed.
- `git merge-base HEAD upstream/main` measured against `upstream/main =
2448212367` (v0.0.28, 289 commits past baseline). `filter-repo` was **not** run.
- Conflicts measured with `git merge --no-commit --no-ff upstream/main` →
  `git status --porcelain` → `git merge --abort`. Working tree ends **clean**.
  (`git merge-tree --write-tree` is git 2.38+; this clone is git 2.30.2, so the
  no-commit/abort route was used.)

---

## The good news vs prediction

Three predicted-painful areas largely **evaporated** under a real merge:

1. **Contracts are almost entirely clean.** `orchestration.ts` (Z1, the "spine"),
   `rpc.ts`, and `server.ts` in `packages/contracts` **all auto-merged** — git
   applied the fork's +701 lines and upstream's 1-line `startFromOrigin` change
   with no conflict. Only **`packages/contracts/src/settings.ts` (Z5)** conflicts.
   Phase 1 ("contracts first") is materially lighter than budgeted.

2. **The Effect sweep (Z8) is concentrated, not pervasive.** Predicted to "produce
   textual conflicts in nearly every shared server file". In reality the provider
   adapters all **auto-merged**: `ClaudeAdapter.ts`, `CodexSessionRuntime.ts`,
   `opencodeRuntime.ts`, `AcpSessionRuntime.ts`, plus `config.ts`,
   `AgentAwarenessRelay.ts`, and `McpSessionRegistry.ts`. The Effect conflicts that
   remain are localised to the `*TextGeneration.ts` family (see Z8 below). The
   convention-conformance work for fork-new code is still real, but it is a
   typecheck/lint task, not a merge-conflict task.

3. **`package.json` manifests auto-merged.** Root, `apps/server`, and
   `packages/shared` `package.json` all merged cleanly; only `pnpm-lock.yaml`
   conflicts (regenerate it anyway, per Z19).

The two hardest predicted zones **did** materialise exactly as feared — `store.ts`
and the client-runtime flat modules are all `UD` delete/modify — so the strategy's
ordering still holds. The surface is just smaller around them.

---

## Surprises — real conflicts NOT in the 20-zone map

| File                                                      | fork (+/−)  | upstream (+/−) | Note / disposition                                                                                                                                                                 |
| --------------------------------------------------------- | ----------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/terminal/Layers/Manager.ts`              | edited      | **deleted**    | Doc 04 (Z8) assumed a content edit; upstream **deleted** it (terminal layer restructure). It is a **delete/modify**, belongs in the re-home bucket, not the Effect sweep.          |
| `apps/web/src/environments/runtime/service.ts`            | edited      | **deleted**    | Upstream deleted a web runtime service the fork modified. New structural delete/modify, not in the map.                                                                            |
| `apps/web/src/components/chat/ChatHeader.tsx`             | **+249/−2** | +25/−73        | Substantial fork addition (goal header / multi-session) — a real web-shell conflict that should be tracked alongside Z11 ChatView.                                                 |
| `apps/web/src/types.ts`                                   | +59/−0      | +23/−137       | Fork added shared web types; upstream reshaped. Re-home additive types.                                                                                                            |
| `apps/web/src/routes/_chat.index.tsx`                     | +55/−1      | +12/−8         | Route-level shell wiring (multi-session). Re-apply fork hook.                                                                                                                      |
| `apps/server/src/cli/project.ts`                          | +17/−202    | +203/−65       | Both heavily rewrote it. Genuine 3-way; not previously called out.                                                                                                                 |
| `apps/web/src/components/DiffPanel.tsx`                   | +30/−11     | **+538/−401**  | Upstream rewrote it wholesale; THEIRS+ADD. Sits with the Z14 cluster.                                                                                                              |
| `apps/desktop/src/settings/DesktopClientSettings.test.ts` | +1/−0       | +25/−2         | **Out of declared fork scope** — the fork touched `apps/desktop`. Trivial (+1 line); take-theirs/drop the fork edit. Flags that the fork delta leaked into desktop.                |
| `packages/client-runtime/src/state/threadReducer.test.ts` | (rename)    | +700/−0        | The 1 conflict outside the 106 set — rename detection paired a deleted fork `*State.test.ts` against this new upstream `state/` file. Resolves with the Z4 client-runtime re-home. |

**Plus a cluster of test/browser files** the zone map (which enumerated source
files) did not list individually — they conflict and travel with their source
zone: `store.test.ts`, `ChatView.logic.test.ts`, `ChatView.browser.tsx`,
`Sidebar.logic.test.ts`, `MessagesTimeline.browser.tsx`, `TextGeneration.test.ts`,
`server.test.ts`, `McpSessionRegistry.test.ts`, `ProviderRuntimeIngestion.test.ts`,
`environmentGrouping.test.ts`, `localApi.test.ts`, and the client-runtime
`*State.test.ts` set. Budget for test-file reconciliation in each phase, not as an
afterthought.

---

## The 62 conflicts, grouped by area

### Delete/modify — upstream DELETED, fork modified (19 × `UD`) — the hard core

These cannot be 3-way-merged; the fork delta must be **re-homed** onto upstream's
new layout.

**`packages/client-runtime` (9)** — the #2978 connection rewrite (Z4):

- `src/wsTransport.ts`, `src/wsTransport.test.ts`
- `src/wsRpcProtocol.ts`
- `src/threadDetailState.ts`, `src/threadDetailState.test.ts`
- `src/index.ts`
- `src/archivedThreadsState.test.ts`, `src/shellSnapshotState.test.ts`

**`apps/web` (7)** — store decomposition (Z3) + deleted services/browser tests:

- `src/store.ts`, `src/store.test.ts` (Z3)
- `src/rpc/serverState.ts` (Z4 sibling, deleted)
- `src/environments/runtime/service.ts`, `…/service.threadSubscriptions.test.ts` _(surprise: deleted upstream)_
- `src/components/ChatView.browser.tsx`, `src/components/chat/MessagesTimeline.browser.tsx`, `src/components/KeybindingsToast.browser.tsx`

**`apps/server` (3)**:

- `src/terminal/Layers/Manager.ts` _(surprise: deleted upstream, not a content edit)_
- `src/checkpointing/Layers/CheckpointDiffQuery.test.ts`
- `src/project/Layers/ProjectSetupScriptRunner.test.ts`

### Both-modified (43 × `UU`) — standard 3-way

**`packages/contracts` (1):** `src/settings.ts` (Z5).

**`apps/server` (15):**

- `src/server.ts`, `src/ws.ts` (Z9), `src/serverRuntimeStartup.ts` (Z10)
- `src/orchestration/Layers/ProjectionSnapshotQuery.ts` (Z2 — predicted trivial, did produce a small conflict), `…/ProviderRuntimeIngestion.test.ts`
- `src/textGeneration/TextGeneration.ts` (Z17), `…/ClaudeTextGeneration.ts`, `…/CodexTextGeneration.ts`, `…/CursorTextGeneration.ts`, `…/GrokTextGeneration.ts`, `…/OpenCodeTextGeneration.ts`, `…/TextGeneration.test.ts` (Z8 — the Effect conflicts live **here**)
- `src/cli/project.ts` _(surprise)_, `src/mcp/McpSessionRegistry.test.ts`, `src/server.test.ts`

**`apps/web` (24):**

- Chat shell: `ChatView.tsx`, `ChatView.logic.ts`, `ChatView.logic.test.ts` (Z11); `chat/ChatHeader.tsx` _(surprise)_; `chat/ChatComposer.tsx`, `composerDraftStore.ts`, `composer-editor-mentions.ts`, `uiStateStore.ts`, `rightPanelStore.ts`, `components/RightPanelTabs.tsx`, `components/CommandPalette.tsx` (Z14); `components/DiffPanel.tsx` _(surprise)_
- Timeline/markdown: `chat/MessagesTimeline.tsx`, `chat/MessagesTimeline.logic.ts`, `ChatMarkdown.tsx` (Z13)
- Sidebar: `Sidebar.tsx`, `Sidebar.logic.test.ts` (Z12 — note `Sidebar.logic.ts` auto-merged)
- Status/settings/routing: `ThreadStatusIndicators.tsx` (Z15), `settings/SettingsPanels.tsx`, `routes/_chat.index.tsx` _(surprise)_, `types.ts` _(surprise)_, `hooks/useHandleNewThread.ts` (Z17)
- Tests: `environmentGrouping.test.ts`, `localApi.test.ts`

**`packages/client-runtime` (1):** `src/state/threadReducer.test.ts` _(rename surprise)_.

**`apps/desktop` (1):** `src/settings/DesktopClientSettings.test.ts` _(out-of-scope surprise)_.

**Lockfile (1):** `pnpm-lock.yaml` (Z19 — regenerate).

---

## Zone map reconciliation (doc 04) — did each prediction materialise?

| Zone                                  | Prediction                    | **Reality**                                                                            |
| ------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------- |
| Z1 `orchestration.ts` contract        | OURS + 1 line, trivial        | **CLEAN auto-merge** — even better; no conflict                                        |
| Z2 `ProjectionSnapshotQuery.ts`       | OURS, trivial                 | **UU** — small conflict did surface (still trivial)                                    |
| Z3 `store.ts` decomposition           | RE-ENGINEER (hard)            | **UD ✓** confirmed hard (+`store.test.ts`)                                             |
| Z4 client-runtime rewrite             | RE-ENGINEER (hard)            | **UD ✓** all flat modules + `serverState.ts`                                           |
| Z5 `settings.ts`                      | 3-way                         | **UU ✓**; contracts `rpc.ts`/`server.ts` **clean** (better)                            |
| Z6 PiDriver SPI re-fit                | OURS, re-fit (no conflict)    | **No conflict ✓** — typecheck task, as predicted                                       |
| Z7 `builtInDrivers.ts`                | restore THEIRS + add Pi       | **No conflict ✓** — upstream untouched                                                 |
| Z8 Effect sweep                       | THEIRS, pervasive             | **Localised ✓ to `*TextGeneration.ts`**; adapters/config/relay **clean** (much better) |
| Z9 `ws.ts`/`server.ts`                | 3-way                         | **UU ✓** both                                                                          |
| Z10 `serverRuntimeStartup.ts`         | THEIRS + re-add layers        | **UU ✓** (`.test.ts` clean)                                                            |
| Z11 `ChatView.tsx`                    | RE-ENGINEER (hardest textual) | **UU ✓** (+`.logic.ts`/`.logic.test.ts`; `.browser.tsx` UD)                            |
| Z12 `Sidebar.tsx`                     | 3-way, fork-heavy             | **UU ✓**; `Sidebar.logic.ts` **clean**                                                 |
| Z13 timeline/reasoning                | REDO-CLEAN                    | **UU ✓** (`MessagesTimeline.tsx`/`.logic.ts`/`ChatMarkdown.tsx`)                       |
| Z14 composer cluster                  | THEIRS+ADD                    | **UU ✓** all seven                                                                     |
| Z15 `ThreadStatusIndicators.tsx`      | OURS-leaning 3-way            | **UU ✓**                                                                               |
| Z16 account-usage                     | OURS, self-contained          | **No conflict ✓**                                                                      |
| Z17 `useHandleNewThread.ts` + textGen | THEIRS+ADD                    | **UU ✓** (`TextGenerationUtils.ts` clean)                                              |
| Z18 goal/workstream engine            | OURS, carries through         | **No conflict ✓** — fork-only paths                                                    |
| Z19 lockfiles/package.json            | THEIRS, regenerate            | **Only `pnpm-lock.yaml` UU**; all `package.json` **clean**                             |
| Z20 docs/plans/goals                  | DROP/carry                    | **No conflict ✓** (`docs/upstream-sync/` committed ours)                               |

**Verdict: every predicted-hard zone is confirmed; several predicted-medium zones
came in clean. No prediction was contradicted in a way that worsens the plan.**

---

## Does the predicted phasing still hold? — Yes, with three small adjustments

The dependency-ordered plan (substrate → contracts → client-runtime/store →
server core → web shell → tail) **stands unchanged**. The hard gates (Z3, Z4,
Z11) are confirmed real; the contract gate (Z1) turned out free. Adjustments:

1. **Phase 1 (contracts) shrinks to one file** — only `settings.ts` conflicts.
   `orchestration.ts`/`rpc.ts`/`server.ts` auto-merged. Re-budget Phase 1 down.
2. **Two extra delete/modify re-homes** belong in the Phase 2 structural bucket,
   not the Effect sweep: `apps/server/src/terminal/Layers/Manager.ts` and
   `apps/web/src/environments/runtime/service.ts` (both deleted upstream).
3. **Add `ChatHeader.tsx` (fork +249) to the Z11 web-shell cluster**, and note
   the small out-of-scope `apps/desktop` test conflict (take-theirs/drop). The
   Z8 Effect work is lighter than budgeted — concentrate it on `*TextGeneration.ts`.

Net effect on effort: **lighter, not heavier.** The two genuine engineering
rewrites (Z3 store, Z4 client-runtime) are unchanged; everything around them is
smaller than doc 04/05 assumed.

---

## State left for the orchestrator

- Branch `t3code/i-created-this-project-pi-frontend-initially-to` at `edc0cd715`
  (Phase 1 docs committed locally, **not pushed**), fast-forwarded onto
  `origin/main`.
- **Graft `git replace --graft 6c82133 477795697` is IN PLACE** (global to the
  clone). `git merge-base HEAD upstream/main` → `477795697`. Undo with
  `git replace -d 6c82133` if ever needed.
- Working tree **clean**; no in-progress merge.
- Nothing pushed; `filter-repo` not run (the permanent history bake-in remains a
  deliberate later step).

### Reproduce the measurement

```sh
B=477795697d8546a8db4903bd878a5ad3196423b9
git merge --no-commit --no-ff upstream/main      # exits 1 on conflicts
git status --porcelain | grep -E '^(UU|UD) '     # the 62 conflicts
git merge --abort                                # restore a clean tree
```
