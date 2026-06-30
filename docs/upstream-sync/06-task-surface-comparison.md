---
manager_sessions:
  - id: 5e7dc34d-c637-452c-8e98-b5a80411b983
    role: analysis
    authored_at: 2026-06-30T04:45:32.914Z
---

# Upstream sync — "task"/"plan" surface vs our goal/task model

_Phase 1 follow-up. Analysis only; no source changed. Australian English._
_Evidence is `git show`/`git grep` against `upstream/main` (`244821236`, v0.0.28),
our `HEAD`, and baseline `477795697`, verified live in this worktree._

## Verdict — DIFFERENT concept, and "plan" is shared heritage (no rename needed)

Upstream's "plan" and "task" surfaces are **not** working toward the same
objective as our goal/task model. They are a **different concept that merely
shares the word "task"** — there is no durable, human-facing decomposition of an
objective into a tracked task tree anywhere upstream.

Two further facts collapse the supposed collision flagged in `04-conflict-surface.md`:

1. **The "plan" surface is common ancestry, not a new upstream feature.**
   `OrchestrationProposedPlan` (the contract) and `apps/web/src/components/PlanSidebar.tsx`
   (the UI) exist at **baseline `477795697`, our `HEAD`, AND `upstream/main`**.
   It is the agent's _plan-mode proposal_, inherited by both sides from the common
   baseline. Upstream refined where it renders (inline right panel, #3118); we kept
   it too. There is nothing to rename and nothing to reconcile conceptually — it is
   literally the same entity on both sides.
2. **Our goal/task surface is already namespace-disjoint from upstream's "task" uses.**
   Ours is consistently `Goal`-prefixed (`OrchestrationGoalTask`, `GoalTaskId`,
   `goalTask*` commands, `GoalTasksPanel.tsx`, `goal_task_add` MCP). Upstream's
   "task" tokens are bare and live in unrelated domains. They do not clash as
   symbols; the overlap is only the English word and a sliver of right-panel real
   estate that **our HEAD already shares cleanly** (we run `PlanSidebar` _and_
   `GoalTasksPanel` side by side today).

**Recommendation: do NOT rename our side. Converge on the shared `plan`
(ProposedPlan) surface as-is, keep our `Goal*` task surface unchanged, and treat
the remainder as a few UI-wording/auto-open touch-ups during the web merge.**
Concrete collision candidates are listed at the end — they are small and mostly
cosmetic.

---

## What upstream's surfaces actually are

Upstream uses the words "plan" and "task" for **three distinct agent-runtime / UI
affordances**, none of which is objective-decomposition tracking:

### 1. "Plan" = the agent's ProposedPlan (plan mode) — shared with us

- **Contract** (`packages/contracts/src/orchestration.ts`):
  `OrchestrationProposedPlan { id, turnId, planMarkdown, implementedAt,
implementationThreadId, createdAt, updatedAt }`. The body is a single opaque
  **`planMarkdown` blob** — not a structured list of tracked items.
- **Origin = the model.** `apps/server/.../ProviderRuntimeIngestion.ts` turns an
  agent runtime event into the plan; the agent runs in `interactionMode: "plan"`
  (`ClaudeAdapter` maps this straight to the Claude SDK's `"plan"` permission
  mode, line ~3675). The server then issues `thread.proposed-plan.upsert`
  (`ThreadProposedPlanUpsertCommand`). The user does **not** author it; the model
  emits it.
- **Scope = per-thread / per-turn.** Persisted in `projection_thread_proposed_plans`
  keyed `(plan_id, thread_id, turn_id)` (migration 013); the read model attaches
  `proposedPlans` to a single `OrchestrationThread`.
- **Purpose = review-then-launch.** `proposedPlan.ts` is all presentation/launch
  helpers: title extraction, collapsed preview, **"PLEASE IMPLEMENT THIS PLAN: …"**
  (`buildPlanImplementationPrompt`), download-as-markdown, and
  `implementationThreadId` linking the plan to the _new thread_ spawned to execute
  it. It is a plan-mode artefact you read, optionally tweak, and hand back to an
  agent — a per-conversation deliverable, not a living tracker.

### 2. "Task" (web) = GFM markdown checkbox toggles — pure rendering

- `ChatMarkdown.tsx` renders `- [ ]` / `- [x]` list items as interactive
  checkboxes (`onTaskListChange`, `findTaskListMarkerOffset`, `aria-label="Toggle
task"`); `files/FilePreviewPanel.tsx` + `filePreviewMode.setMarkdownTaskChecked`
  let you tick a checkbox inside a previewed markdown file and write it back. This
  is the "file preview comments and task toggles" work (#3115). It is a **markdown
  editing affordance** — no entity, no persistence, no objective. Pure UI.

### 3. "Task" (agent activity + mobile) = a turn's work unit

- The agent runtime emits `task.started` / `task.progress` events with a
  `taskType` (e.g. `"plan"`), surfaced as **activity-feed entries** for the current
  turn (`ProviderRuntimeIngestion.ts` ~451). This is the model's own in-flight
  TODO/step chatter, scoped to a turn — ephemeral status, not a managed list.
- Mobile `NewTaskDraftScreen` / `new-task-flow-provider` use "task" colloquially to
  mean **"a new agent thread/job"** (model + composer draft + workspace picker to
  start a session). "New task" = "start a new conversation", unrelated to a task
  tree.

> Note: the drift doc's phrase "task sidebar" was loose wording. There is **no**
> `TaskSidebar` component upstream. The only sidebar is `PlanSidebar` (the shared
> ProposedPlan), and `autoOpenPlanSidebar` controls _that_ — not any task list.

---

## Our goal/task model (for contrast)

- **Contract** (`packages/contracts/src/orchestration.ts`): `OrchestrationGoal
{ id, projectId, slug, title, description, tasks[…] }` with a recursively nested
  `OrchestrationGoalTask { id, goalId, parentTaskId, text, done, position,
children[] }`. A goal is **project-scoped and durable**; it lives in the
  `OrchestrationReadModel.goals[]` array alongside threads, not inside any thread.
- **Origin = humans _and_ agents, deliberately.** Authored via the command
  surface (`GoalCreateCommand`, `GoalTaskCreate/Update/DeleteCommand`) and the MCP
  tools (`goal_task_add`, `goal_task_update`, `goal_handoff` in
  `apps/server/src/mcp/GoalTaskHttp.ts`). The orchestrator keeps the tree current;
  children may tick their own task. It is edited content, not model exhaust.
- **Scope = the whole objective, across sessions and threads.** One goal is the
  north star many threads work under; `goalTaskTree.ts` flattens/rebuilds the
  nested tree as it mutates. It outlives any single thread or turn.
- **Purpose = orchestration + re-orientation.** The living shared record of what is
  done and what remains, tied to Workstream sub-thread delegation — exactly the
  "durable, human-facing decomposition that drives orchestration" the question
  asks about.

---

## Side-by-side

| Axis         | Upstream "plan" (ProposedPlan)             | Upstream "task" (md toggle / activity / mobile) | **Our Goal + GoalTask**                          |
| ------------ | ------------------------------------------ | ----------------------------------------------- | ------------------------------------------------ |
| What it is   | Agent's plan-mode proposal (markdown blob) | GFM checkbox UI / turn activity / "new thread"  | Durable objective → nested tracked task tree     |
| Authored by  | The model (plan mode)                      | n/a (rendering) / model / user-as-launcher      | Humans **and** agents (commands + MCP)           |
| Structure    | One `planMarkdown` string                  | A checkbox / an event / a draft                 | Recursive `parentTaskId` tree, `done`/`position` |
| Scope        | Per-thread, per-turn                       | Per-render / per-turn / per-new-thread          | Per-objective, spans threads & sessions          |
| Lifetime     | A turn's deliverable                       | Ephemeral                                       | Persists for the life of the goal                |
| Drives       | "Implement plan" → spawn one thread        | Nothing durable                                 | Workstream delegation & re-orientation           |
| Status today | **Present on both** (baseline-shared)      | Upstream-only, refined in-window                | **Fork-only** (no upstream competitor)           |

---

## Rename vs converge — recommendation & concrete keys

**Converge, don't rename.** The two products are complementary, not competing, and
already coexist in our HEAD. Specifically:

- **`plan` / ProposedPlan / `PlanSidebar` / `autoOpenPlanSidebar`** → **adopt
  upstream as-is.** Same entity on both sides; take upstream's refinements during
  the `settings.ts` (Z5) and `ChatView`/right-panel (Z11/Z14) merges. No rename.
- **`Goal*` task surface** → **keep ours unchanged.** No symbol collides:
  upstream has no `GoalTask`, `GoalTaskId`, `goalTask*`, `GoalTasksPanel`, or
  `goal_task_*` MCP route. Our naming is already disjoint.

The only things to actually watch during the merge — all small:

1. **Right-panel real estate & auto-open**, not symbols. We auto-open the plan
   sidebar (`settings.autoOpenPlanSidebar`) _and_ the goal panel
   (`autoOpenedTasksByThreadKey` ref in `ChatView.tsx`). Upstream rewrote
   `ChatView.tsx`/right-panel heavily; re-attach **both** auto-open behaviours and
   make sure they don't fight for the same panel slot. This is a Z11/Z14 re-apply,
   not a contract change.
2. **`autoOpenPlanSidebar` default flip** (`true`→`false`, #2421). Decide our
   preferred default when re-applying `settings.ts`; it concerns the _plan_ sidebar
   only, so it does not touch the goal panel.
3. **UI wording only.** Upstream surfaces "task" in markdown ("Toggle task") and
   mobile ("New task"). To avoid _human_ confusion, keep our panel labelled with
   the goal framing (e.g. "Goal tasks" / "Goals & tasks"), not a bare "Tasks". No
   code rename required — purely a label choice.

Net effect on the strategy: the `04-conflict-surface.md` "biggest risk #6
(plan/task naming collision)" should be **downgraded from a namespace conflict to
a couple of UI-wording/auto-open touch-ups**. There is no contract-level clash to
adjudicate, and no rename of our side is warranted.
