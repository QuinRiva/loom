---
manager_sessions:
  - id: 94da13f3-6481-4aee-9f7a-4e563f867f27
    role: plan
    authored_at: 2026-06-23T06:04:49.104Z
---

# Plan — DB-authoritative goals and tasks

## Decision

Move both goals and task/todo trees out of `goals/<slug>/goal.md` files and into T3 Code's orchestration/event-sourced state. Files stop being a source of truth. There is no coexistence period, no file-sync shim, and no backward-compatibility layer for the file-centric model.

The resulting model is:

```text
Project
  Goal                         DB identity, project-scoped
    Task tree                  DB identity, ordered nested checklist
    Thread                     references goalId; may run in project root or any worktree
      worktreePath / branch    execution context only
```

Native worktrees remain first-class as thread execution contexts. They are not goal namespaces and do not duplicate goals or tasks.

## Why

The file-centric MVP was useful because pi can read and edit Markdown directly, but it conflicts with native worktree semantics: tracked `goals/<slug>/goal.md` files appear in every git worktree, so file discovery treats one semantic goal as several filesystem occurrences. The UI then duplicates goal rows and any slug-only lookup can attach a thread/prompt to the wrong worktree occurrence.

DB-authoritative goals give stable identity, predictable UI state, and a contract that matches existing T3 architecture: projects, threads, sessions, and projections are already orchestration state; worktrees are metadata on threads.

## Non-goals

- No ongoing Markdown sync.
- No compatibility with `goals/<slug>/goal.md` as a source of truth.
- No duplicate output shape that preserves old file-backed `GoalIndexEntry` semantics.
- No branch/worktree-scoped goal variants in this migration.
- No multi-user collaborative editing semantics beyond the existing single-user prototype assumptions.

A one-time manual/import script may be used during development to preserve the current dogfood goal, but it must be deleted or clearly marked as throwaway after the cutover. It is not a runtime feature.

## Target data model

### Contracts

Add stable goal/task identities, preferably in `packages/contracts/src/baseSchemas.ts` or near the orchestration schemas:

- `GoalId`
- `GoalTaskId`

Add read-model shapes:

```ts
OrchestrationGoalTask = {
  id: GoalTaskId;
  goalId: GoalId;
  parentTaskId: GoalTaskId | null;
  text: string;
  done: boolean;
  position: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  deletedAt: IsoDateTime | null;
  children: OrchestrationGoalTask[]; // read model / shell view only
}

OrchestrationGoal = {
  id: GoalId;
  projectId: ProjectId;
  slug: string;
  title: string;
  description: string;
  tasks: OrchestrationGoalTask[];
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  archivedAt: IsoDateTime | null;
  deletedAt: IsoDateTime | null;
}
```

Use `goalId` on threads, not `goalSlug`:

- `OrchestrationThread.goalId: GoalId | null`
- `ThreadCreateCommand.goalId?: GoalId | null`
- `ThreadMetaUpdateCommand.goalId?: GoalId | null`
- `ThreadCreatedPayload.goalId?: GoalId | null`
- `ThreadMetaUpdatedPayload.goalId?: GoalId | null`
- `ThreadTurnStartBootstrapCreateThread.goalId?: GoalId | null`

Delete `goalSlug` from thread contracts rather than carrying both.

### Commands

Add goal commands to `DispatchableClientOrchestrationCommand`:

- `goal.create`
  - `goalId`, `projectId`, `slug`, `title`, `description`, `createdAt`
- `goal.meta.update`
  - `goalId`, optional `slug`, `title`, `description`
- `goal.archive`
- `goal.unarchive`
- `goal.delete`
- `goal.task.create`
  - `goalId`, `taskId`, `parentTaskId`, `text`, optional `position`, `createdAt`
- `goal.task.update`
  - `goalId`, `taskId`, optional `text`, `done`, `parentTaskId`, `position`
- `goal.task.delete`
  - soft-delete one task subtree or just one task; choose subtree delete for simpler UI semantics
- Optional only if needed after first implementation: `goal.task.reorder` as a narrower command. Otherwise `goal.task.update` with `parentTaskId` + `position` is enough.

### Events

Add event types:

- `goal.created`
- `goal.meta-updated`
- `goal.archived`
- `goal.unarchived`
- `goal.deleted`
- `goal.task-created`
- `goal.task-updated`
- `goal.task-deleted`

Extend:

- `OrchestrationAggregateKind`: `"project" | "goal" | "thread"`
- event `aggregateId` union to include `GoalId`

All task events can live on the goal aggregate stream (`aggregateKind: "goal"`, `aggregateId: goalId`) rather than making every task its own aggregate. That keeps task ordering/tree invariants local to one goal.

## Persistence/projections

### Migrations

Replace the current file-centric migration comment/model. Add projection tables:

```sql
projection_goals (
  goal_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  deleted_at TEXT,
  UNIQUE(project_id, slug)
)

projection_goal_tasks (
  task_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  parent_task_id TEXT,
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  done INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY(goal_id) REFERENCES projection_goals(goal_id)
)
```

Change `projection_threads`:

- drop/ignore `goal_slug`
- add `goal_id TEXT`

Because this is a prototype, prefer a clean migration over compatibility logic. If local DB reset is acceptable for dogfooding, do that and simplify. If preserving the current dogfood data matters, run a one-time throwaway importer that parses the existing files and dispatches normal `goal.*` commands, then remove it.

### Repositories/layers

Add:

- `ProjectionGoals` service/layer
- `ProjectionGoalTasks` service/layer, or one combined repository if that is smaller

Expected methods:

- goals: `upsert`, `getById`, `listByProjectId`, `listActive`, `deleteById`
- tasks: `upsert`, `listByGoalId`, `deleteByGoalId`, `deleteByTaskId`

Keep task-tree assembly in `ProjectionSnapshotQuery`, not in SQL rows.

### Projection pipeline

Add projectors for goal and task events in both projection paths:

- `apps/server/src/orchestration/projector.ts` for in-memory/test read model
- `apps/server/src/orchestration/Layers/ProjectionPipeline.ts` for SQL projections

Goal deletion should mark goal deleted and either:

- soft-delete all tasks in the same projection step, or
- leave task rows but exclude them from active goal reads.

Pick the smaller implementation; reads excluding deleted goals/tasks is enough.

## Decider and invariants

Add invariants in `apps/server/src/orchestration/commandInvariants.ts`:

- `requireGoal`
- `requireGoalAbsent`
- `requireGoalNotDeleted`
- `requireGoalTask`
- `requireGoalTaskAbsent`
- `requireGoalTaskInGoal`
- `requireUniqueGoalSlug(projectId, slug)`
- parent task, when present, must belong to same goal and not be deleted

Update thread commands:

- `thread.create` with non-null `goalId` must require active goal.
- `thread.meta.update` with non-null `goalId` must require active goal.
- `project.delete force=true` should delete/archive goals for that project as part of the command sequence, or reject unless forced. Since project delete is not the active path, simplest is force cascades through active threads and active goals.

Ordering rules:

- `position` is numeric and scoped to siblings (`goalId + parentTaskId`).
- First implementation can append at end if position omitted.
- Reordering can be normalized by sorting `(position, createdAt, taskId)`; no need for complex gap management until UI drag/drop exists.

## Read model and WebSocket stream

Reintegrate goals into orchestration state instead of a side HTTP service:

- `OrchestrationReadModel.goals: OrchestrationGoal[]`
- `OrchestrationShellSnapshot.goals: OrchestrationGoalShell[]`
- `OrchestrationShellStreamEvent` gains:
  - `goal-upserted`
  - `goal-removed`

`ProjectionSnapshotQuery.getShellSnapshot()` should return active goals with nested active tasks. Small personal scale makes full goal/task payloads acceptable.

Delete or repurpose `/api/goals`:

- Remove the file-backed `GET /api/goals` and `POST /api/goals` goal routes as runtime sources of truth.
- Remove `GoalsService` and `GoalPackage` from runtime.
- Do **not** delete the existing diff capability by accident: `apps/server/src/goal/http.ts` also owns `GET /api/goals/diff`, which is a generic git diff route consumed by `DiffPanel`. Before deleting `goal/http.ts`, move that route to a non-goal module such as a VCS/diff HTTP route and repoint the client.
- If keeping a goal HTTP endpoint temporarily for developer inspection, make it DB-backed and do not preserve file-centric fields like `worktreePath`, `branch`, or `packagePath`.

## Web/client migration

### Store/types

Replace `goalSlug` everywhere with `goalId`:

- `apps/web/src/types.ts`
- `apps/web/src/store.ts`
- `composerDraftStore.ts`
- `useHandleNewThread.ts`
- `ChatView.logic.ts`
- `ChatView.browser.tsx`
- `packages/client-runtime/**` reducers/state/tests
- `apps/mobile/**` fixtures or shared-runtime consumers
- tests/fixtures across apps and packages

Add goals/tasks to the web store from the orchestration shell stream. Do not fetch `/api/goals` with React Query as the canonical source.

Delete:

- `apps/web/src/goals/goalIndex.tsx` as a polling/file-index client
- `GoalIndexEntry` fields tied to files/worktrees
- duplicate query ownership in `Sidebar.tsx`

Replace with selectors:

- `goalsByProjectId`
- `goalById`
- `tasksByGoalId` or nested tasks on goal
- `threadsByGoalId`

### Sidebar

Render:

```text
Project
  Goal title        done/total
    Thread
  No-goal threads
```

Key rows by `goal.id`, not `slug`. Collapse state should use `goalId`.

Synthetic missing goal rows should only exist for corrupted local state. With DB invariants, ordinary assignment cannot point at a missing goal. Keep a tiny fallback if useful, but it should not be part of normal UX.

### Goal/task UI

Update:

- home goal overview
- chat header goal section
- `GoalTasksPanel`
- create-goal-from-thread
- assign/clear goal menus
- new-session-under-goal button

Create/edit task actions should dispatch orchestration commands, not edit files.

Minimum viable task UI:

- add root task
- add child task
- toggle done
- rename task
- delete task

Drag/drop/reorder can be deferred if explicit position append is enough.

## Agent participation model

The current `buildGoalSystemPrompt` points pi at `goals/<slug>/goal.md`. Replace it with DB state plus explicit mutation instructions.

### Prompt contents

For goal-bound sessions, append once per session:

- active goal id, title, description
- current task tree with task ids
- instruction to keep tasks current via a command/API, not by editing files

For goalless sessions, keep the nudge to create/attach a goal for substantial work.

### Agent mutation interface

Add a small CLI surface so pi can update DB state from shell tools without knowing internal RPC details. Prefer a local command routed through the same orchestration engine rather than ad hoc SQLite writes.

Suggested commands:

```bash
t3 goal list [--project <cwd-or-id>]
t3 goal show <goal-id-or-slug>
t3 goal create --project <cwd-or-id> --slug <slug> --title <title> [--description <text>]
t3 goal update <goal-id> [--title <title>] [--description <text>]
t3 goal task add <goal-id> <text> [--parent <task-id>]
t3 goal task done <goal-id> <task-id>
t3 goal task open <goal-id> <task-id>
t3 goal task rename <goal-id> <task-id> <text>
t3 goal task delete <goal-id> <task-id>
```

Implementation should reuse the existing project CLI/running-server routing patterns in `apps/server/src/bin.ts` rather than inventing a separate DB writer, but budget for a generalized or parallel dispatch path: the current project CLI helper is restricted to project commands. Goal commands need their own command union/handler and must dispatch through the same orchestration engine.

The goal CLI must prefer the live running server when present so task changes reach the active process, projections, and shell stream immediately. Offline direct-SQL/orchestration fallback is acceptable only when no live server is available; it must not silently bypass a responsive dogfood server.

The prompt can include the exact command prefix available in this repo/dev mode. If the packaged binary name is not stable during dogfood, use the command that works under `pnpm` and document it in the prompt builder.

## File-centric code deletion

Delete or fully retire:

- `apps/server/src/goal/GoalPackage.ts`
- `apps/server/src/goal/GoalsService.ts`
- file-backed `GET /api/goals` / `POST /api/goals` route code in `apps/server/src/goal/http.ts`
- relocate `GET /api/goals/diff` before deleting the old goal HTTP module; this route is generic diff functionality and must survive
- `GoalsServiceLive` wiring/mocks in server runtime, `ProviderCommandReactor`, server tests, reactor tests, and integration harness layers
- goal file watcher / WS-push plan if not implemented
- `apps/web/src/goals/goalIndex.tsx`
- file fields: `worktreePath`, `branch`, `packagePath` on goal index entries only — thread `worktreePath` and `branch` are still load-bearing execution-context fields and must survive
- system-prompt text instructing agents to read/update `goals/<slug>/goal.md`
- goal creation code that writes `goal.md`

Keep `goals/pi-frontend/goal.md` only as a planning artifact until the migration lands. After cutover, either delete it or convert it to a non-authoritative doc with a clear warning.

## Migration sequence

### Phase 0 — Lock the contract

1. Update this plan if any scope changes.
2. Decide whether local dogfood data will be reset or imported once.
3. If importing, write the current `goals/pi-frontend/goal.md` content down as an expected seed, then delete the importer after use.

### Phase 1 — Contracts and in-memory orchestration

1. Add `GoalId` / `GoalTaskId`.
2. Add goal/task read-model schemas.
3. Add goal/task commands and events.
4. Add `goal` aggregate kind.
5. Replace thread `goalSlug` with `goalId` in contracts.
6. Implement decider cases and invariants.
7. Implement in-memory projector cases.
8. Update contract and projector tests/fixtures.

Validation: focused contract/projector tests and `vp run typecheck`.

### Phase 2 — SQL projections

1. Add projection tables and `projection_threads.goal_id`.
2. Add projection services/layers.
3. Add goal/task projectors to `ProjectionPipeline`.
4. Add goals/tasks to `ProjectionSnapshotQuery` shell/detail snapshots.
5. Wire layers into `OrchestrationProjectionPipelineLive`.

Validation: projection repository/pipeline tests; bootstrap a temp base-dir and inspect shell snapshot.

### Phase 3 — Server API/WS/store integration

1. Add goal events to shell stream.
2. Relocate the existing diff route (`GET /api/goals/diff`) to a non-goal HTTP module and update `DiffPanel` before removing the old goal HTTP module.
3. Remove `GoalsServiceLive` and file-backed goal HTTP routes from server runtime.
4. Update WS/client runtime contracts only if shell stream contract needs explicit additions.
5. Update web store application of goal shell events.
6. Update/remove `GoalsService` layer wiring and mocks in server runtime, `ProviderCommandReactor`, server tests, reactor tests, and integration harness layers.

Validation: server boots, shell snapshot contains goals, shell stream updates after dispatched goal commands, and the diff panel still loads a HEAD diff.

### Phase 4 — Web UI cutover

1. Replace `goalSlug` state with `goalId` across drafts, threads, sidebar summaries, client-runtime reducers/state, mobile shared-runtime consumers, and fixtures.
2. Replace React Query goal index with store selectors.
3. Update sidebar grouping by `goalId`.
4. Update goal overview/header/tasks panel.
5. Update create/assign/clear/new-session actions to dispatch goal/thread commands.
6. Add minimal task mutation UI.

Validation: create goal, create session under goal, assign/clear thread, add/toggle task, restart server and confirm state persists without file reads.

### Phase 5 — Agent update interface

1. Add `t3 goal ...` CLI commands routed through orchestration dispatch.
2. Update `ProviderCommandReactor.buildGoalSystemPrompt` to include DB goal/task state and CLI instructions.
3. Remove all file-path goal instructions.
4. Dogfood: ask pi to complete a real task and confirm it updates DB tasks through the command.

Validation: real pi-backed thread updates tasks; restart server and confirm task state persists.

### Phase 6 — Delete file-centric remnants

1. Delete goal scanner/service/http/client files.
2. Remove tests for file discovery/polling.
3. Delete or rewrite docs/progress references that describe file-centric goals as current behavior.
4. Remove the now-obsolete goal-index WS-push plan from the active backlog, or mark it superseded.

Validation: `rg "goalSlug|GoalPackage|GoalsService|/api/goals|goal.md|packagePath|worktreePath.*goal"` should find only historical docs or deliberately retained planning notes.

### Phase 7 — Final verification

Required before done:

- `vp check`
- `vp run typecheck`
- `vp run lint:mobile` if any native mobile/shared mobile-facing files change
- canonical dev run against real state (`pnpm dev` or documented app entrypoint)
- browser/dogfood verification:
  - one project row
  - one goal row despite multiple git worktrees
  - goal-bound thread can run in either root checkout or worktree
  - task updates persist through restart
  - pi receives active goal context and can update tasks via the new command

## Key risks

- **Blast radius:** `goalSlug` touches contracts, server projections, web store, client-runtime reducers, mobile/shared fixtures, drafts, sidebar, chat header, task panel, layer wiring, and tests. Do not half-migrate.
- **Agent ergonomics regression:** DB tasks are harder for pi than Markdown unless the CLI/API is simple and included in the system prompt.
- **Shell stream payload growth:** nested tasks in shell snapshots are fine at personal scale, but keep task objects compact.
- **Event granularity:** avoid storing the whole task tree in one event on every checkbox toggle; task-level events keep history understandable and projections simple.
- **Docs drift:** current progress/docs strongly say file-centric. Mark them superseded during the migration so future agents do not revive file scanning.

## Recommended implementation strategy

Use one writer branch/worktree and migrate vertically, not as scattered fixes:

1. Contracts + decider + in-memory projector until tests/typecheck expose every `goalSlug` consumer.
2. SQL projections and snapshot query.
3. Web store/UI.
4. Agent CLI/prompt.
5. Delete old file-centric code.

Avoid adding compatibility adapters. If an old consumer breaks because it expects a `slug`-only goal index, update or delete that consumer.
