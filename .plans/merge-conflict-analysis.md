# Merge Conflict Analysis — `workstreams-ui` → `main`

**Method:** read-only virtual merge via `git merge-tree 1e94ea1 main workstreams-ui`
(git 2.30 — old 3-arg form, no `--write-tree`). No branch/index/worktree state was
changed. In the output, `.our` = `main` (49f7eb5), `.their` = `workstreams-ui` (16fe641),
which matches "merge workstreams-ui INTO main".

- merge-base: `1e94ea1`
- `main`: `49f7eb5` (goals→orchestration-state, ephemeral reasoning streaming, goal dedupe)
- `workstreams-ui`: `16fe641` (sub-thread "workstream" feature) + pending uncommitted
  breadcrumb work in the worktree.

## Headline

- **36 conflicting files**: 33 with textual conflict hunks + 3 modify/delete (goal module).
- **1 anticipated additional conflict** once the breadcrumb commits: `ChatHeader.tsx`
  (main rewrote it; workstreams worktree is editing it). `threadRouteLineage.ts` is a
  **clean add** (absent on main) — no conflict.
- **Root cause of ~90% of conflicts: a divergent goal model.** `main` replaced the
  thread's `goalSlug: string` with a first-class `goalId: GoalId` + Goal/Task entities
  (`goals/goalState`, migration `035_GoalsAndTasks`), while `workstreams-ui` kept
  `goalSlug` and added sub-thread fields (`parentThreadId`, `role`, `goal` free-text,
  `status`, `blockedBy`). Both sides edited the same structs, SQL columns, projector/
  decider handlers, store, types, and test fixtures.
- **Definite migration-number collision** (035 + 036 on both sides — different files).
- **Load-bearing modify/delete:** `workstreams-ui` still imports the `goal/` module
  (`GoalsServiceLive`, `goalsRouteLayer`) that `main` deleted. A textual merge leaves
  `server.ts`/`ProviderCommandReactor.ts` importing files that no longer exist — this
  must be *ported* onto main's new goals-in-orchestration-state architecture, not merged.

## Migration collision (verified)

Both branches share up to `034`. Then:

| # | main | workstreams-ui |
|---|------|----------------|
| 035 | `035_GoalsAndTasks.ts` | `035_ProjectionThreadWorkstreamFields.ts` |
| 036 | `036_CanonicalizeReasoningEvents.ts` | `036_ProjectionThreadStatusAndDependencies.ts` |

Same numbers, different files → collision. The files themselves don't textually conflict
(distinct names), but `apps/server/src/persistence/Migrations.ts` conflicts in two hunks
(import block + registry array). **Resolution: renumber workstreams' migrations to
`037`/`038`** and append them after main's `035`/`036` in the registry. Migrations are
ordered/numbered append-only state, so the higher numbers must follow main's.

## The keystone semantic conflict: `packages/contracts/src/orchestration.ts` (7 hunks)

Three-way reality on the thread struct:

- **base:** `goalSlug: NullOr(TrimmedNonEmptyString)`
- **main:** removed `goalSlug`; added `goalId: NullOr(GoalId)` + `OrchestrationGoalShell`,
  `GoalId`, goal/task command+event families, reasoning-event canonicalization.
- **workstreams-ui:** kept `goalSlug`; added `parentThreadId`, `role` (string),
  `goal` (free-text string), `status` (new `ThreadStatus` literal:
  `planned|running|blocked|review|done`), `blockedBy: ThreadId[]`; added
  `ThreadStatusSetCommand`, `ThreadDependenciesSetCommand` and their
  `thread.status-set` / `thread.dependencies-set` events, plus union-array entries.

Most conflict hunks show an **empty `.our` side** because main *removed* `goalSlug` at
those positions while workstreams *added* fields there — they collide on the same struct
lines. The union/array additions (commands, events, payload structs) are additive on both
sides and just need both kept.

**Decision required (do not resolve mechanically):** how do workstreams' `goalSlug` +
`goal` (free-text) relate to main's first-class `goalId`/Goal entity? Options:
1. Keep main's `goalId` Goal-entity model as the canonical goal link, and treat
   workstreams' `goal` free-text + `role`/`parentThreadId`/`status`/`blockedBy` as
   *additional* sub-thread fields (drop the now-redundant `goalSlug`, repoint any
   workstream goal lookups to `goalId`).
2. Keep both `goalSlug` and `goalId` (NOT recommended — that's a compat-shim duplicate
   of the same concept; the codebase forbids backward-compat shims).

Recommendation leans to **option 1**, but this is a product/architecture call and should
be confirmed by the owner before resolution. Everything else (web + persistence + server)
follows mechanically once this contract is fixed.

## Conflict inventory by area

### A. Contract (resolve FIRST — keystone)
- `packages/contracts/src/orchestration.ts` — **SEMANTIC**, highest effort. See above.

### B. Goal module modify/delete (HIGH — porting, not merging)
- `apps/server/src/goal/GoalPackage.ts`, `GoalsService.ts`, `http.ts` — main **deleted**
  these; workstreams **modified** them. workstreams' `server.ts` (imports
  `GoalsServiceLive`, `goalsRouteLayer`) and `ProviderCommandReactor.ts` still depend on
  them. Must rewire workstreams' goal-touching logic onto main's orchestration-state
  goals; then take main's deletion of the `goal/` directory.

### C. Server persistence/projection (SEMANTIC, follows contract; mostly schema-mechanical)
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` — **10 hunks**, worst
  server file. Both sides add SELECT/INSERT columns to thread snapshot queries.
- `apps/server/src/persistence/Layers/ProjectionThreads.ts` (5 hunks) +
  `apps/server/src/persistence/Services/ProjectionThreads.ts` — DB column additions on
  both sides (main: goal columns; workstreams: status/blockedBy/parent/role/goalSlug).
- `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`,
  `apps/server/src/orchestration/projector.ts`, `decider.ts`,
  `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` — both add
  event/command handling for their respective new fields. Keep both handler sets.
- `apps/server/src/persistence/Migrations.ts` — renumber 037/038 (see above).
- `apps/server/src/ws.ts` — small, adjacent additions.

### D. Web (SEMANTIC, follows contract; main migrated `goalSlug`→`goalId`, `goalIndex`→`goalState`)
- `apps/web/src/store.ts` (6 hunks), `apps/web/src/types.ts` (3 hunks) — thread-shape
  fields mirror the contract decision.
- `apps/web/src/components/ChatView.tsx`, `ChatView.browser.tsx`, `ChatView.logic.ts`,
  `apps/web/src/components/KeybindingsToast.browser.tsx`,
  `apps/web/src/routes/_chat.index.tsx` — thread-field/goal plumbing.
- `packages/client-runtime/src/threadDetailReducer.ts` — reducer for new thread fields.

### E. Test fixtures (TEXTUAL / MECHANICAL — bulk, resolve last)
Conflicts are all default-thread-fixture builders adding the new fields side by side:
- `apps/mobile/src/lib/repositoryGroups.test.ts`, `threadActivity.test.ts`
- `apps/server/src/server.test.ts` (7 hunks), `orchestration/commandInvariants.test.ts`,
  `Layers/OrchestrationEngine.test.ts`, `Layers/ProjectionSnapshotQuery.test.ts`,
  `projector.test.ts`, `persistence/Layers/ProjectionRepositories.test.ts`,
  `provider/Layers/ProviderSessionReaper.test.ts`, `relay/AgentAwarenessRelay.test.ts`
- `apps/web/src/environments/runtime/service.threadSubscriptions.test.ts`
- `packages/client-runtime/src/shellSnapshotReducer.test.ts`, `shellSnapshotState.test.ts`,
  `threadDetailReducer.test.ts`, `threadDetailState.test.ts`
These become trivial once the contract's thread shape is final — extend each fixture with
the union of both field sets.

### F. Pending breadcrumb commit (anticipated, not yet in merge-tree)
- `apps/web/src/components/chat/ChatHeader.tsx` — **NEW conflict will appear.** main
  rewrote the goal header section (`useGoalIndex`→`useGoalById`/`countGoalTasks`,
  `goalSlug` prop → `goalId`, `goals/goalIndex`→`goals/goalState`). The breadcrumb edits
  the same component against the old `goalSlug`/`goalIndex` world → moderate conflict in
  the imports + `GoalHeaderSection` + props. Plan to resolve it the same way as the rest:
  adopt main's goal-model APIs, layer breadcrumb UI on top.
- `apps/web/src/components/ChatView.tsx` — already conflicting; breadcrumb adds more.
- `apps/web/src/threadRouteLineage.ts` (+`.test.ts`) — **clean add**, absent on main.

## Recommended strategy

1. **Finish & commit the breadcrumb work first.** A rebase needs a clean tree, and the
   `ChatHeader.tsx`/`ChatView.tsx` breadcrumb changes should be part of the branch being
   integrated, not loose worktree edits.
2. **Rebase `workstreams-ui` onto `main`** (preferred over a single merge commit): linear
   history, and conflicts surface per-commit so the goal-architecture *port* (area B) can
   be done incrementally and reviewed at each step. A merge would dump all 36 files at
   once including the load-bearing modify/delete.
3. **Confirm the goal-model decision** (orchestration.ts, option 1 above) with the owner
   before resolving — it's the keystone that determines every downstream resolution.
4. **Resolution order:** (a) orchestration.ts contract → (b) renumber migrations 037/038
   + Migrations.ts → (c) port goal module (area B) onto main's orchestration goals →
   (d) persistence schema (area C) → (e) server projector/decider/reactor → (f) web
   store/types/ChatView/ChatHeader/reducers → (g) test fixtures (mechanical) → run
   `vp check` && `vp run typecheck`.

## Effort ranking (worst → trivial)

1. `orchestration.ts` — semantic, needs a product decision (keystone).
2. Goal module modify/delete + `server.ts`/`ProviderCommandReactor.ts` rewire — porting.
3. `ProjectionSnapshotQuery.ts` (10 hunks) + `ProjectionThreads` (×2) + migration renumber.
4. `projector.ts` / `decider.ts` / `ProjectionPipeline.ts` event+command handlers.
5. Web: `store.ts`, `types.ts`, `ChatView.*`, `threadDetailReducer.ts`, `_chat.index.tsx`,
   + anticipated `ChatHeader.tsx` breadcrumb.
6. ~17 test-fixture files — mechanical (union of field sets) once the shape is final.
