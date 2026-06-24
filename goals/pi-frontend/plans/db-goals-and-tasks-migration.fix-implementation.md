# Fix implementation — DB-authoritative goals/tasks migration review

Addresses the must-fix issues from
`db-goals-and-tasks-migration.gpt55-review.md`. Scope was limited to those
issues; inline web task editing was intentionally NOT added (deferred), thread
`worktreePath`/`branch` were left intact, and no backward-compat shims were
introduced.

## Fixes

### 1. Shell stream emits goal updates live

`apps/server/src/ws.ts` `toShellStreamEvent` now maps any `aggregateKind ===
"goal"` event (goal.create/meta/archive/unarchive/delete and goal.task.\*) to a
shell-stream event: it looks up the active goal shell by id and emits
`goal-upserted` when present, `goal-removed` when absent (archived or deleted).
This required a new query `getGoalShellById` on `ProjectionSnapshotQuery`
(Service interface + Layer; reuses `listGoalRows`/`listGoalTaskRows` +
`assembleGoals` + `toGoalShells`, so it returns only active, non-archived,
non-deleted goals). Connected clients now update without a full snapshot reload.

### 2. client-runtime / mobile reducer coverage

- `packages/client-runtime/src/shellSnapshotReducer.ts`: added `goal-upserted`
  (upsert into `snapshot.goals`) and `goal-removed` (filter out) cases.
- `packages/client-runtime/src/threadDetailReducer.ts`: `thread.meta-updated`
  now applies `goalId` (assign/clear) alongside title/model/branch/worktree.
- The web store (`apps/web/src/store.ts`) already handled both goal stream
  variants and the meta-updated `goalId`; no change needed there.

### 3. Project-scoped goal assignment

New invariant `requireActiveGoalInProject` (goal exists, not deleted, not
archived, and `goal.projectId === projectId`). `thread.create` uses it with
`command.projectId`; `thread.meta.update` captures the thread and uses
`thread.projectId`. Clearing `goalId` (null) remains valid (guarded by
`command.goalId != null`). A thread in project A can no longer attach to a goal
in project B.

### 4. Slug uniqueness aligned with DB constraint

`requireUniqueGoalSlug` no longer filters `deletedAt === null`, so a deleted
goal still reserves its `(project_id, slug)` exactly like the SQL `UNIQUE`
constraint in migration 035. A create that reused a deleted goal's slug now
fails at the invariant stage instead of passing invariants and then failing the
DB transaction. (The goal projector soft-deletes — the row + slug stay in
`projection_goals` — so the command read model sees deleted goals.)

### 5. Goal projector required for snapshot readiness

`projection.goals` added to `REQUIRED_SNAPSHOT_PROJECTORS` in
`ProjectionSnapshotQuery.ts`. Snapshot sequence can no longer claim readiness
while the goal projection is stale/failed.

### 6. Coherent archive semantics

- `toGoalShells` now filters `deletedAt === null && archivedAt === null`, so the
  active shell snapshot and the live stream exclude archived goals (the archived
  shell snapshot already returns `goals: []`).
- New `requireGoalActive` (not deleted AND not archived). Task mutations
  (`goal.task.create|update|delete`) now require an active goal instead of just
  non-deleted. Goal assignment requires active via `requireActiveGoalInProject`.
- Active goals are not deleted and not archived by definition; `goal.archive` /
  `goal.unarchive` keep using `requireGoalNotDeleted` (you must be able to
  unarchive an archived goal).

### 7. Task reparent disallowed for MVP

`parentTaskId` removed from `GoalTaskUpdateCommand` and `GoalTaskUpdatedPayload`
(contracts), from the `goal.task.update` decider case, the in-memory
`projector.ts`, and the SQL `applyGoalsProjection` task-updated branch. Task
_creation_ still accepts `parentTaskId` (with `requireGoalParentTask` existence
check; the now-dead self-parent branch and unused `taskId` param were removed).
With no update-path to change a parent, the tree cannot form a cycle. CLI and
web needed no change — the CLI never set `parentTaskId` on update and the web
panel is read-only.

### 8. Migration 036 documented

`036_CanonicalizeReasoningEvents.ts` now carries a header comment explaining it
is an enabling dogfood runtime-data fix (legacy `reasoningDelta` rows failed to
decode and blocked dogfood startup), not unrelated collateral — matching the
author-session consult recorded in `progress.md`. Kept in this branch.

## Changed files

- `packages/contracts/src/orchestration.ts`
- `apps/server/src/ws.ts`
- `apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts`
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`
- `apps/server/src/orchestration/commandInvariants.ts`
- `apps/server/src/orchestration/decider.ts`
- `apps/server/src/orchestration/projector.ts`
- `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`
- `apps/server/src/persistence/Migrations/036_CanonicalizeReasoningEvents.ts`
- `packages/client-runtime/src/shellSnapshotReducer.ts`
- `packages/client-runtime/src/threadDetailReducer.ts`
- Test mocks updated for the new `getGoalShellById` member:
  `apps/server/src/{server,serverRuntimeStartup}.test.ts`,
  `apps/server/src/checkpointing/Layers/CheckpointDiffQuery.test.ts`,
  `apps/server/src/orchestration/Layers/OrchestrationEngine.test.ts`,
  `apps/server/src/provider/Layers/ProviderSessionReaper.test.ts`,
  `apps/server/src/project/Layers/ProjectSetupScriptRunner.test.ts`
- `progress.md`

## Validation

- `vp run typecheck` — PASS, 15/15 packages, 0 errors.
- Focused tests — PASS:
  - server: `commandInvariants.test`, `projector.test`,
    `ProjectionSnapshotQuery.test`, `OrchestrationEngine.test` → 36 passed.
  - server: `ProjectionRepositories.test` → 2 passed.
  - client-runtime: 188 passed / 1 failed. The single failure
    (`addProject.test` "builds the existing project.create command shape") is a
    pre-existing default-model drift (`pi`/`claude-opus-4-8` vs expected
    `codex`/`gpt-5.4`) in a file I did not touch — unrelated to these fixes.
  - web: `store.test` → 17 passed.
- `vp lint` — clean except the pre-existing
  `no-manual-effect-runtime-in-tests` error in the untouched
  `ProviderRuntimeIngestion.test.ts` (29 `Effect.runPromise` calls at HEAD).
- `lint:mobile` not run: no native mobile code changed (only a shared
  client-runtime reducer).

## Residual risks

- No live-server browser dogfood pass; verified via typecheck + focused unit
  tests on real SQLite (projection pipeline incl. migration 035).
- The pre-existing `addProject.test` default-model failure and the
  `Sidebar.tsx` unused-`useQuery` import warning both originate from the
  migration branch, not these fixes; left as-is (out of scope).
- `getGoalShellById` lists all goal/task rows per goal event. Goal/task volumes
  are small, so this is acceptable for MVP; a single-goal SQL query could
  replace it later if needed.
