# Progress — DB-authoritative goals & tasks migration

Status: COMPLETE — all phases done; typecheck + lint:mobile pass; goal CLI round-trip validated. vp check has only pre-existing lint debt (untouched ProviderRuntimeIngestion.test.ts).

## Plan phases

- [x] Phase 1: Contracts + decider + invariants + in-memory projector + goalTaskTree helper.
- [x] Phase 2: SQL migration 035, ProjectionGoals repo, ProjectionPipeline goals projector, ProjectionSnapshotQuery goal assembly.
- [x] Phase 3: vcs/http.ts (/api/vcs/diff relocated), removed GoalsService/GoalPackage/goal http, server wiring updated.
- [x] Phase 5 (server side): goal CLI (cli/goal.ts + shared orchestrationMutation.ts), buildGoalSystemPrompt rewritten to DB+CLI.
- Server package `tsgo --noEmit` PASSES (incl tests).
- [ ] Phase 2: SQL projections + snapshot query
- [ ] Phase 3: Server API/WS/store integration + relocate /api/goals/diff
- [x] Phase 4: Web cutover — store goals slice + selectors, types goalId, Sidebar/ChatHeader/GoalTasksPanel/\_chat.index use store goals, goalIndex.tsx removed, DiffPanel -> /api/vcs/diff, client-runtime reducer + mobile fixtures.
- [x] Phase 5: goal CLI + DB-state system prompt.
- [x] Phase 6: deleted GoalsService/GoalPackage/goal http; marked goal-index-ws-push.md superseded + goal.md non-authoritative.
- [x] Phase 7: vp run typecheck PASS (15 pkgs); vp run lint:mobile PASS; focused unit tests PASS (38); goal CLI real-DB round trip PASS; vp check fmt applied (only pre-existing lint error remains).

## Notes / findings

## Notes / findings

- Consulted author session `/home/Carl/.pi/agent/sessions/--home-Carl-pi-frontend--/2026-06-23T12-55-13-430Z_019ef48c-9116-7f8f-b240-e6d7727121f2.jsonl` about `036_CanonicalizeReasoningEvents.ts` after reviewer flagged it as unrelated. Confidence: medium. Guidance: keep migration 036 in this branch as an explicitly documented enabling runtime-data fix because it restored dogfood startup after a reasoning-event decode failure; escalate only if strict feature isolation is required.

## Review fixes (gpt55-review.md)

All must-fix issues addressed (see
`plans/db-goals-and-tasks-migration.fix-implementation.md`):

- [x] 1. Shell stream emits goal-upserted/goal-removed for goal/task events
     (ws.ts `toShellStreamEvent` goal branch + new `getGoalShellById`).
- [x] 2. client-runtime `shellSnapshotReducer` handles goal-upserted/goal-removed;
     `threadDetailReducer` applies `goalId` on thread.meta-updated. (web store
     already handled both.)
- [x] 3. Project-scoped goal assignment: thread.create/meta.update use
     `requireActiveGoalInProject` (active + same project); clearing goalId still ok.
- [x] 4. Slug uniqueness matches DB constraint: deleted goals still reserve
     slugs (`requireUniqueGoalSlug` no longer filters deletedAt).
- [x] 5. `projection.goals` added to REQUIRED_SNAPSHOT_PROJECTORS.
- [x] 6. Archive coherence: `toGoalShells` excludes archived; task mutations and
     goal assignment require active goal (`requireGoalActive`).
- [x] 7. Task reparent disallowed for MVP: `parentTaskId` removed from
     goal.task.update command/payload + decider/projector/projection; create still
     sets parentTaskId.
- [x] 8. Migration 036 documented in-file as an enabling dogfood runtime-data fix.

Validation: `vp run typecheck` PASS (15/15); focused tests PASS (server
orchestration 36, ProjectionRepositories 2, client-runtime 188/189 — the 1
failure is pre-existing default-model drift in addProject.test, unrelated; web
store 17). `vp lint` clean except the pre-existing
ProviderRuntimeIngestion.test error.

## Open decisions / escalations
