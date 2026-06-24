# Re-review — DB-authoritative goals/tasks migration after focused fixes

## Review

- Correct: prior must-fix items are implemented in code with the expected DB-authoritative shape.
  - Goal shell stream emission is present. `apps/server/src/ws.ts:475-558` maps project/thread events as before and now maps any `event.aggregateKind === "goal"` through `getGoalShellById`; a found active shell emits `goal-upserted`, while a missing shell emits `goal-removed` (`apps/server/src/ws.ts:520-539`). The query is exposed in the service (`apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts:129-132`) and implemented by assembling goal rows/tasks then filtering through `toGoalShells` (`apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:1923-1945`).
  - Client-runtime reducers now apply goal shell stream events and thread detail `goalId`. `packages/client-runtime/src/shellSnapshotReducer.ts:41-52` handles `goal-upserted` and `goal-removed`; `packages/client-runtime/src/threadDetailReducer.ts:184-199` patches `goalId` on `thread.meta-updated`. Web store already has equivalent handling at `apps/web/src/store.ts:1387-1399` and `apps/web/src/store.ts:1860-1863`.
  - Same-project goal assignment is enforced. `requireActiveGoalInProject` requires an active goal and checks `goal.projectId === input.projectId` (`apps/server/src/orchestration/commandInvariants.ts:239-257`). `thread.create` validates with `command.projectId` (`apps/server/src/orchestration/decider.ts:425-443`); `thread.meta.update` validates with the existing thread's `projectId` (`apps/server/src/orchestration/decider.ts:535-548`). Clearing remains allowed because both guards run only when `command.goalId != null`.
  - Slug uniqueness now matches the DB constraint. The DB has `UNIQUE (project_id, slug)` with no deleted-row predicate (`apps/server/src/persistence/Migrations/035_GoalsAndTasks.ts:14-27`), and the invariant now checks all goals in the project without filtering `deletedAt` (`apps/server/src/orchestration/commandInvariants.ts:259-283`).
  - `projection.goals` participates in snapshot readiness. The projector name is declared at `apps/server/src/orchestration/Layers/ProjectionPipeline.ts:57-63`, added to `REQUIRED_SNAPSHOT_PROJECTORS` at `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:189-198`, and therefore included in `computeSnapshotSequence` readiness (`apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:207-229`).
  - Archive active semantics are coherent. Active shell goals exclude deleted and archived goals (`apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:100-104`), archived shell snapshots intentionally carry `goals: []` (`apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:1789-1799`), task create/update/delete all require `requireGoalActive` (`apps/server/src/orchestration/decider.ts:340-345`, `apps/server/src/orchestration/decider.ts:376-384`, `apps/server/src/orchestration/decider.ts:405-411`), and assignment uses the same active check through `requireActiveGoalInProject`.
  - Task reparenting is disallowed on update. The contract comment and schema omit `parentTaskId` from `GoalTaskUpdateCommand` (`packages/contracts/src/orchestration.ts:806-816`); the decider explicitly documents no reparent path and emits only text/done/position changes (`apps/server/src/orchestration/decider.ts:376-401`); the in-memory projector updates only text/done/position (`apps/server/src/orchestration/projector.ts:404-420`); and the SQL projector preserves the existing `parentTaskId` by spreading the existing task and patching only text/done/position/updatedAt (`apps/server/src/orchestration/Layers/ProjectionPipeline.ts:638-650`).
  - Migration 036 is documented as an enabling dogfood fix, not silent collateral. The header explains legacy `reasoningDelta` rows blocked dogfood startup and references the author-session consult (`apps/server/src/persistence/Migrations/036_CanonicalizeReasoningEvents.ts:1-8`).
  - Web inline task editing remains intentionally deferred and is not a blocker. `GoalTasksPanel` is explicitly read-only and points at `t3 goal task ...` as the mutation path (`apps/web/src/components/GoalTasksPanel.tsx:1-5`); the CLI exposes task add/done/open/rename/delete mutations (`apps/server/src/cli/goal.ts:245-356`); and the agent prompt instructs agents to keep task lists current via those CLI commands (`apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:107-121`).
  - Focused validation passed: typecheck passed, client-runtime reducer tests passed, server projector/snapshot/invariant/engine tests passed, web store tests passed, and `git diff --check` passed.

- Blocker: `vp check` does not pass, so I cannot recommend final completion/merge under this repo's gate.
  - Command output: `./node_modules/.bin/vp check` failed with formatting issues in `goals/pi-frontend/plans/db-goals-and-tasks-migration.fix-implementation.md`, `goals/pi-frontend/plans/db-goals-and-tasks-migration.gpt55-review.md`, `goals/pi-frontend/plans/db-goals-and-tasks-migration.implementation.md`, and `progress.md`.
  - Recommendation: **FAIL for completion until formatting is fixed and `vp check` passes**. After that, the prior must-fix implementation itself is a pass.

- Note: `plan.md` requested by the task does not exist at `/home/Carl/pi-frontend/plan.md`; `progress.md` and the fix plan were read.
- Note: `vp` is not on PATH in this shell; I used `./node_modules/.bin/vp` for validation.
- Note: No staged files were present (`git diff --cached --name-only | wc -l` returned `0`).
- Note: Tests in the diff are mostly fixture/interface updates for the new goal shape; the focused tests still passed, but I did not find explicit new negative tests for cross-project goal assignment, archived-goal task mutation, or goal shell stream emission.

## Changed files reviewed

Tracked changes from `git diff --stat`: 68 files changed, 1813 insertions, 1330 deletions. Untracked implementation/docs files include the new goal CLI, orchestration mutation helper, goal task tree helper, ProjectionGoals repository/service, migrations 035/036, VCS HTTP relocation, web goal state, and DB goals migration plan/review docs.

## Commands run / validation output

- `git status --short && git branch --show-current` — passed; branch `throwaway-pi-frontend`; many unstaged tracked changes plus untracked implementation/docs.
- `git diff --cached --name-only | wc -l` — passed; output `0`.
- `git diff --check` — passed; no whitespace errors.
- `./node_modules/.bin/vp run typecheck` — passed; 15/15 packages, 0 errors.
- `./node_modules/.bin/vp check` — failed; formatting issues in 4 markdown/progress files listed above.
- `cd packages/client-runtime && ../../node_modules/.bin/vp test run src/shellSnapshotReducer.test.ts src/threadDetailReducer.test.ts` — passed; 2 files, 31 tests.
- `cd apps/server && ../../node_modules/.bin/vp test run src/orchestration/projector.test.ts src/orchestration/Layers/ProjectionSnapshotQuery.test.ts` — passed; 2 files, 19 tests.
- `cd apps/server && ../../node_modules/.bin/vp test run src/orchestration/commandInvariants.test.ts src/orchestration/Layers/OrchestrationEngine.test.ts` — passed; 2 files, 17 tests.
- `cd apps/web && ../../node_modules/.bin/vp test run --project unit src/store.test.ts` — passed; 1 file, 17 tests.

## Final recommendation

**Fail for completion due the `vp check` formatting failure.** The focused DB-authoritative goals/tasks must-fix items are otherwise verified as implemented.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "evidence-backed-rereview",
      "status": "satisfied",
      "evidence": "Reviewed the fix plan, progress.md, git diff/status, and cited exact code lines for all prior must-fix items; final recommendation is fail-for-completion only because vp check fails."
    }
  ],
  "changedFiles": [
    "M apps/mobile/src/lib/repositoryGroups.test.ts",
    "M apps/mobile/src/lib/threadActivity.test.ts",
    "M apps/server/integration/OrchestrationEngineHarness.integration.ts",
    "M apps/server/src/bin.ts",
    "M apps/server/src/checkpointing/Layers/CheckpointDiffQuery.test.ts",
    "M apps/server/src/cli/project.ts",
    "D apps/server/src/goal/GoalPackage.ts",
    "D apps/server/src/goal/GoalsService.ts",
    "D apps/server/src/goal/http.ts",
    "M apps/server/src/orchestration/Layers/OrchestrationEngine.test.ts",
    "M apps/server/src/orchestration/Layers/OrchestrationEngine.ts",
    "M apps/server/src/orchestration/Layers/ProjectionPipeline.ts",
    "M apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts",
    "M apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts",
    "M apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts",
    "M apps/server/src/orchestration/Layers/ProviderCommandReactor.ts",
    "M apps/server/src/orchestration/Schemas.ts",
    "M apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts",
    "M apps/server/src/orchestration/commandInvariants.test.ts",
    "M apps/server/src/orchestration/commandInvariants.ts",
    "M apps/server/src/orchestration/decider.ts",
    "M apps/server/src/orchestration/projector.test.ts",
    "M apps/server/src/orchestration/projector.ts",
    "M apps/server/src/persistence/Layers/OrchestrationEventStore.ts",
    "M apps/server/src/persistence/Layers/ProjectionRepositories.test.ts",
    "M apps/server/src/persistence/Layers/ProjectionThreads.ts",
    "M apps/server/src/persistence/Migrations.ts",
    "M apps/server/src/persistence/Services/OrchestrationCommandReceipts.ts",
    "M apps/server/src/persistence/Services/ProjectionThreads.ts",
    "M apps/server/src/project/Layers/ProjectSetupScriptRunner.test.ts",
    "M apps/server/src/provider/Layers/ProviderSessionReaper.test.ts",
    "M apps/server/src/relay/AgentAwarenessRelay.test.ts",
    "M apps/server/src/server.test.ts",
    "M apps/server/src/server.ts",
    "M apps/server/src/serverRuntimeStartup.test.ts",
    "M apps/server/src/ws.ts",
    "M apps/web/src/components/ChatView.browser.tsx",
    "M apps/web/src/components/ChatView.logic.test.ts",
    "M apps/web/src/components/ChatView.logic.ts",
    "M apps/web/src/components/ChatView.tsx",
    "M apps/web/src/components/DiffPanel.tsx",
    "M apps/web/src/components/GoalTasksPanel.tsx",
    "M apps/web/src/components/KeybindingsToast.browser.tsx",
    "M apps/web/src/components/Sidebar.tsx",
    "M apps/web/src/components/chat/ChatHeader.tsx",
    "M apps/web/src/composerDraftStore.ts",
    "M apps/web/src/environmentGrouping.test.ts",
    "M apps/web/src/environments/runtime/service.threadSubscriptions.test.ts",
    "D apps/web/src/goals/goalIndex.tsx",
    "M apps/web/src/hooks/useHandleNewThread.ts",
    "M apps/web/src/lib/utils.ts",
    "M apps/web/src/routes/_chat.index.tsx",
    "M apps/web/src/store.test.ts",
    "M apps/web/src/store.ts",
    "M apps/web/src/types.ts",
    "M goals/pi-frontend/goal.md",
    "M goals/pi-frontend/plans/goal-index-ws-push.md",
    "M packages/client-runtime/src/archivedThreadsState.test.ts",
    "M packages/client-runtime/src/shellSnapshotReducer.test.ts",
    "M packages/client-runtime/src/shellSnapshotReducer.ts",
    "M packages/client-runtime/src/shellSnapshotState.test.ts",
    "M packages/client-runtime/src/threadDetailReducer.test.ts",
    "M packages/client-runtime/src/threadDetailReducer.ts",
    "M packages/client-runtime/src/threadDetailState.test.ts",
    "M packages/contracts/src/baseSchemas.ts",
    "M packages/contracts/src/orchestration.ts",
    "M packages/contracts/src/server.ts",
    "M progress.md",
    "?? apps/server/src/cli/goal.ts",
    "?? apps/server/src/cli/orchestrationMutation.ts",
    "?? apps/server/src/orchestration/goalTaskTree.ts",
    "?? apps/server/src/persistence/Layers/ProjectionGoals.ts",
    "?? apps/server/src/persistence/Migrations/035_GoalsAndTasks.ts",
    "?? apps/server/src/persistence/Migrations/036_CanonicalizeReasoningEvents.ts",
    "?? apps/server/src/persistence/Services/ProjectionGoals.ts",
    "?? apps/server/src/vcs/http.ts",
    "?? apps/web/src/goals/goalState.tsx",
    "?? goals/pi-frontend/plans/db-goals-and-tasks-migration.fix-implementation.md",
    "?? goals/pi-frontend/plans/db-goals-and-tasks-migration.gpt55-review.md",
    "?? goals/pi-frontend/plans/db-goals-and-tasks-migration.implementation.md",
    "?? goals/pi-frontend/plans/db-goals-and-tasks-migration.md",
    "?? goals/pi-frontend/plans/db-goals-and-tasks-migration.review.md"
  ],
  "testsAddedOrUpdated": [
    "apps/server/src/orchestration/Layers/OrchestrationEngine.test.ts",
    "apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts",
    "apps/server/src/orchestration/commandInvariants.test.ts",
    "apps/server/src/orchestration/projector.test.ts",
    "apps/web/src/store.test.ts",
    "packages/client-runtime/src/shellSnapshotReducer.test.ts",
    "packages/client-runtime/src/threadDetailReducer.test.ts",
    "plus multiple fixture updates in mobile/client-runtime tests for goalId/goals shape"
  ],
  "commandsRun": [
    {
      "command": "git status --short && git branch --show-current",
      "result": "passed",
      "summary": "Listed unstaged/untracked changes; branch throwaway-pi-frontend."
    },
    {
      "command": "git diff --cached --name-only | wc -l",
      "result": "passed",
      "summary": "0 staged files."
    },
    {
      "command": "git diff --check",
      "result": "passed",
      "summary": "No whitespace errors."
    },
    {
      "command": "./node_modules/.bin/vp run typecheck",
      "result": "passed",
      "summary": "15/15 packages typechecked successfully."
    },
    {
      "command": "./node_modules/.bin/vp check",
      "result": "failed",
      "summary": "Formatting issues found in four markdown/progress files."
    },
    {
      "command": "cd packages/client-runtime && ../../node_modules/.bin/vp test run src/shellSnapshotReducer.test.ts src/threadDetailReducer.test.ts",
      "result": "passed",
      "summary": "2 test files, 31 tests passed."
    },
    {
      "command": "cd apps/server && ../../node_modules/.bin/vp test run src/orchestration/projector.test.ts src/orchestration/Layers/ProjectionSnapshotQuery.test.ts",
      "result": "passed",
      "summary": "2 test files, 19 tests passed."
    },
    {
      "command": "cd apps/server && ../../node_modules/.bin/vp test run src/orchestration/commandInvariants.test.ts src/orchestration/Layers/OrchestrationEngine.test.ts",
      "result": "passed",
      "summary": "2 test files, 17 tests passed."
    },
    {
      "command": "cd apps/web && ../../node_modules/.bin/vp test run --project unit src/store.test.ts",
      "result": "passed",
      "summary": "1 test file, 17 tests passed."
    }
  ],
  "validationOutput": [
    "typecheck passed: vp run reported 0/15 cache hit and no errors",
    "vp check failed: Formatting issues found in goals/pi-frontend/plans/db-goals-and-tasks-migration.fix-implementation.md, goals/pi-frontend/plans/db-goals-and-tasks-migration.gpt55-review.md, goals/pi-frontend/plans/db-goals-and-tasks-migration.implementation.md, progress.md",
    "focused tests passed: client-runtime 31, server 19+17, web 17",
    "git diff --check produced no output"
  ],
  "residualRisks": [
    "Completion remains blocked until vp check formatting issues are fixed.",
    "I did not find explicit new negative tests for cross-project goal assignment, archived-goal task mutation rejection, or live goal shell stream emission; implementation was verified by code inspection and focused existing tests.",
    "No live browser/server dogfood run was performed in this rereview."
  ],
  "noStagedFiles": true,
  "notes": "plan.md was missing; progress.md and the fix plan were read. Web inline task editing is intentionally deferred because CLI/agent task mutation exists."
}
```
