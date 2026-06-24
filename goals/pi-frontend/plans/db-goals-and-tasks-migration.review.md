# Review — DB-authoritative goals and tasks migration plan

Reviewed: `goals/pi-frontend/plans/db-goals-and-tasks-migration.md`
Scope: correctness, completeness, sequencing, T3 worktree semantics, blast radius, missing consumers, over/under-engineering.
Method: cross-checked every claim against the live codebase (contracts, decider, projectors, persistence, server/CLI, web, client-runtime, mobile).

Verdict: **Implementation-ready after two revisions.** One blocker (the `/api/goals/diff` route is not goal-file code and would be deleted with `http.ts`) and one completeness gap (blast-radius file list omits `packages/client-runtime` + mobile + test/layer wiring sites). Everything else is accurate, correctly sequenced, and appropriately scoped for a prototype.

## Review

### Blocker

- **Deleting `apps/server/src/goal/http.ts` wholesale removes the git-diff endpoint the UI depends on.** `http.ts` hosts `GET /api/goals/diff` (`apps/server/src/goal/http.ts:51`), which runs `git diff --no-ext-diff --no-color` for an arbitrary `cwd` and has **nothing to do with the file-goal model**. It is consumed by the diff viewer at `apps/web/src/components/DiffPanel.tsx:155` and documented at `progress.md:159`. The plan's "File-centric code deletion" and Phase 6 both say "Delete … `apps/server/src/goal/http.ts`" with no carve-out. Acting on that literally breaks the Diff panel.
  - Fix: before deleting `http.ts`, relocate `/api/goals/diff` to a non-goal HTTP module (e.g. a `vcs`/`diff` route layer) and repoint `DiffPanel.tsx`. Add this as an explicit step in Phase 3/Phase 6. (Note: `POST`/`GET /api/goals` are correctly identified for removal — only the `diff` sibling is collateral.)

### Blocker-adjacent (completeness gap that will fail typecheck)

- **Blast-radius file list omits the shared `packages/client-runtime` reducers and mobile.** AGENTS.md states client-runtime is "Shared runtime package for sharing client code across web and mobile," yet the plan's "Web/client migration" lists only `apps/web/*`. Live `goalSlug` consumers outside that list:
  - `packages/client-runtime/src/threadDetailReducer.ts:144` — actively maps `event.payload.goalSlug` (real logic, not a fixture).
  - `packages/client-runtime/src/{shellSnapshotState,threadDetailState,shellSnapshotReducer,threadDetailReducer}.test.ts` — fixtures.
  - `apps/mobile/src/lib/{repositoryGroups,threadActivity}.test.ts` — fixtures.
  - Per AGENTS.md, `vp run lint:mobile` is also required when native mobile code changes. The plan's Phase 7 lists `vp check`/`vp run typecheck` but not `lint:mobile`.
  - Fix: add `packages/client-runtime/**` and `apps/mobile/**` to the Phase 4 cutover list; the plan's own "do not half-migrate" rule applies.

### Note — under-specified but feasible

- **The agent CLI needs a new generalized dispatch path, not just "reuse project CLI patterns."** The plan says reuse `bin.ts`/project-CLI routing. That pattern is solid and worth reusing — `runProjectMutation` (`apps/server/src/cli/project.ts`) already resolves a running server and dispatches live, falling back to an offline in-process `OrchestrationEngine` write. **But** it is hard-restricted to project commands via `ProjectCliDispatchCommand = Extract<…, { type: "project.create" | "project.meta.update" | "project.delete" }>`. A `t3 goal …` surface must build a parallel (or generalized) dispatch type + handler. Budget for that; it is more than wiring a subcommand into `bin.ts` (which currently registers only `start/serve/auth/project/connect`).
- **Agent ergonomics depends on the CLI preferring the _live_ server.** The live/offline split has a 1s timeout (`PROJECT_CLI_LIVE_SERVER_TIMEOUT`) and silently falls back to direct SQLite writes if the running server doesn't answer. In dogfood the running server is the one spawning pi, so the live path should win — but if it falls back offline, the server's in-memory projections and shell stream won't reflect pi's task toggles until restart. This is exactly the "agent ergonomics regression" risk the plan flags; make "goal CLI must dispatch to the live server when present" an explicit requirement, not an accident of timeout behaviour.
- **Removing `GoalsService` touches several layer/test wiring sites the deletion list doesn't name.** Beyond the source files, `GoalsService` is constructed/mocked at `apps/server/src/server.ts:290` (`ProviderRuntimeLayerLive`), `:364`, `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:204`, and mocked in `server.test.ts:711`, `ProviderCommandReactor.test.ts:352`, `integration/OrchestrationEngineHarness.integration.ts:385`. Call these out so the layer graph compiles after removal.
- **Guard against over-deleting `worktreePath`/`branch` on threads.** The deletion list correctly scopes "delete `worktreePath`, `branch`, `packagePath`" to _goal index entries_, but those fields are legitimate, load-bearing columns on threads (execution context — `OrchestrationThread`/`OrchestrationThreadShell` at `packages/contracts/src/orchestration.ts:359-360,400-401`). The Phase 6 verification grep `worktreePath.*goal` is appropriately narrow, but flag explicitly that thread `worktreePath`/`branch` must survive, to prevent an implementer from over-deleting.

### Correct (verified against code)

- **Contract field enumeration is accurate.** `goalSlug` lives exactly where the plan says: `OrchestrationThread` (`orchestration.ts:352`), `OrchestrationThreadShell` (`:399`), thread create/meta commands (`:505,:543`), thread created/meta payloads (`:564`), and the turn-start bootstrap (`:868,:903`). Replacing all with `goalId` is the right single-field swap.
- **Aggregate-kind change is correct.** `OrchestrationAggregateKind = Schema.Literals(["project", "thread"])` (`orchestration.ts:835`) and `aggregateId: Schema.Union([ProjectId, ThreadId])` (`:1035`) — adding `"goal"` + `GoalId` is the minimal correct extension. Putting all task events on the goal aggregate stream (keeping tree/order invariants local) is the right call.
- **Shell-stream extension fits cleanly.** `OrchestrationShellStreamEvent` is a 4-variant union (`orchestration.ts:428-450`); adding `goal-upserted`/`goal-removed` mirrors the existing `project-*`/`thread-*` pattern, and a top-level `goals` array on `OrchestrationShellSnapshot`/`OrchestrationReadModel` parallels `projects`/`threads`. Architecturally consistent.
- **`project.delete` cascade analysis is right.** `decider.ts:163-206` currently cascades active threads → `thread.delete` then re-issues `project.delete` with force. Goals must be added to that cascade exactly as the plan states.
- **The file-centric pain point is real.** `GoalsService.rescan` scans _every_ worktree (`discoverGoals` → `listWorktrees`) and carries an explicit `dedupeBySlug` HACK with a CPU-spin comment (`GoalsService.ts:53-70,113-126`) because one semantic goal appears N times across worktrees. The migration's core justification is grounded in actual code, not speculation.
- **System-prompt replacement target is accurate.** `buildGoalSystemPrompt` (`ProviderCommandReactor.ts:357-370`) calls `goalsService.rescan()` and resolves a `goals/<slug>/goal.md` path; Phase 5's swap to DB state + CLI instructions is correctly aimed.
- **Synthetic "missing goal" fallbacks can be dropped.** `GoalTasksPanel.tsx:16` and `ChatHeader.tsx:67` render "Missing goal package" states tied to the file index; with DB invariants these become dead UX, as the plan says.

### Note — sound design choices (not problems)

- Scope discipline is good: deferring `goal.task.reorder` and drag/drop, append-at-end positioning, exclude-deleted-from-reads instead of cascading soft-deletes, and nested-tree assembly in `ProjectionSnapshotQuery` (consistent with how it already assembles nested snapshots). This matches the prototype/minimal-surface posture and the "no backwards compatibility / no compat shim" rule.
- The "no coexistence period / delete the importer after cutover" stance is consistent with project rules; the one-time throwaway importer is correctly marked non-runtime.
- Phase 0 correctly leaves the dogfood-data decision (reset vs one-time import) open rather than baking in a shim. Existing migration `033_ProjectionThreadsGoalSlug` added `goal_slug` additively with PRAGMA guards; an additive `goal_id` column + ignoring `goal_slug` fits the established migration style, and a clean reset is acceptable for the prototype.
- Vertical migration order (contracts → in-memory projector → SQL → server/WS/store → web → agent CLI → delete) is correct: letting typecheck surface every `goalSlug` consumer is the safest discovery mechanism given the wide blast radius.

## Recommendation

Proceed. Before implementation, amend the plan to: (1) relocate `/api/goals/diff` out of `goal/http.ts` and repoint `DiffPanel.tsx` (blocker); (2) add `packages/client-runtime/**`, `apps/mobile/**`, and the `GoalsService`/`ProviderCommandReactor` layer+test wiring sites to the cutover/deletion lists, and add `vp run lint:mobile` to Phase 7. With those, the plan is correct, well-sequenced, and right-sized.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Review-only task. Wrote findings to the configured artifact (db-goals-and-tasks-migration.review.md); no project/source files edited."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Each finding cites concrete file:line evidence (e.g. goal/http.ts:51 + DiffPanel.tsx:155 for the diff-route blocker; threadDetailReducer.ts:144 for the client-runtime gap; cli/project.ts ProjectCliDispatchCommand for CLI scope; decider.ts:163-206 for cascade; orchestration.ts:352-903,835,1035,428-450 for contract accuracy)."
    }
  ],
  "changedFiles": [
    "goals/pi-frontend/plans/db-goals-and-tasks-migration.review.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [],
  "validationOutput": [
    "Verified goalSlug consumers via grep across *.ts/*.tsx: contracts, decider, projector, ProjectionPipeline, ProjectionSnapshotQuery, ws.ts, web store/composer/ChatView/Sidebar, client-runtime threadDetailReducer.ts:144, mobile fixtures.",
    "Verified /api/goals/diff defined in goal/http.ts:51 and consumed only by DiffPanel.tsx:155.",
    "Verified OrchestrationAggregateKind = [project, thread] at orchestration.ts:835 and shell stream union at :428-450.",
    "Verified project.delete cascade at decider.ts:163-206 and CLI live/offline dispatch restricted to project.* at cli/project.ts."
  ],
  "residualRisks": [
    "Did not run vp check / typecheck (review-only, no edits to source). Blast-radius completeness claims are from static grep, not a compile.",
    "Agent CLI live-vs-offline dispatch behaviour inferred from project.ts; runtime confirmation that goal CLI reaches the running server during dogfood is left to implementation."
  ],
  "noStagedFiles": true,
  "notes": "Verdict: implementation-ready after two revisions (relocate /api/goals/diff before deleting goal/http.ts; add client-runtime + mobile + GoalsService layer/test wiring to the cutover lists, plus vp run lint:mobile in Phase 7). Plan's contract/decider/aggregate/shell-stream claims all verified accurate; scope is appropriately minimal for a prototype."
}
```
