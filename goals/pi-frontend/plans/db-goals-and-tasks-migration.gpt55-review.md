# GPT-5.5 Review — DB-authoritative goals/tasks migration

## Review

- **Correct:** The diff route was preserved and moved out of goal HTTP code: server now serves `GET /api/vcs/diff` in `apps/server/src/vcs/http.ts:15-18`, and `DiffPanel` calls `/api/vcs/diff` at `apps/web/src/components/DiffPanel.tsx:154-158`.
- **Correct:** Source code has no remaining `goalSlug`, `GoalPackage`, `GoalsService`, `goalIndex`, or `/api/goals` references under `apps/*/src` / `packages/*/src` (verified with `rg`; ignored `apps/server/dist` is stale generated output, not source).
- **Correct:** Agent prompt now uses DB goal state and CLI instructions, not goal files: `ProviderCommandReactor.ts:107-120` renders task ids and `t3 goal task ...`; `ProviderCommandReactor.ts:387-397` reads goals from the orchestration read model.
- **Correct:** `vp run typecheck` passed across all 15 packages.

### Blocker — shell stream never emits goal updates

Contracts and the web store expect live `goal-upserted` / `goal-removed` events (`packages/contracts/src/orchestration.ts:506-534`, `apps/web/src/store.ts:1860-1863`), but the server stream mapper only handles project/thread events and returns `Option.none()` for non-thread aggregate events in the default case (`apps/server/src/ws.ts:477-520`). As a result, `goal.create`, `goal.task.*`, `goal.archive`, and `goal.delete` update SQLite/projections but do not reach connected clients until a full snapshot/reload.

### Blocker — client-runtime/mobile coverage is incomplete

`packages/client-runtime/src/shellSnapshotReducer.ts:16-42` only applies project/thread shell stream events and returns the original snapshot for all other events, so mobile/shared-runtime consumers ignore the new goal stream variants even if the server emits them. Separately, `packages/client-runtime/src/threadDetailReducer.ts:184-198` applies title/model/branch/worktree changes for `thread.meta-updated` but omits `goalId`, so active thread detail state will not reflect assign/clear goal updates.

### Blocker — project-scoped goal/thread invariant is missing

The migration’s model is project-scoped goals, but `thread.create` only checks that `command.goalId` exists and is not deleted (`apps/server/src/orchestration/decider.ts:430-443`) before storing it on a thread for `command.projectId` (`decider.ts:453-455`). `thread.meta.update` has the same issue (`decider.ts:535-543`, `decider.ts:559-562`). `requireGoalNotDeleted` validates only `deletedAt === null` (`apps/server/src/orchestration/commandInvariants.ts:197-205`) and never compares the goal’s `projectId` with the thread/project. This allows a thread in project A to attach to a goal in project B, breaking the DB-authoritative/project-scoped semantics and goal prompt resolution.

### Blocker — required web task mutation UI is not implemented

The plan’s Phase 4 minimum task UI required add root task, add child, toggle done, rename, and delete. The new panel is explicitly read-only (`apps/web/src/components/GoalTasksPanel.tsx:1-4`) and only renders task state (`GoalTasksPanel.tsx:27-30`). `rg "goal\.task\.(create|update|delete)|type:\s*\"goal\.task" apps/web/src` returned no matches, so the web UI has no task mutation path.

### Major — schema/invariant mismatch for slug reuse after delete

The decider allows slug reuse when the existing goal is deleted because `requireUniqueGoalSlug` filters to `goal.deletedAt === null` (`apps/server/src/orchestration/commandInvariants.ts:223-229`). The SQL projection table still has an unconditional `UNIQUE (project_id, slug)` constraint (`apps/server/src/persistence/Migrations/035_GoalsAndTasks.ts:15-26`). A create command reusing a deleted goal’s slug can pass invariants, append an event, and then fail projection/transaction on the DB uniqueness constraint.

### Major — snapshot sequence can advance without the goal projector

`projection.goals` is registered as a projector (`apps/server/src/orchestration/Layers/ProjectionPipeline.ts:60-63`, `ProjectionPipeline.ts:1643-1645`), but `REQUIRED_SNAPSHOT_PROJECTORS` omits it (`apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:189-197`). Snapshots now include `goals`, so their `snapshotSequence` can claim readiness based on thread/project projectors while the goal projection is stale or failed.

### Major — archived goal semantics are inconsistent

Goal archive/unarchive commands exist, but active shell projection does not hide archived goals: `toGoalShells` filters only `deletedAt === null` (`apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:100-103`). Thread create/meta assignment also accepts archived goals because it uses `requireGoalNotDeleted` only (`decider.ts:441-443`, `decider.ts:541-543`). If archive is part of the public command contract, archived goals remain visible and attachable.

### Major — task reparent can corrupt the read model

`goal.task.update` allows changing `parentTaskId` after only checking that the new parent exists and is not the same task (`apps/server/src/orchestration/decider.ts:373-382`; `apps/server/src/orchestration/commandInvariants.ts:282-294`). It does not reject moving a task under one of its descendants. The tree builder only starts from root parent `""` (`apps/server/src/orchestration/goalTaskTree.ts:42-70`), so such a cycle/orphaned subtree disappears from reads.

### Major — unrelated migration is included in this worktree

`apps/server/src/persistence/Migrations.ts:51` imports and `Migrations.ts:99` registers `036_CanonicalizeReasoningEvents`, and the new file rewrites `thread.message-reasoning` payloads (`apps/server/src/persistence/Migrations/036_CanonicalizeReasoningEvents.ts:7-30`). This is unrelated to the DB goals/tasks migration and should be split out or removed from this diff to avoid collateral data changes.

### Note — validation is not adequate for this blast radius

Changed test files are mostly fixture/schema updates. Static search found no focused tests for goal shell stream events, goal task commands/projections, projection-goal repositories, or the client-runtime goal reducers:

```text
rg -n "goal-upserted|goal-removed|goal\.task|projection_goals|ProjectionGoal|requireGoalParentTask|GoalTask" \
  apps/server/src apps/server/integration packages/client-runtime/src apps/web/src apps/mobile/src \
  -g '*test.ts' -g '*test.tsx' -g '*.integration.ts'
# no matches
```

## Recommendation

**FAIL.** The migration removes the file-backed source and typechecks, but it is not complete: live goal updates do not stream, shared/mobile reducers ignore goal changes, cross-project goal assignment is possible, the required web task mutation UI is missing, and projection/schema invariants have correctness gaps.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "evidence-backed-review",
      "status": "satisfied",
      "evidence": "Findings cite exact file/line evidence for shell streaming, client-runtime reducers, decider invariants, migration constraints, snapshot projector readiness, web task UI absence, and unrelated migration 036. Final recommendation is FAIL."
    }
  ],
  "changedFiles": [
    "packages/contracts/src/{baseSchemas.ts,orchestration.ts,server.ts}",
    "apps/server/src/orchestration/** goal aggregate/task tree/decider/projector/projection changes",
    "apps/server/src/persistence/** migration 035, ProjectionGoals, thread goal_id changes, plus unrelated migration 036",
    "apps/server/src/cli/{goal.ts,orchestrationMutation.ts,project.ts} and apps/server/src/bin.ts",
    "apps/server/src/vcs/http.ts and deletion of apps/server/src/goal/{GoalPackage.ts,GoalsService.ts,http.ts}",
    "apps/web/src store/types/sidebar/chat/goal views and deletion of apps/web/src/goals/goalIndex.tsx",
    "packages/client-runtime/src reducers/state tests",
    "apps/mobile/src fixture tests",
    "goals/pi-frontend docs/plans and progress.md"
  ],
  "testsAddedOrUpdated": [
    "apps/mobile/src/lib/repositoryGroups.test.ts",
    "apps/mobile/src/lib/threadActivity.test.ts",
    "apps/server/integration/OrchestrationEngineHarness.integration.ts",
    "apps/server/src/orchestration/Layers/OrchestrationEngine.test.ts",
    "apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts",
    "apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts",
    "apps/server/src/orchestration/commandInvariants.test.ts",
    "apps/server/src/orchestration/projector.test.ts",
    "apps/server/src/persistence/Layers/ProjectionRepositories.test.ts",
    "apps/server/src/provider/Layers/ProviderSessionReaper.test.ts",
    "apps/server/src/relay/AgentAwarenessRelay.test.ts",
    "apps/server/src/server.test.ts",
    "apps/web/src/components/ChatView.logic.test.ts",
    "apps/web/src/environmentGrouping.test.ts",
    "apps/web/src/environments/runtime/service.threadSubscriptions.test.ts",
    "apps/web/src/store.test.ts",
    "packages/client-runtime/src/*State.test.ts and threadDetailReducer.test.ts"
  ],
  "commandsRun": [
    {
      "command": "git status --short && git diff --stat && git diff --cached --stat",
      "result": "passed",
      "summary": "Reviewed changed/untracked files; no staged diff output."
    },
    {
      "command": "vp run typecheck",
      "result": "passed",
      "summary": "All 15 package typechecks completed with 0 errors."
    },
    {
      "command": "git diff --check && git diff --cached --check",
      "result": "passed",
      "summary": "No whitespace/check errors reported."
    },
    {
      "command": "rg -n 'goalSlug|GoalPackage|GoalsService|goalIndex|/api/goals' apps/*/src packages/*/src",
      "result": "passed",
      "summary": "No source leftovers found."
    },
    {
      "command": "rg -n 'goal-upserted|goal-removed|goal\\.task|projection_goals|ProjectionGoal|requireGoalParentTask|GoalTask' apps/server/src apps/server/integration packages/client-runtime/src apps/web/src apps/mobile/src -g '*test.ts' -g '*test.tsx' -g '*.integration.ts'",
      "result": "passed",
      "summary": "No focused goal/task test coverage found."
    },
    {
      "command": "git diff --cached --name-only | wc -l",
      "result": "passed",
      "summary": "0 staged files."
    }
  ],
  "validationOutput": [
    "typecheck: 0/15 cache hit; all package typechecks passed.",
    "diff check: no whitespace errors.",
    "source cleanup grep: no goalSlug/file-goal route/service leftovers in source.",
    "coverage grep: no focused goal/task tests found for stream events, task commands/projections, ProjectionGoals, or client-runtime goal reducers."
  ],
  "residualRisks": [
    "Did not run vp check because it can apply formatting and this was a no-code-edit review task.",
    "Did not run browser/live-server dogfood validation; findings are from static inspection plus typecheck.",
    "The implementation summary reports focused tests/CLI validation, but the repository diff does not contain focused goal/task assertions matching that claim."
  ],
  "noStagedFiles": true,
  "notes": "Review artifact written to goals/pi-frontend/plans/db-goals-and-tasks-migration.gpt55-review.md. Recommendation: FAIL until blockers are fixed."
}
```
