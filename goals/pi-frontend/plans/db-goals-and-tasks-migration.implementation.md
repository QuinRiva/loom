# Implementation — DB-authoritative goals and tasks

Implements `db-goals-and-tasks-migration.md` (and its review amendments). Goals
and task trees are now first-class, event-sourced, project-scoped DB state keyed
by `GoalId`/`GoalTaskId`. Thread `worktreePath`/`branch` remain execution
context; threads reference goals by `goalId` (the worktree-ambiguous `goalSlug`
is gone). No file-backed compatibility shim, no coexistence period.

## What changed (by layer)

### Contracts (`packages/contracts`)

- `baseSchemas.ts`: added branded `GoalId`, `GoalTaskId`.
- `orchestration.ts`:
  - read models `OrchestrationGoalTask` (recursive tree via `Schema.suspend`),
    `OrchestrationGoal`, `OrchestrationGoalShell`; `goals` added to
    `OrchestrationReadModel` and `OrchestrationShellSnapshot`.
  - thread `goalSlug` → `goalId: GoalId` across `OrchestrationThread`,
    `OrchestrationThreadShell`, thread create/meta commands + payloads, and the
    turn-start bootstrap.
  - commands `goal.create|meta.update|archive|unarchive|delete` and
    `goal.task.create|update|delete` (added to dispatchable + client unions).
  - events `goal.created|meta-updated|archived|unarchived|deleted` and
    `goal.task-created|task-updated|task-deleted` + payloads; aggregate kind
    gains `"goal"`; event `aggregateId` union gains `GoalId`.
  - shell-stream `goal-upserted` / `goal-removed`.
  - removed file-centric `GoalTaskNode`/`GoalIndexEntry`/`GoalIndexStreamEvent`
    from `server.ts`.

### Server orchestration (`apps/server/src/orchestration`)

- `goalTaskTree.ts` (new): flatten/build/subtree helpers shared by the
  in-memory projector, invariants, and the SQL snapshot query. Tasks stored
  flat (parent + position); nested tree assembled for reads; deleted tasks
  excluded from reads (subtree delete).
- `commandInvariants.ts`: `requireGoal`, `requireGoalAbsent`,
  `requireGoalNotDeleted`, `requireUniqueGoalSlug`, `requireGoalTask`,
  `requireGoalTaskAbsent`, `requireGoalParentTask` (rejects self-parent).
- `decider.ts`: all 8 goal command cases; `thread.create`/`thread.meta.update`
  with non-null `goalId` require an active goal; `project.delete force` cascades
  active goals (`goal.delete`) alongside threads. `goal.task.create` appends at
  end when `position` omitted.
- `projector.ts` + `Schemas.ts`: goal aliases + in-memory projector cases for
  all goal/task events; thread `goalId`; empty read model gains `goals: []`.
- `Layers/OrchestrationEngine.ts`: `commandToAggregateRef` maps goal commands to
  the `goal` aggregate.

### Persistence (`apps/server/src/persistence`)

- Migration `035_GoalsAndTasks.ts`: `projection_goals`,
  `projection_goal_tasks` (+ indexes); `projection_threads.goal_slug` dropped,
  `goal_id` added. Registered in `Migrations.ts`.
- `Services/ProjectionGoals.ts` + `Layers/ProjectionGoals.ts` (new): combined
  goal+task repository (`upsertGoal/getGoalById/listGoals`,
  `upsertTask/listTasksByGoalId/listTasks`).
- `ProjectionThreads` service/layer: `goalSlug` → `goalId` (column `goal_id`).
- `OrchestrationEventStore` + `OrchestrationCommandReceipts`: `aggregateId`/
  `streamId` unions gain `GoalId`.

### Projection pipeline / snapshot (`apps/server/src/orchestration/Layers`)

- `ProjectionPipeline.ts`: `applyGoalsProjection` projector (goal + task events,
  subtree soft-delete) registered as `projection.goals`;
  `ProjectionGoalRepositoryLive` wired.
- `ProjectionSnapshotQuery.ts`: `assembleGoals`/`toGoalShells` + goal/task row
  queries; goals added to read-model snapshot, command read model, and shell
  snapshot (active goals, nested active tasks). Archived shell snapshot returns
  `goals: []`.

### Server API / agent (`apps/server/src`)

- `vcs/http.ts` (new): `GET /api/vcs/diff` — the relocated generic git-diff
  route. `goal/http.ts` (with file `/api/goals` + the diff sibling) deleted;
  `DiffPanel` repointed to `/api/vcs/diff`.
- `GoalsService`/`GoalPackage` deleted; removed from `server.ts`,
  `ProviderCommandReactor`, and all layer/test wiring (server.test,
  ProviderCommandReactor.test, integration harness).
- `ProviderCommandReactor.buildGoalSystemPrompt`: now reads DB goal/task state
  (via `getCommandReadModel`) and emits the task tree (with ids) plus explicit
  `t3 goal task ...` CLI instructions; no goal-file paths.
- `ws.ts` bootstrap: `goalId`.

### Agent CLI (`apps/server/src/cli`)

- `orchestrationMutation.ts` (new): generic live-preferred / offline-fallback
  dispatch extracted from `project.ts` (project CLI refactored onto it — no
  duplication). Live server is preferred so writes hit its projections + shell
  stream immediately; offline in-process engine only when no server answers.
- `goal.ts` (new) + `bin.ts`: `t3 goal list|show|create|update` and
  `t3 goal task add|done|open|rename|delete`.

### Web + shared (`apps/web`, `packages/client-runtime`, `apps/mobile`)

- `types.ts`: thread `goalId`; `Goal`/`GoalShell`/`GoalTask` aliases.
- `store.ts`: `goalIds`/`goalById`/`goalIdsByProjectId` env-state slice fed by
  shell snapshot + `goal-upserted`/`goal-removed`; `selectGoalsAcrossEnvironments`.
- `goals/goalState.tsx` (new): store-backed `useGoals`/`useGoalById`/
  `countGoalTasks`/`TaskTree`. `goals/goalIndex.tsx` (file-index poller) deleted.
- Sidebar: goals sourced from store, grouped/keyed/collapsed by `goal.id`;
  create-goal dispatches `goal.create` + `thread.meta.update`; assign/clear by
  goal id; progress from task counts. ChatHeader, GoalTasksPanel,
  `_chat.index` route use the store. `lib/utils`: `newGoalId`/`newGoalTaskId`.
- client-runtime `threadDetailReducer` `goalId`; fixtures across web/
  client-runtime/mobile updated.

## Validation

- `vp run typecheck` — **PASS** (all 15 packages).
- `vp run lint:mobile` — **PASS** (no native files changed; native linters
  skipped as not installed).
- `vp check` (format) — formatter applied; the remaining single lint **error**
  is pre-existing and unrelated: `t3code(no-manual-effect-runtime-in-tests)` in
  `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts`
  (untouched; 29 `Effect.runPromise` calls present at HEAD). Remaining warnings
  (CommandPalette / ChatMarkdown component-in-props) are also pre-existing.
- Focused unit tests — **38 passed**: `commandInvariants.test`,
  `projector.test`, `ProjectionRepositories.test`, `ProjectionSnapshotQuery.test`,
  `OrchestrationEngine.test` (the latter two run real migrations incl. 035 +
  projection pipeline on real SQLite).
- Canonical entrypoint (new feature) — goal CLI exercised end-to-end against a
  temp base dir on real SQLite: `project add` → `goal create` → `goal task add`
  (root + child via `--parent`) → `goal task done` → `goal show` (nested tree,
  `1/2` count) → `goal task delete` (subtree removed, `0/0`). All correct and
  persisted across invocations. The live-server path was not exercised (no
  running dogfood server in this environment); offline fallback validated.

## Deviations / notes

- Combined goal+task repository (plan allowed "one combined repository if
  smaller").
- Shell-snapshot goals = non-deleted goals with nested non-deleted tasks;
  archived shell snapshot carries `goals: []` (archived view is thread-scoped).
- Synthetic "missing goal" sidebar rows reduced to a defensive fallback only
  (DB invariants make orphan assignments impossible in normal UX).
- One-time dogfood importer: not written. Local DB simply migrates (drops
  `goal_slug`, adds `goal_id`); existing dogfood goal files are not imported.
  Flagged for the user — if preserving the current `goals/pi-frontend/goal.md`
  content as live DB state matters, a throwaway importer can be run, otherwise
  recreate the goal via `t3 goal create`. `goal.md` and the WS-push backlog plan
  were marked non-authoritative / superseded rather than deleted.

## Residual risks

- Web goal UX verified by typecheck + store/reducer unit tests and the CLI
  round trip, but not via a live browser session against a running server.
- Live-server CLI dispatch path verified only structurally (typecheck); the
  offline path is runtime-verified.
- `vp check` is red solely due to pre-existing lint debt in an untouched test
  file; this migration introduces no new lint errors.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "plan-followed",
      "status": "satisfied",
      "evidence": "Goals/tasks are DB-authoritative event-sourced aggregates (contracts goal commands/events/aggregate kind; decider+invariants; in-memory projector; migration 035 + ProjectionGoals repo + ProjectionPipeline projector + ProjectionSnapshotQuery assembly; shell-stream goal-upserted/removed). No file-backed shim: GoalsService/GoalPackage/goal HTTP deleted, goalIndex.tsx removed, /api/goals removed, /api/goals/diff relocated to /api/vcs/diff before deletion. Thread worktreePath/branch retained; goalSlug fully replaced by goalId across server/web/client-runtime/mobile. Agent updates tasks via new t3 goal CLI + DB-state system prompt."
    },
    {
      "id": "validation",
      "status": "satisfied",
      "evidence": "vp run typecheck PASS (15 pkgs); vp run lint:mobile PASS; vp check formatting applied with only a pre-existing unrelated lint error remaining (ProviderRuntimeIngestion.test.ts, untouched). 38 focused unit tests pass; goal CLI end-to-end real-SQLite round trip (create/add/child/done/show/subtree-delete) verified."
    }
  ],
  "changedFiles": [
    "packages/contracts/src/baseSchemas.ts",
    "packages/contracts/src/orchestration.ts",
    "packages/contracts/src/server.ts",
    "apps/server/src/orchestration/goalTaskTree.ts",
    "apps/server/src/orchestration/commandInvariants.ts",
    "apps/server/src/orchestration/decider.ts",
    "apps/server/src/orchestration/projector.ts",
    "apps/server/src/orchestration/Schemas.ts",
    "apps/server/src/orchestration/Layers/OrchestrationEngine.ts",
    "apps/server/src/orchestration/Layers/ProjectionPipeline.ts",
    "apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts",
    "apps/server/src/orchestration/Layers/ProviderCommandReactor.ts",
    "apps/server/src/persistence/Migrations.ts",
    "apps/server/src/persistence/Migrations/035_GoalsAndTasks.ts",
    "apps/server/src/persistence/Services/ProjectionGoals.ts",
    "apps/server/src/persistence/Layers/ProjectionGoals.ts",
    "apps/server/src/persistence/Services/ProjectionThreads.ts",
    "apps/server/src/persistence/Layers/ProjectionThreads.ts",
    "apps/server/src/persistence/Layers/OrchestrationEventStore.ts",
    "apps/server/src/persistence/Services/OrchestrationCommandReceipts.ts",
    "apps/server/src/cli/orchestrationMutation.ts",
    "apps/server/src/cli/goal.ts",
    "apps/server/src/cli/project.ts",
    "apps/server/src/bin.ts",
    "apps/server/src/vcs/http.ts",
    "apps/server/src/server.ts",
    "apps/server/src/ws.ts",
    "apps/server/src/goal/GoalsService.ts (deleted)",
    "apps/server/src/goal/GoalPackage.ts (deleted)",
    "apps/server/src/goal/http.ts (deleted)",
    "apps/web/src/types.ts",
    "apps/web/src/store.ts",
    "apps/web/src/composerDraftStore.ts",
    "apps/web/src/lib/utils.ts",
    "apps/web/src/hooks/useHandleNewThread.ts",
    "apps/web/src/components/Sidebar.tsx",
    "apps/web/src/components/ChatView.tsx",
    "apps/web/src/components/ChatView.logic.ts",
    "apps/web/src/components/ChatView.browser.tsx",
    "apps/web/src/components/KeybindingsToast.browser.tsx",
    "apps/web/src/components/DiffPanel.tsx",
    "apps/web/src/components/GoalTasksPanel.tsx",
    "apps/web/src/components/chat/ChatHeader.tsx",
    "apps/web/src/routes/_chat.index.tsx",
    "apps/web/src/goals/goalState.tsx",
    "apps/web/src/goals/goalIndex.tsx (deleted)",
    "packages/client-runtime/src/threadDetailReducer.ts",
    "apps/server (test fixtures + integration harness goalId/goals/GoalsService removal)",
    "packages/client-runtime + apps/mobile + apps/web (test fixtures goalId/goals)",
    "goals/pi-frontend/goal.md (non-authoritative banner)",
    "goals/pi-frontend/plans/goal-index-ws-push.md (superseded banner)",
    "progress.md"
  ],
  "testsAddedOrUpdated": [
    "No new tests authored (prototype: tests optional). Updated existing fixtures for the goalId/goals schema change across apps/server, apps/web, packages/client-runtime, apps/mobile."
  ],
  "commandsRun": [
    { "command": "vp run typecheck", "result": "passed", "summary": "all 15 packages, 0 errors" },
    { "command": "vp run lint:mobile", "result": "passed", "summary": "no native files changed; native linters skipped (not installed)" },
    { "command": "vp check", "result": "failed", "summary": "formatting auto-fixed; remaining single lint error is pre-existing in untouched ProviderRuntimeIngestion.test.ts (no-manual-effect-runtime-in-tests). No new lint errors introduced." },
    { "command": "vp test run (commandInvariants, projector, ProjectionRepositories, ProjectionSnapshotQuery, OrchestrationEngine)", "result": "passed", "summary": "38 tests passed on real SQLite incl. migration 035 + projection pipeline" },
    { "command": "node src/bin.ts goal {create,task add/done/delete,show} (temp base-dir)", "result": "passed", "summary": "end-to-end goal/task DB round trip incl. nested tree + subtree delete" }
  ],
  "validationOutput": [
    "vp run typecheck: 15/15 packages, 0 errors.",
    "vp run lint:mobile: exit 0.",
    "vp check: 1 error + 12 warnings, ALL pre-existing in files not modified by this change (ProviderRuntimeIngestion.test.ts; CommandPalette/ChatMarkdown).",
    "Focused tests: Test Files passed; Tests 38 passed (16 + 22).",
    "goal CLI: 'goal show' rendered nested tree '- [x] First task / - [ ] Child task' with count 1/2; after subtree delete -> 0/0."
  ],
  "residualRisks": [
    "Web goal UX not verified in a live browser against a running server (typecheck + unit tests + CLI round trip only).",
    "Live-server CLI dispatch path verified structurally only; offline path runtime-verified.",
    "No dogfood-data importer written: local migration drops goal_slug / adds goal_id; existing goals/pi-frontend/goal.md content is NOT imported into the DB. User decision needed if that content must persist as live goal state."
  ],
  "noStagedFiles": true,
  "notes": "vp check is red ONLY due to pre-existing lint debt (29 Effect.runPromise calls in an untouched committed test file) — not introduced here; treat as out-of-scope. Dogfood note: after this lands, recreate the active goal via `t3 goal create ...` (or run a throwaway importer) since file goals are no longer read."
}
```
